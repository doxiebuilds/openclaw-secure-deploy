/**
 * Persistent, device-paired WebSocket connector — the hot path for every
 * Gateway RPC.
 *
 * Replaces DockerExecConnector, which spawned `docker exec <container> openclaw
 * gateway call` per RPC. That cost 1.9–8.8s wall clock for work the gateway
 * itself logged as 50–320ms: the entire remainder was CLI boot plus a fresh
 * WebSocket handshake, torn down again after a single call. Concurrency made it
 * worse rather than better (two parallel calls measured 5.2–10.7s), so every
 * page load and every sent message queued behind the fleet sweep.
 *
 * Here the handshake is paid once per gateway and amortised across every
 * subsequent call, and the same socket carries gateway events, which is what
 * lets the control plane stop polling entirely.
 *
 * Security posture: this is strictly *less* privilege than the connector it
 * replaces. `docker exec` grants arbitrary command execution inside each
 * container; this holds a scoped operator session authenticated by an Ed25519
 * key that an operator explicitly paired. Tokens and key material are never
 * logged, and an unpaired identity fails closed with PAIRING_REQUIRED.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FleetGateway } from '@ocp/domain';
import {
  CLIENT_ID,
  CLIENT_MODE,
  CLIENT_ROLE,
  CLIENT_SCOPES,
  type DeviceIdentity,
  loadOrCreateIdentity,
  publicKeyB64u,
  signConnect,
} from './device-identity.js';
import { GatewayNotFoundError, getGatewayOrThrow, loadFleet } from './fleet.js';
import { GatewayCallError } from './connector.js';
import type { GatewayCallFailure, GatewayCallResult, GatewayConnector } from './connector.js';

export type GatewayEvent = {
  gatewayId: string;
  event: string;
  payload: unknown;
  receivedAt: string;
};

export type GatewayLinkState = 'idle' | 'connecting' | 'ready' | 'unpaired' | 'failed';

export type GatewayLinkStatus = {
  gatewayId: string;
  state: GatewayLinkState;
  scopes: string[];
  since: string | null;
  lastError: string | null;
  reconnects: number;
  /** Set when the gateway refused the identity; requires operator pairing. */
  pairingRequestId: string | null;
};

export type PersistentConnectorOptions = {
  fleetPath?: string;
  /** Directory holding per-gateway `*-secrets.json`. */
  secretsDir?: string;
  /** Path to the control plane's device keypair (created on first use, 0600). */
  identityPath: string;
  /** Per-request timeout. */
  timeoutMs?: number;
  onCall?: (result: GatewayCallResult | GatewayCallFailure) => void;
  onEvent?: (event: GatewayEvent) => void;
  onStateChange?: (status: GatewayLinkStatus) => void;
  logger?: (message: string) => void;
  /**
   * Socket factory. Defaults to the global WebSocket; overridden in tests so
   * reconnect, backoff and multiplexing can be exercised without a live fleet.
   */
  createSocket?: (url: string) => WebSocket;
};

type WireResponse = {
  type: 'res';
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: unknown;
};

type WireEvent = {
  type: 'event';
  event: string;
  payload?: unknown;
};

const CONNECT_TIMEOUT_MS = 15_000;
const CHALLENGE_TIMEOUT_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 20_000;

/** Reconnect backoff. Jittered so three gateways never retry in lockstep. */
const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/**
 * Floor for retrying a gateway that refused our identity.
 *
 * Every connect attempt against an unpaired gateway *creates a pairing request*
 * in that gateway's pending.json. Retrying on the normal backoff would fill it
 * with hundreds of identical requests, so an unpaired link waits for a human
 * either way.
 */
const UNPAIRED_RETRY_MS = 60_000;

