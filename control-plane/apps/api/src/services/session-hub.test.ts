import { describe, expect, it, vi } from 'vitest';
import type { GatewayEvent } from '@ocp/gateway-client';
import { SessionHub } from './session-hub.js';
import type { SessionService } from './session-service.js';

type Detail = Awaited<ReturnType<SessionService['getDetail']>>;

/** A SessionService whose reads we can count, delay, and vary. */
function fakeSessions(opts: { delayMs?: number } = {}) {
  let reads = 0;
  const service = {
    async getDetail(gatewayId: string, sessionKey: string, limit: number) {
      reads += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      return {
        gatewayId,
        sessionKey,
        history: { messages: [{ role: 'user', content: `read-${reads}` }] },
        timeline: [],
        describe: null,
        historyError: null,
        describeError: null,
        projectedAt: new Date().toISOString(),
        limit,
      } as unknown as Detail;
    },
  };
  return { service: service as unknown as SessionService, reads: () => reads };
}

function event(gatewayId: string, name: string, payload: unknown): GatewayEvent {
  return { gatewayId, event: name, payload, receivedAt: new Date().toISOString() };
}

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SessionHub', () => {
  it('serves a warm session from cache without re-reading the gateway', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { staleAfterMs: 60_000 });

    await hub.getDetail('main', 's1', 80);
    expect(reads()).toBe(1);

    for (let i = 0; i < 5; i += 1) await hub.getDetail('main', 's1', 80);
    expect(reads()).toBe(1);
    hub.stop();
  });

  it('coalesces concurrent readers of one session into a single read', async () => {
    const { service, reads } = fakeSessions({ delayMs: 20 });
    const hub = new SessionHub(service);

    await Promise.all(Array.from({ length: 8 }, () => hub.getDetail('main', 's1', 80)));

    expect(reads()).toBe(1);
    hub.stop();
  });

  it('re-reads and pushes to subscribers when the gateway reports a change', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 5, staleAfterMs: 60_000 });
    const seen: Detail[] = [];

    hub.subscribe('main', 's1', 80, (d) => seen.push(d));
    await tick(20);
    expect(reads()).toBe(1);

    hub.handleEvent(event('main', 'session.message', { sessionKey: 's1' }));
    await tick(40);

    expect(reads()).toBe(2);
    expect(seen).toHaveLength(2);
    hub.stop();
  });

  it('batches a burst of events into one re-read', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 20, staleAfterMs: 60_000 });

    hub.subscribe('main', 's1', 80, () => {});
    await tick(10);
    const before = reads();

    // A run start emits several events back to back.
    for (let i = 0; i < 10; i += 1) {
      hub.handleEvent(event('main', 'session.tool', { sessionKey: 's1' }));
    }
    await tick(60);

    expect(reads()).toBe(before + 1);
    hub.stop();
  });

  it('ignores events for sessions nobody is watching', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 5 });

    hub.handleEvent(event('main', 'session.message', { sessionKey: 'never-opened' }));
    await tick(30);

    expect(reads()).toBe(0);
    hub.stop();
  });

  it('refreshes live sessions when an event carries no session key', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 5, staleAfterMs: 60_000 });

    hub.subscribe('main', 's1', 80, () => {});
    await tick(15);
    const before = reads();

    // A renamed or missing payload field must not silently stall the transcript.
    hub.handleEvent(event('main', 'session.message', { somethingElse: true }));
    await tick(40);

    expect(reads()).toBe(before + 1);
    hub.stop();
  });

  it('does not fan an unattributable event out to another gateway', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 5, staleAfterMs: 60_000 });

    hub.subscribe('main', 's1', 80, () => {});
    await tick(15);
    const before = reads();

    hub.handleEvent(event('scout', 'session.message', {}));
    await tick(40);

    expect(reads()).toBe(before);
    hub.stop();
  });

  it('ignores unrelated gateway events', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { eventDebounceMs: 5, staleAfterMs: 60_000 });

    hub.subscribe('main', 's1', 80, () => {});
    await tick(15);
    const before = reads();

    hub.handleEvent(event('main', 'presence', { sessionKey: 's1' }));
    hub.handleEvent(event('main', 'health', {}));
    await tick(30);

    expect(reads()).toBe(before);
    hub.stop();
  });

  it('re-reads after an in-flight fetch when a change lands mid-read', async () => {
    const { service, reads } = fakeSessions({ delayMs: 30 });
    const hub = new SessionHub(service, { eventDebounceMs: 5, staleAfterMs: 60_000 });

    const first = hub.getDetail('main', 's1', 80);
    // Arrives while the first read is still open, so that read may be stale.
    hub.handleEvent(event('main', 'session.message', { sessionKey: 's1' }));
    await first;
    await tick(60);

    expect(reads()).toBe(2);
    hub.stop();
  });

  it('drops a session once its last subscriber leaves', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { idleEvictMs: 10, staleAfterMs: 60_000 });

    const unsubscribe = hub.subscribe('main', 's1', 80, () => {});
    await tick(10);
    expect(reads()).toBe(1);

    unsubscribe();
    await tick(40);

    // Cache evicted, so the next read goes back to the gateway.
    await hub.getDetail('main', 's1', 80);
    expect(reads()).toBe(2);
    hub.stop();
  });

  it('honours waitForFresh even when the cache is warm', async () => {
    const { service, reads } = fakeSessions();
    const hub = new SessionHub(service, { staleAfterMs: 60_000 });

    await hub.getDetail('main', 's1', 80);
    await hub.getDetail('main', 's1', 80, { waitForFresh: true });

    expect(reads()).toBe(2);
    hub.stop();
  });

  it('widens the cached limit rather than answering from a shorter transcript', async () => {
    const { service } = fakeSessions();
    const hub = new SessionHub(service, { staleAfterMs: 60_000 });
    const spy = vi.spyOn(service, 'getDetail');

    await hub.getDetail('main', 's1', 20);
    await hub.getDetail('main', 's1', 200, { waitForFresh: true });

    expect(spy.mock.calls.at(-1)?.[2]).toBe(200);
    hub.stop();
  });
});
