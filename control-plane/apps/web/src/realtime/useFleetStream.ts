import { useEffect, useState } from 'react';
import { mutate } from 'swr';
import { consumeSse, type ConnectionState } from './sseClient';

export type { ConnectionState };

type SnapshotPayload = {
  ts: string;
  error: string | null;
  approvals: {
    items: unknown[];
    counts: { total: number; exec: number; research_request: number };
  };
  gateways: Array<{ gatewayId: string; status: string; pendingApprovals: number | null; sessionCount: number | null }>;
};

/** Fleet-wide snapshot push. The server sweeps once; every client reads it. */
export function useFleetStream() {
  const [state, setState] = useState<ConnectionState>('connecting');

  useEffect(() => {
    /**
     * The approvals half of the last snapshot.
     *
     * A sweep runs on a timer *and* on every gateway event, so most snapshots
     * report no change at all — but the frame carries a fresh `ts`, and writing
     * it into the cache unconditionally handed every `useApprovals()` consumer
     * a new object each time. The rail and whatever page was open re-rendered
     * several times a minute for nothing, and that steady background work is
     * what made hover states feel like they were trailing the cursor.
     *
     * Only the approvals write is gated: the two revalidations below re-fetch
     * rather than overwrite, and SWR compares the result before publishing it,
     * so they cost a request but never a spurious render.
     */
    let lastApprovals: string | null = null;

    return consumeSse('/api/events/stream', {
      onState: setState,
      onEvent: (event, data) => {
        if (event !== 'snapshot') return;
        let snap: SnapshotPayload;
        try {
          snap = JSON.parse(data) as SnapshotPayload;
        } catch {
          return; // ignore malformed frame
        }

        const approvals = JSON.stringify(snap.approvals);
        if (approvals !== lastApprovals) {
          lastApprovals = approvals;
          void mutate(
            '/api/approvals',
            { items: snap.approvals.items, counts: snap.approvals.counts, projectedAt: snap.ts },
            { revalidate: false }
          );
        }
        // Fleet-level fields only (no runtimeVersion/agentCount/cronJobCount) — nudge
        // the fuller dashboard/gateways queries to revalidate rather than overwrite them.
        void mutate('/api/dashboard');
        void mutate('/api/gateways');
      },
    });
  }, []);

  return state;
}