function backoffFor(attempt: number): number {
  const exponential = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

function errorText(err: unknown): string {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  const rec = err as Record<string, unknown>;
  if (typeof rec.message === 'string') return rec.message;
  return JSON.stringify(err).slice(0, 300);
}

/** One long-lived connection to one gateway. */
class GatewayLink {
  private ws: WebSocket | null = null;
  private state: GatewayLinkState = 'idle';
  private scopes: string[] = [];
  private since: string | null = null;
  private lastError: string | null = null;
  private pairingRequestId: string | null = null;
  private reconnects = 0;
  private attempt = 0;
  /** Earliest time a new dial is allowed; gates scheduled and on-demand alike. */
  private nextAttemptAtMs = 0;

  /** Resolves when the handshake completes; recreated on every disconnect. */
  private readyPromise: Promise<void> | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private seq = 0;

  private readonly pending = new Map<
    string,
    { resolve: (payload: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();

  constructor(
    private readonly gateway: FleetGateway,
    private readonly identity: DeviceIdentity,
    private readonly token: string,
    private readonly options: Required<Pick<PersistentConnectorOptions, 'timeoutMs'>> &
      Pick<PersistentConnectorOptions, 'onEvent' | 'onStateChange' | 'logger' | 'createSocket'>
  ) {}

  status(): GatewayLinkStatus {
    return {
      gatewayId: this.gateway.id,
      state: this.state,
      scopes: this.scopes,
      since: this.since,
      lastError: this.lastError,
      reconnects: this.reconnects,
      pairingRequestId: this.pairingRequestId,
    };
  }

  private setState(next: GatewayLinkState, error?: string | null): void {
    const changed = this.state !== next;
    this.state = next;
    if (error !== undefined) this.lastError = error;
    if (next === 'ready') this.since = new Date().toISOString();
    if (changed) this.options.onStateChange?.(this.status());
  }

  /**
   * Connect if needed and resolve once the handshake is done.
   *
   * Concurrent callers share one in-flight connect: the whole point is that a
   * burst of RPCs costs one handshake, not one per call.
   */
  ensureReady(): Promise<void> {
    if (this.closed) return Promise.reject(new Error('connector closed'));
    if (this.state === 'ready' && this.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.readyPromise) return this.readyPromise;

    // Respect the backoff window even for on-demand calls. Without this, a
    // fleet sweep's 18 RPCs each find no live socket and dial immediately,
    // turning a single unreachable gateway into a reconnect storm — and, when
    // the gateway is merely unpaired, into 18 fresh pairing requests.
    const now = Date.now();
    if (now < this.nextAttemptAtMs) {
      return Promise.reject(
        new Error(this.lastError ?? `gateway ${this.gateway.id} is not connected`)
      );
    }

    this.readyPromise = this.connect().catch((err) => {
      this.readyPromise = null;
      throw err;
    });
    return this.readyPromise;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.setState('connecting');
      const url = this.gateway.hostWsUrl;

      let ws: WebSocket;
      try {
        ws = this.options.createSocket ? this.options.createSocket(url) : new WebSocket(url);
      } catch (err) {
        this.setState('failed', errorText(err));
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.ws = ws;

      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(challengeTimer);
        if (err) reject(err);
        else resolve();
      };

      const hardTimer = setTimeout(
        () => {
          this.setState('failed', `handshake timed out after ${CONNECT_TIMEOUT_MS}ms`);
          try {
            ws.close();
          } catch {
            /* already gone */
          }
          finish(new Error(`handshake timed out after ${CONNECT_TIMEOUT_MS}ms`));
        },
        CONNECT_TIMEOUT_MS
      );

      // The gateway requires a signed nonce, so a missing challenge is fatal
      // rather than a fallback to an unsigned connect.
      const challengeTimer = setTimeout(() => {
        this.setState('failed', 'no connect.challenge received');
        try {
          ws.close();
        } catch {
          /* already gone */
        }
        finish(new Error('no connect.challenge received'));
      }, CHALLENGE_TIMEOUT_MS);

      ws.addEventListener('error', () => {
        // The 'close' handler does the reconnect bookkeeping; a WS error event
        // carries no useful detail in Node, so avoid double-handling here.
        if (!settled) this.lastError = 'websocket error';
      });

      ws.addEventListener('close', (ev) => {
        const reason = `socket closed (${ev.code})${ev.reason ? ` ${ev.reason}` : ''}`;
        this.handleDisconnect(reason);
        finish(new Error(reason));
      });

      ws.addEventListener('message', (ev) => {
        let msg: WireResponse | WireEvent | { type?: string; event?: string; payload?: unknown };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }

        if (msg.type === 'event' && msg.event === 'connect.challenge') {
          clearTimeout(challengeTimer);
          const payload = (msg.payload ?? {}) as { nonce?: string; challenge?: string };
          const nonce = payload.nonce ?? payload.challenge;
          if (!nonce) {
            finish(new Error('connect.challenge carried no nonce'));
            return;
          }
          this.sendConnect(ws, nonce);
          return;
        }

        if (msg.type === 'event') {
          this.options.onEvent?.({
            gatewayId: this.gateway.id,
            event: String(msg.event),
            payload: msg.payload ?? null,
            receivedAt: new Date().toISOString(),
          });
          return;
        }

        if (msg.type !== 'res') return;
        const res = msg as WireResponse;

        if (res.id === 'connect') {
          this.handleConnectResponse(res, finish);
          return;
        }

        const waiter = this.pending.get(res.id);
        if (!waiter) return;
        this.pending.delete(res.id);
        clearTimeout(waiter.timer);
        if (res.ok) waiter.resolve(res.payload ?? null);
        else waiter.reject(new Error(errorText(res.error)));
      });
    });
  }

  private sendConnect(ws: WebSocket, nonce: string): void {
    const signedAt = Date.now();
    ws.send(
      JSON.stringify({
        type: 'req',
        id: 'connect',
        method: 'connect',
        params: {
          minProtocol: 3,
          maxProtocol: 4,
          client: {
            id: CLIENT_ID,
            displayName: 'openclaw-control-plane',
            version: '1.0.0',
            platform: process.platform === 'darwin' ? 'macos' : process.platform,
            mode: CLIENT_MODE,
          },
          role: CLIENT_ROLE,
          scopes: [...CLIENT_SCOPES],
          // tool-events is what makes session.tool / session.message stream to
          // us; without it the UI would be back to polling for tool activity.
          caps: ['tool-events', 'exec-approvals', 'approvals'],
          auth: { token: this.token },
          device: {
            id: this.identity.deviceId,
            publicKey: publicKeyB64u(this.identity),
            signature: signConnect({
              identity: this.identity,
              token: this.token,
              nonce,
              signedAt,
            }),
            signedAt,
            nonce,
          },
          userAgent: 'openclaw-control-plane/1.0.0',
        },
      })
    );
  }

  private handleConnectResponse(res: WireResponse, finish: (err?: Error) => void): void {
    if (!res.ok) {
      const err = (res.error ?? {}) as Record<string, unknown>;
      const details = (err.details ?? {}) as Record<string, unknown>;
      const text = errorText(res.error);
      const unpaired =
        details.code === 'PAIRING_REQUIRED' || /pairing.?required/i.test(text);

      if (unpaired) {
        this.pairingRequestId = typeof details.requestId === 'string' ? details.requestId : null;
        // Fail closed and stay loud: pairing is a deliberate operator action,
        // never something this process should attempt on its own.
        this.setState(
          'unpaired',
          `device not paired with ${this.gateway.id}; run scripts/bootstrap/pair-control-plane.mjs`
        );
      } else {
        this.setState('failed', text);
      }
      finish(new Error(this.lastError ?? text));
      return;
    }

    const payload = (res.payload ?? {}) as {
      auth?: { scopes?: string[]; role?: string };
    };
    this.scopes = payload.auth?.scopes ?? [];
    this.pairingRequestId = null;
    this.attempt = 0;
    this.nextAttemptAtMs = 0;

    if (this.scopes.length === 0) {
      this.setState('failed', 'connected but no scopes granted');
      finish(new Error('connected but no scopes granted'));
      return;
    }

    this.setState('ready', null);
    this.options.logger?.(
      `[gateway] ${this.gateway.id} connected (scopes: ${this.scopes.join(',')})`
    );
    finish();
  }

  private handleDisconnect(reason: string): void {
    this.readyPromise = null;
    this.ws = null;

    // In-flight requests cannot be retried blindly: chat.send is not safe to
    // replay without knowing whether the gateway already accepted it. Reject
    // and let the caller decide.
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`gateway connection lost: ${reason}`));
    }
    this.pending.clear();

    if (this.closed) return;
    if (this.state !== 'unpaired') this.setState('idle', reason);

    this.scheduleReconnect();
  }

  /**
   * Reconnect eagerly rather than on next use: the socket is also the event
   * feed, so a link that only healed on demand would silently stop delivering
   * updates until someone happened to make a call.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    this.attempt += 1;
    const delay =
      this.state === 'unpaired' ? UNPAIRED_RETRY_MS : backoffFor(this.attempt);
    this.nextAttemptAtMs = Date.now() + delay;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closed) return;
      this.reconnects += 1;
      this.ensureReady().catch((err) => {
        this.options.logger?.(
          `[gateway] ${this.gateway.id} reconnect failed: ${errorText(err)}`
        );
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async call<T>(method: string, params: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureReady();
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`gateway ${this.gateway.id} is not connected`);
    }

    const id = `cp-${++this.seq}`;
    const limit = timeoutMs ?? this.options.timeoutMs;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // A timed-out request means the socket may be half-open (the TCP
        // connection survives but the peer is gone). Cycle it so the next call
        // gets a healthy link instead of timing out too.
        this.recycle(`request ${method} timed out after ${limit}ms`);
        reject(new Error(`request ${method} timed out after ${limit}ms`));
      }, limit);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timer,
      });

      try {
        ws.send(JSON.stringify({ type: 'req', id, method, params: params ?? {} }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Force a reconnect; used when the link looks alive but is not responding. */
  private recycle(reason: string): void {
    const ws = this.ws;
    if (!ws) return;
    this.options.logger?.(`[gateway] ${this.gateway.id} recycling link: ${reason}`);
    try {
      ws.close();
    } catch {
      /* the close handler still runs reconnect bookkeeping */
    }
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('connector closed'));
    }
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = null;
  }
}

