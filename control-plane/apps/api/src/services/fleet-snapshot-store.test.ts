import { describe, expect, it, vi } from 'vitest';
import type { FleetService, GatewayStatusDetail } from './fleet-service.js';
import { FleetSnapshotStore } from './fleet-snapshot-store.js';

function detail(gatewayId: string, over: Partial<GatewayStatusDetail> = {}): GatewayStatusDetail {
  return {
    status: { gatewayId } as GatewayStatusDetail['status'],
    agents: [],
    execApprovals: [],
    sessions: [],
    cronJobs: [],
    fetched: { agents: true, execApprovals: true, sessions: true, cronJobs: true },
    ...over,
  };
}

/** A FleetService whose sweep we can count and delay. */
function fakeFleet(opts: { delayMs?: number; fail?: boolean } = {}) {
  let sweeps = 0;
  const fleet = {
    async statusAllDetail(): Promise<GatewayStatusDetail[]> {
      sweeps += 1;
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      if (opts.fail) throw new Error('gateway unreachable');
      return [detail('main')];
    },
  };
  return { fleet: fleet as unknown as FleetService, sweeps: () => sweeps };
}

describe('FleetSnapshotStore', () => {
  it('coalesces concurrent readers into a single sweep', async () => {
    const { fleet, sweeps } = fakeFleet({ delayMs: 20 });
    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });

    // Ten simultaneous cold requests, as ten browser tabs would produce.
    const results = await Promise.all(Array.from({ length: 10 }, () => store.ready()));

    expect(sweeps()).toBe(1);
    expect(new Set(results).size).toBe(1);
    store.stop();
  });

  it('serves warm reads without sweeping again', async () => {
    const { fleet, sweeps } = fakeFleet();
    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });

    await store.ready();
    expect(sweeps()).toBe(1);

    for (let i = 0; i < 5; i += 1) await store.ready();
    expect(sweeps()).toBe(1);
    store.stop();
  });

  it('retains the last good details when a sweep fails', async () => {
    let fail = false;
    const fleet = {
      async statusAllDetail(): Promise<GatewayStatusDetail[]> {
        if (fail) throw new Error('gateway unreachable');
        return [detail('main')];
      },
    } as unknown as FleetService;

    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });
    const good = await store.ready();
    expect(good.details).toHaveLength(1);
    expect(good.error).toBeNull();

    fail = true;
    const bad = await store.refresh();
    expect(bad.error).toMatch(/unreachable/);
    // The UI keeps rendering the fleet rather than blanking out.
    expect(bad.details).toHaveLength(1);
    store.stop();
  });

  it('keeps known-good collections when a gateway stops answering RPCs', async () => {
    const agent = { gatewayId: 'main', id: 'main' } as GatewayStatusDetail['agents'][number];
    let healthy = true;
    const fleet = {
      async statusAllDetail(): Promise<GatewayStatusDetail[]> {
        return healthy
          ? [detail('main', { agents: [agent] })]
          : // A gateway that stops answering yields empty arrays, not an error.
            [
              detail('main', {
                agents: [],
                fetched: { agents: false, execApprovals: false, sessions: false, cronJobs: false },
              }),
            ];
      },
    } as unknown as FleetService;

    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });
    expect((await store.ready()).details[0].agents).toHaveLength(1);

    healthy = false;
    const degraded = await store.refresh();
    // The agent list must survive the blip rather than reading as "no agents".
    expect(degraded.details[0].agents).toHaveLength(1);

    healthy = true;
    expect((await store.refresh()).details[0].agents).toHaveLength(1);
    store.stop();
  });

  it('accepts a genuinely empty collection when the RPC succeeded', async () => {
    const agent = { gatewayId: 'main', id: 'main' } as GatewayStatusDetail['agents'][number];
    let agents = [agent];
    const fleet = {
      async statusAllDetail(): Promise<GatewayStatusDetail[]> {
        return [detail('main', { agents })];
      },
    } as unknown as FleetService;

    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });
    expect((await store.ready()).details[0].agents).toHaveLength(1);

    agents = []; // fetched: true — the gateway really has no agents now
    expect((await store.refresh()).details[0].agents).toHaveLength(0);
    store.stop();
  });

  it('notifies subscribers on each refresh and stops on unsubscribe', async () => {
    const { fleet } = fakeFleet();
    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });
    const seen = vi.fn();

    const unsubscribe = store.subscribe(seen);
    await store.ready();
    expect(seen).toHaveBeenCalledTimes(1);

    await store.refresh();
    expect(seen).toHaveBeenCalledTimes(2);

    unsubscribe();
    await store.refresh();
    expect(seen).toHaveBeenCalledTimes(2);
    store.stop();
  });

  it('does not let one broken subscriber stall the others', async () => {
    const { fleet } = fakeFleet();
    const store = new FleetSnapshotStore(fleet, { refreshIntervalMs: 60_000 });
    const healthy = vi.fn();

    store.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    store.subscribe(healthy);

    await store.ready();
    expect(healthy).toHaveBeenCalledTimes(1);
    store.stop();
  });

  describe('event-driven refresh', () => {
    /** A fleet that can answer both a full sweep and a single-gateway re-read. */
    function eventFleet() {
      let sweeps = 0;
      let singles = 0;
      let version = 0;
      const fleet = {
        async statusAllDetail(): Promise<GatewayStatusDetail[]> {
          sweeps += 1;
          return [detail('main'), detail('scout')];
        },
        async statusDetailFor(gatewayId: string): Promise<GatewayStatusDetail> {
          singles += 1;
          version += 1;
          return detail(gatewayId, {
            status: { gatewayId, sessionCount: version } as GatewayStatusDetail['status'],
          });
        },
      };
      return {
        fleet: fleet as unknown as FleetService,
        sweeps: () => sweeps,
        singles: () => singles,
      };
    }

    const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

    it('re-reads only the gateway that reported a change', async () => {
      const { fleet, sweeps, singles } = eventFleet();
      const store = new FleetSnapshotStore(fleet, {
        refreshIntervalMs: 60_000,
        eventDebounceMs: 5,
      });

      await store.ready();
      expect(sweeps()).toBe(1);

      store.touchGateway('main');
      await tick(40);

      // One targeted read, not another 18-RPC fleet sweep.
      expect(singles()).toBe(1);
      expect(sweeps()).toBe(1);
      store.stop();
    });

    it('batches a burst of events from one gateway into a single re-read', async () => {
      const { fleet, singles } = eventFleet();
      const store = new FleetSnapshotStore(fleet, {
        refreshIntervalMs: 60_000,
        eventDebounceMs: 20,
      });

      await store.ready();
      for (let i = 0; i < 25; i += 1) store.touchGateway('main');
      await tick(60);

      // A busy agent must not be able to amplify its events into RPC load.
      expect(singles()).toBe(1);
      store.stop();
    });

    it('publishes the updated gateway without disturbing the others', async () => {
      const { fleet } = eventFleet();
      const store = new FleetSnapshotStore(fleet, {
        refreshIntervalMs: 60_000,
        eventDebounceMs: 5,
      });

      await store.ready();
      const seen = vi.fn();
      store.subscribe(seen);

      store.touchGateway('main');
      await tick(40);

      expect(seen).toHaveBeenCalledTimes(1);
      const snap = seen.mock.calls[0][0] as { details: GatewayStatusDetail[] };
      expect(snap.details).toHaveLength(2);
      expect(snap.details.find((d) => d.status.gatewayId === 'main')?.status.sessionCount).toBe(1);
      expect(snap.details.map((d) => d.status.gatewayId)).toContain('scout');
      store.stop();
    });

    it('ignores events once stopped', async () => {
      const { fleet, singles } = eventFleet();
      const store = new FleetSnapshotStore(fleet, {
        refreshIntervalMs: 60_000,
        eventDebounceMs: 5,
      });

      await store.ready();
      store.stop();
      store.touchGateway('main');
      await tick(40);

      expect(singles()).toBe(0);
    });
  });
});
