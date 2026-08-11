import type { FleetService, GatewayStatusDetail } from './fleet-service.js';

export type FleetSnapshot = {
  details: GatewayStatusDetail[];
  generatedAt: string;
  /** Wall time of the sweep that produced this snapshot. */
  durationMs: number;
  /** Populated when the sweep threw; the previous details are retained. */
  error: string | null;
};

export type FleetSnapshotStoreOptions = {
  /** Gap between the end of one sweep and the start of the next. */
  refreshIntervalMs: number;
  /**
   * How long to batch gateway events before re-reading that gateway. A run
   * start emits several events in a burst; without this each one would launch
   * its own refresh.
   */
  eventDebounceMs?: number;
};

const DEFAULT_EVENT_DEBOUNCE_MS = 200;

/**
 * One background-refreshed view of the fleet, shared by every reader.
 *
 * Gateway RPC throughput is pinned near 0.6 calls/s, so a full sweep costs tens
 * of seconds and cannot sit in a request path. Previously each page load — and
 * each connected SSE client, every 4s — launched its own sweep, so concurrent
 * readers multiplied the load on the very gateways they were measuring.
 *
 * Here exactly one sweep runs at a time. Requests read whatever is in memory and
 * return immediately; the refresher is paced so the fleet is never saturated.
 */
export class FleetSnapshotStore {
  private snapshot: FleetSnapshot | null = null;
  private inFlight: Promise<FleetSnapshot> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly listeners = new Set<(s: FleetSnapshot) => void>();
  private readonly pendingGatewayTimers = new Map<string, NodeJS.Timeout>();
  private readonly gatewayInFlight = new Map<string, Promise<void>>();

  constructor(
    private readonly fleet: FleetService,
    private readonly options: FleetSnapshotStoreOptions
  ) {}

  /** Begin refreshing in the background. Safe to call once. */
  start(): void {
    if (this.timer || this.stopped) return;
    void this.refresh().catch(() => {
      /* refresh() already records the error on the snapshot */
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const [, timer] of this.pendingGatewayTimers) clearTimeout(timer);
    this.pendingGatewayTimers.clear();
  }

  /** Latest snapshot, or null before the first sweep completes. */
  current(): FleetSnapshot | null {
    return this.snapshot;
  }

  /**
   * Latest snapshot, waiting for the first sweep only on a cold start.
   * Once warm this never blocks, even while a refresh is running.
   */
  async ready(): Promise<FleetSnapshot> {
    if (this.snapshot) return this.snapshot;
    return this.refresh();
  }

  /** Force a sweep, joining the running one rather than starting a second. */
  refresh(): Promise<FleetSnapshot> {
    if (this.inFlight) return this.inFlight;

    const started = Date.now();
    this.inFlight = this.fleet
      .statusAllDetail()
      .then((details): FleetSnapshot => {
        return {
          details: details.map((d) => this.mergeWithPrevious(d)),
          generatedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          error: null,
        };
      })
      .catch((err): FleetSnapshot => {
        const message = err instanceof Error ? err.message : String(err);
        // Keep serving the last good details rather than blanking the UI.
        return {
          details: this.snapshot?.details ?? [],
          generatedAt: new Date().toISOString(),
          durationMs: Date.now() - started,
          error: message,
        };
      })
      .then((snap) => {
        this.snapshot = snap;
        this.inFlight = null;
        this.emit(snap);
        this.scheduleNext();
        return snap;
      });

    return this.inFlight;
  }

  /**
   * Carry forward collections this sweep could not retrieve.
   *
   * A gateway that briefly stops answering RPCs returns empty arrays, and
   * publishing those verbatim would blank the agent and session lists — and
   * zero the dashboard counts — as though the fleet had emptied out. The live
   * status still reflects the failure, so the UI can show the gateway as
   * offline while continuing to display what it last knew.
   */
  private mergeWithPrevious(next: GatewayStatusDetail): GatewayStatusDetail {
    const prev = this.snapshot?.details.find((d) => d.status.gatewayId === next.status.gatewayId);
    if (!prev) return next;

    return {
      ...next,
      agents: next.fetched.agents ? next.agents : prev.agents,
      execApprovals: next.fetched.execApprovals ? next.execApprovals : prev.execApprovals,
      sessions: next.fetched.sessions ? next.sessions : prev.sessions,
      cronJobs: next.fetched.cronJobs ? next.cronJobs : prev.cronJobs,
    };
  }

  /**
   * Mark one gateway as changed, in response to a gateway event.
   *
   * This is what replaces polling: the periodic sweep stays as a safety net for
   * state no event covers, but anything a gateway announces reaches the UI in
   * roughly one RPC instead of up to a full refresh interval.
   *
   * Refreshes are coalesced per gateway, and a gateway already being refreshed
   * is not refreshed again concurrently — a busy agent must not be able to
   * amplify its own event stream into unbounded RPC load.
   */
  touchGateway(gatewayId: string): void {
    if (this.stopped) return;
    if (this.pendingGatewayTimers.has(gatewayId)) return;

    const timer = setTimeout(() => {
      this.pendingGatewayTimers.delete(gatewayId);
      void this.refreshGateway(gatewayId).catch(() => {
        /* refreshGateway keeps the previous details on failure */
      });
    }, this.options.eventDebounceMs ?? DEFAULT_EVENT_DEBOUNCE_MS);
    timer.unref?.();
    this.pendingGatewayTimers.set(gatewayId, timer);
  }

  /** Re-read a single gateway and publish a snapshot containing just that change. */
  private refreshGateway(gatewayId: string): Promise<void> {
    const existing = this.gatewayInFlight.get(gatewayId);
    if (existing) return existing;

    const run = this.fleet
      .statusDetailFor(gatewayId)
      .then((detail) => {
        // A full sweep landing mid-flight already republished every gateway;
        // merging into a stale base would resurrect the details it replaced.
        const base = this.snapshot;
        if (!base) return;

        const merged = this.mergeWithPrevious(detail);
        const details = base.details.some((d) => d.status.gatewayId === gatewayId)
          ? base.details.map((d) => (d.status.gatewayId === gatewayId ? merged : d))
          : [...base.details, merged];

        const snap: FleetSnapshot = {
          details,
          generatedAt: new Date().toISOString(),
          durationMs: base.durationMs,
          error: base.error,
        };
        this.snapshot = snap;
        this.emit(snap);
      })
      .catch(() => {
        /* keep serving the last good details */
      })
      .finally(() => {
        this.gatewayInFlight.delete(gatewayId);
      });

    this.gatewayInFlight.set(gatewayId, run);
    return run;
  }

  subscribe(listener: (s: FleetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(snap: FleetSnapshot): void {
    for (const l of this.listeners) {
      try {
        l(snap);
      } catch {
        /* a broken subscriber must not stall the refresh loop */
      }
    }
  }

  private scheduleNext(): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => {});
    }, this.options.refreshIntervalMs);
    // Never hold the process open for a refresh.
    this.timer.unref?.();
  }
}
