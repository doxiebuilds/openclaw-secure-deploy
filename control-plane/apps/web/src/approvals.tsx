import useSWR from 'swr';

export type ExecApproval = {
  kind: 'exec';
  gatewayId: string;
  id: string;
  agentId: string | null;
  sessionKey: string | null;
  toolName: string | null;
  title: string | null;
  description: string | null;
  command: string | null;
  riskHint: string | null;
  requestedAt: number | null;
};

export type ResearchApproval = {
  kind: 'research_request';
  id: string;
  query: string | null;
  topicId: string | null;
  valid: boolean;
  validationError: string | null;
  requestedAt: number | null;
};

export type ApprovalItem = ExecApproval | ResearchApproval;

export type ApprovalsResponse = {
  items: ApprovalItem[];
  counts: { total: number; exec: number; research_request: number };
  projectedAt: string;
};

/**
 * Single source of truth for pending approvals, shared by the sidebar badge
 * and the Approvals page. Realtime updates arrive by push (see
 * realtime/useFleetStream.ts, which calls mutate('/api/approvals') on every
 * fleet snapshot); this refreshInterval is only a fallback for when the
 * stream connection is down.
 */
const FALLBACK_POLL_MS = 30_000;

export function useApprovals() {
  const { data, error, mutate } = useSWR<ApprovalsResponse>('/api/approvals', {
    refreshInterval: FALLBACK_POLL_MS,
  });
  return {
    data: data ?? null,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    refresh: async () => {
      await mutate();
    },
  };
}
