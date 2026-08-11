import { mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PersistentGatewayConnector } from './persistent-connector.js';

/**
 * A scripted stand-in for a gateway socket.
 *
 * Speaks the real wire protocol (connect.challenge -> signed connect -> res),
 * so these tests exercise the connector's own framing and multiplexing rather
 * than a paraphrase of it.
 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0; // CONNECTING
  sent: Array<Record<string, unknown>> = [];
  private listeners = new Map<string, Set<(ev: unknown) => void>>();

  constructor(
    readonly url: string,
    private readonly behaviour: {
      /** How the fake answers `connect`. */
      connect: 'ok' | 'unpaired' | 'no-scopes';
      /** Answer RPCs automatically. */
      autoRespond?: boolean;
    }
  ) {
    FakeSocket.instances.push(this);
    // Open on a later turn, as a real socket would.
    queueMicrotask(() => this.open());
  }

  private open() {
    this.readyState = 1; // OPEN
    this.emit('open', {});
    this.deliver({ type: 'event', event: 'connect.challenge', payload: { nonce: 'nonce-1' } });
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }

  private emit(type: string, ev: unknown) {
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }

  /** Push a frame from server to client. */
  deliver(frame: unknown) {
    this.emit('message', { data: JSON.stringify(frame) });
  }

  send(raw: string) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    this.sent.push(frame);

    if (frame.method === 'connect') {
      if (this.behaviour.connect === 'unpaired') {
        this.deliver({
          type: 'res',
          id: 'connect',
          ok: false,
          error: { message: 'pairing required', details: { code: 'PAIRING_REQUIRED', requestId: 'req-1' } },
        });
        queueMicrotask(() => this.close(1008, 'pairing required'));
        return;
      }
      const scopes = this.behaviour.connect === 'no-scopes' ? [] : ['operator.admin'];
      this.deliver({ type: 'res', id: 'connect', ok: true, payload: { auth: { scopes } } });
      return;
    }

    if (this.behaviour.autoRespond) {
      this.deliver({ type: 'res', id: frame.id, ok: true, payload: { echoed: frame.method } });
    }
  }

  close(code = 1000, reason = '') {
    if (this.readyState === 3) return;
    this.readyState = 3; // CLOSED
    this.emit('close', { code, reason });
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let dir: string;
let identityPath: string;
let fleetPath: string;
let secretsDir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocp-connector-'));
  identityPath = join(dir, 'device-identity.json');
  secretsDir = join(dir, 'secrets');
  fleetPath = join(dir, 'fleet.json');

  writeFileSync(
    fleetPath,
    JSON.stringify({
      version: 1,
      gateways: [
        {
          id: 'main',
          container: 'openclaw',
          cell: 3,
          hostWsUrl: 'ws://127.0.0.1:18789',
          hostHttpBase: 'http://127.0.0.1:18789',
          healthzPath: '/healthz',
          uiForwardService: 'main-ui-forward',
          secretsFile: 'main-secrets.json',
          configDir: '',
          configFile: '',
          expectedAgents: [],
          role: '',
        },
      ],
    })
  );

  mkdirSync(secretsDir, { recursive: true });
  writeFileSync(
    join(secretsDir, 'main-secrets.json'),
    JSON.stringify({ gateway: { authToken: 'test-token-value' } })
  );
});

afterEach(() => {
  FakeSocket.instances = [];
});

function makeConnector(
  behaviour: { connect: 'ok' | 'unpaired' | 'no-scopes'; autoRespond?: boolean },
  extra: Record<string, unknown> = {}
) {
  return new PersistentGatewayConnector({
    fleetPath,
    identityPath,
    secretsDir,
    timeoutMs: 200,
    logger: () => {},
    createSocket: ((url: string) => new FakeSocket(url, behaviour) as unknown as WebSocket) as never,
    ...extra,
  });
}