export class PersistentGatewayConnector implements GatewayConnector {
  private readonly links = new Map<string, GatewayLink>();
  private readonly identity: DeviceIdentity;
  private readonly secretsDir: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: PersistentConnectorOptions) {
    this.identity = loadOrCreateIdentity(options.identityPath);
    this.secretsDir = options.secretsDir ?? join(homedir(), '.openclaw-secrets');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get deviceId(): string {
    return this.identity.deviceId;
  }

  listGateways(): FleetGateway[] {
    return loadFleet(this.options.fleetPath).gateways;
  }

  getGateway(id: string): FleetGateway {
    return getGatewayOrThrow(loadFleet(this.options.fleetPath), id);
  }

  /** Per-gateway link health, for /api/health and the fleet view. */
  linkStatuses(): GatewayLinkStatus[] {
    return this.listGateways().map(
      (gw) =>
        this.links.get(gw.id)?.status() ?? {
          gatewayId: gw.id,
          state: 'idle' as const,
          scopes: [],
          since: null,
          lastError: null,
          reconnects: 0,
          pairingRequestId: null,
        }
    );
  }

  /** Open every link up front so the first user request is never the one paying. */
  async start(): Promise<void> {
    await Promise.all(
      this.listGateways().map((gw) =>
        this.linkFor(gw.id)
          .ensureReady()
          .catch((err) => {
            this.options.logger?.(
              `[gateway] ${gw.id} initial connect failed: ${errorText(err)}`
            );
          })
      )
    );
  }

  private tokenFor(gw: FleetGateway): string {
    const path = join(this.secretsDir, gw.secretsFile);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const gateway = parsed.gateway as { authToken?: string } | undefined;
    const token = gateway?.authToken ?? (parsed['gateway/authToken'] as string | undefined);
    if (!token) throw new Error(`no gateway.authToken in ${gw.secretsFile}`);
    return token;
  }

  private linkFor(gatewayId: string): GatewayLink {
    const existing = this.links.get(gatewayId);
    if (existing) return existing;

    const gw = this.getGateway(gatewayId);
    const link = new GatewayLink(gw, this.identity, this.tokenFor(gw), {
      timeoutMs: this.timeoutMs,
      onEvent: this.options.onEvent,
      onStateChange: this.options.onStateChange,
      logger: this.options.logger,
      createSocket: this.options.createSocket,
    });
    this.links.set(gatewayId, link);
    return link;
  }

  async call<T = unknown>(gatewayId: string, method: string, params: unknown = {}): Promise<T> {
    const started = Date.now();
    try {
      const data = await this.linkFor(gatewayId).call<T>(method, params);
      this.options.onCall?.({
        gatewayId,
        method,
        ok: true,
        data,
        durationMs: Date.now() - started,
      });
      return data;
    } catch (err) {
      this.options.onCall?.({
        gatewayId,
        method,
        ok: false,
        error: errorText(err),
        exitCode: null,
        stderr: '',
        durationMs: Date.now() - started,
      });
      // Same error type the docker-exec connector threw, so callers and the
      // HTTP error mapping keep working unchanged.
      throw new GatewayCallError(gatewayId, method, null, errorText(err));
    }
  }

  async tryCall<T = unknown>(
    gatewayId: string,
    method: string,
    params: unknown = {}
  ): Promise<GatewayCallResult<T> | GatewayCallFailure> {
    const started = Date.now();
    try {
      const data = await this.linkFor(gatewayId).call<T>(method, params);
      const result: GatewayCallResult<T> = {
        gatewayId,
        method,
        ok: true,
        data,
        durationMs: Date.now() - started,
      };
      this.options.onCall?.(result);
      return result;
    } catch (err) {
      const failure: GatewayCallFailure = {
        gatewayId,
        method,
        ok: false,
        error: err instanceof GatewayNotFoundError ? err.message : errorText(err),
        exitCode: null,
        stderr: '',
        durationMs: Date.now() - started,
      };
      this.options.onCall?.(failure);
      return failure;
    }
  }

  close(): void {
    for (const [, link] of this.links) link.close();
    this.links.clear();
  }
}
