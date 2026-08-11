import useSWR from 'swr';
import type { Tone } from '../ui/Badge';

export type ResearchStage =
  | 'queued'
  | 'dispatched'
  | 'fetched'
  | 'normalized'
  | 'distilling'
  | 'brief_ready'
  | 'brief_flagged'
  | 'condemned'
  | 'abandoned'
  | 'stalled';

export type ResearchDeliveryTarget = { gatewayId: string; sessionKey: string };

export type TrackedResearchRequest = {
  topicId: string;
  requestId: string;
  query: string | null;
  approvedAt: string;
  approvedBy: string;
  stage: ResearchStage;
  stageAt: string;
  deliverTo: ResearchDeliveryTarget | null;
  deliveredAt: string | null;
  deliveryError: string | null;
  archivedAt: string | null;
  stalledAt: string | null;
};

export type ResearchBriefClaim = {
  claim: string;
  evidenceExcerpt: string | null;
  sourceReference: string | null;
};

export type ResearchBrief = {
  topicId: string;
  path: string;
  flagged: boolean;
  containsExternalInstructions: boolean;
  sourceReadsImperative: boolean;
  sourceId: string | null;
  sourceType: string | null;
  sourceSha256: string | null;
  claims: ResearchBriefClaim[];
};

export type ResearchRequestsResponse = {
  items: unknown[];
  tracked: TrackedResearchRequest[];
  projectedAt: string;
};

export type ResearchResultResponse = {
  tracked: TrackedResearchRequest | null;
  stage: ResearchStage;
  brief: ResearchBrief | null;
  projectedAt: string;
};

/**
 * How each stage reads to an operator, and who owns it when it stops moving.
 *
 * The `owner` line is the thing worth having on screen: the pipeline crosses
 * three schedulers, and "stuck at distilling" is only actionable once you know
 * distilling is the curator's 15m cron and not the sealer's.
 */
export const STAGE_META: Record<ResearchStage, { label: string; tone: Tone; owner: string }> = {
  queued: {
    label: 'Queued',
    tone: 'muted',
    owner: 'Waiting for scout to pick it up (inbox-research-requests, every 5m).',
  },
  dispatched: {
    label: 'Fetching',
    tone: 'primary',
    owner: 'Scout is searching the web for it.',
  },
  fetched: {
    label: 'Fetched',
    tone: 'primary',
    owner: 'Source retrieved. Waiting on the sealer to normalize it (every 300s).',
  },
  normalized: {
    label: 'Normalized',
    tone: 'primary',
    owner: 'Through the airlock. Waiting on the curator to distill it (every 15m).',
  },
  distilling: {
    label: 'Distilled',
    tone: 'primary',
    owner: 'Brief written. Waiting on the sealer to validate and promote it (every 300s).',
  },
  brief_ready: { label: 'Answer ready', tone: 'success', owner: 'Brief promoted to exchange/briefs.' },
  brief_flagged: {
    label: 'Answer ready — flagged',
    tone: 'warning',
    owner: 'Promoted to exchange/briefs-flagged: the curator saw instruction-like text in the source.',
  },
  condemned: {
    label: 'Rejected',
    tone: 'danger',
    owner: 'The brief failed the sealer’s schema or evidence check too many times.',
  },
  abandoned: {
    label: 'Abandoned',
    tone: 'danger',
    owner: 'Scout’s fetch timed out with no output. Re-approve to try again.',
  },
  stalled: { label: 'Stalled', tone: 'danger', owner: 'No progress for far longer than the pipeline takes.' },
};

const IN_FLIGHT: ResearchStage[] = ['queued', 'dispatched', 'fetched', 'normalized', 'distilling'];

export function isInFlight(stage: ResearchStage): boolean {
  return IN_FLIGHT.includes(stage);
}

/** Ordered pipeline positions, for the progress rail. */
export const STAGE_ORDER: ResearchStage[] = [
  'queued',
  'dispatched',
  'fetched',
  'normalized',
  'distilling',
  'brief_ready',
];

const IDLE_POLL_MS = 30_000;
/**
 * Faster only while something is actually moving. The server sweeps the
 * exchange every 20s, so polling below that buys nothing but load.
 */
const ACTIVE_POLL_MS = 10_000;

/**
 * Module scope, not an inline arrow — and that is the whole fix for a pipeline
 * that only ever advanced on a page reload.
 *
 * SWR's polling effect lists `refreshInterval` in its dependencies, so a new
 * function identity on every render tears the timer down and starts it again
 * from zero. The Approvals page re-renders every time the fleet stream pushes a
 * snapshot — several times a minute — which reset the 10s timer before it could
 * ever fire. A stable reference lets it run.
 */
const researchRefreshInterval = (latest: ResearchRequestsResponse | undefined): number =>
  latest?.tracked?.some((t) => isInFlight(t.stage)) ? ACTIVE_POLL_MS : IDLE_POLL_MS;

export function useResearchRequests() {
  const { data, error, mutate } = useSWR<ResearchRequestsResponse>('/api/research-requests', {
    refreshInterval: researchRefreshInterval,
    // A stage change while the operator is looking elsewhere in the app should
    // be on screen when they come back, not one poll later.
    revalidateOnFocus: true,
  });
  return {
    data: data ?? null,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    refresh: async () => {
      await mutate();
    },
  };
}

/** Same stable-reference rule as above — an inline arrow here never fires either. */
const resultRefreshInterval = (latest: ResearchResultResponse | undefined): number =>
  latest && isInFlight(latest.stage) ? ACTIVE_POLL_MS : 0;

export function useResearchResult(topicId: string | null) {
  const { data, error, mutate } = useSWR<ResearchResultResponse>(
    topicId ? `/api/research-requests/${encodeURIComponent(topicId)}/result` : null,
    { refreshInterval: resultRefreshInterval }
  );
  return {
    data: data ?? null,
    error: error instanceof Error ? error.message : error ? String(error) : null,
    refresh: async () => {
      await mutate();
    },
  };
}