describe('PersistentGatewayConnector', () => {
  it('creates a 0600 device identity on first use', async () => {
    const connector = makeConnector({ connect: 'ok' });
    expect(connector.deviceId).toMatch(/^[0-9a-f]{64}$/);

    expect(statSync(identityPath).mode & 0o777).toBe(0o600);
    connector.close();
  });

  it('signs the connect frame with the challenge nonce and never leaks the key', async () => {
    const connector = makeConnector({ connect: 'ok', autoRespond: true });
    await connector.call('main', 'sessions.list');

    const connect = FakeSocket.instances[0].sent.find((f) => f.method === 'connect');
    const params = connect?.params as Record<string, any>;
    expect(params.device.nonce).toBe('nonce-1');
    expect(params.device.signature).toEqual(expect.any(String));
    expect(params.auth.token).toBe('test-token-value');
    // The private key must never reach the wire.
    expect(JSON.stringify(connect)).not.toContain('PRIVATE KEY');
    connector.close();
  });

  it('pays the handshake once across many calls', async () => {
    const connector = makeConnector({ connect: 'ok', autoRespond: true });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) => connector.call('main', `method.${i}`))
    );

    // One socket, one connect frame — the entire point of the transport.
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].sent.filter((f) => f.method === 'connect')).toHaveLength(1);
    connector.close();
  });

  it('multiplexes concurrent requests and routes each response to its caller', async () => {
    const connector = makeConnector({ connect: 'ok' });
    const pending = [
      connector.call<{ echoed: string }>('main', 'a'),
      connector.call<{ echoed: string }>('main', 'b'),
      connector.call<{ echoed: string }>('main', 'c'),
    ];
    await tick(5);

    const socket = FakeSocket.instances[0];
    const rpcs = socket.sent.filter((f) => f.method !== 'connect');
    expect(rpcs).toHaveLength(3);

    // Answer out of order: correctness must not depend on arrival order.
    for (const frame of [...rpcs].reverse()) {
      socket.deliver({ type: 'res', id: frame.id, ok: true, payload: { echoed: frame.method } });
    }

    expect(await Promise.all(pending)).toEqual([
      { echoed: 'a' },
      { echoed: 'b' },
      { echoed: 'c' },
    ]);
    connector.close();
  });

  it('reports unpaired without escalating, and surfaces the pairing request id', async () => {
    const connector = makeConnector({ connect: 'unpaired' });
    await expect(connector.call('main', 'sessions.list')).rejects.toThrow(/not paired/i);

    const status = connector.linkStatuses()[0];
    expect(status.state).toBe('unpaired');
    expect(status.pairingRequestId).toBe('req-1');
    connector.close();
  });

  it('does not dial again per call while unpaired', async () => {
    const connector = makeConnector({ connect: 'unpaired' });

    // A fleet sweep's worth of calls against an unpaired gateway. Each dial
    // would create a fresh pairing request on the gateway.
    for (let i = 0; i < 18; i += 1) {
      await connector.tryCall('main', 'sessions.list');
    }
    await tick(20);

    expect(FakeSocket.instances).toHaveLength(1);
    connector.close();
  });

  it('rejects a connect that yields no scopes rather than reporting ready', async () => {
    const connector = makeConnector({ connect: 'no-scopes' });
    await expect(connector.call('main', 'sessions.list')).rejects.toThrow(/no scopes/i);
    expect(connector.linkStatuses()[0].state).toBe('failed');
    connector.close();
  });

  it('fails in-flight requests when the socket drops instead of replaying them', async () => {
    const connector = makeConnector({ connect: 'ok' });
    const inFlight = connector.call('main', 'chat.send');
    await tick(5);

    FakeSocket.instances[0].close(1006, 'connection lost');

    // Replaying chat.send could duplicate a message, so it must surface.
    await expect(inFlight).rejects.toThrow(/connection lost|not connected/i);
    connector.close();
  });

  it('surfaces gateway events with their originating gateway', async () => {
    const seen: Array<{ gatewayId: string; event: string }> = [];
    const connector = makeConnector(
      { connect: 'ok', autoRespond: true },
      { onEvent: (e: unknown) => seen.push(e as { gatewayId: string; event: string }) }
    );

    await connector.call('main', 'sessions.list');
    FakeSocket.instances[0].deliver({
      type: 'event',
      event: 'session.message',
      payload: { sessionKey: 's1' },
    });
    await tick(5);

    expect(seen).toContainEqual(expect.objectContaining({ gatewayId: 'main', event: 'session.message' }));
    // The handshake challenge is protocol plumbing, not a fleet event.
    expect(seen.map((e) => e.event)).not.toContain('connect.challenge');
    connector.close();
  });

  it('times out a silent request without wedging the link', async () => {
    const connector = makeConnector({ connect: 'ok' });
    await expect(connector.call('main', 'never.answers')).rejects.toThrow(/timed out/i);
    connector.close();
  });

  it('reports an unknown gateway as a failure rather than throwing', async () => {
    const connector = makeConnector({ connect: 'ok' });
    const res = await connector.tryCall('nope', 'sessions.list');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/unknown gateway/i);
    connector.close();
  });
});
