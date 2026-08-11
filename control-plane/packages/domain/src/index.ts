/** Shared domain types for the OpenClaw control plane. */

export type GatewayId = string;

export type GatewayHealthStatus = 'online' | 'degraded' | 'offline' | 'unknown';

export type FleetGateway = {
  id: GatewayId;
  container: string;
  cell: number;
  hostWsUrl: string;
  hostHttpBase: string;
  healthzPath: string;
  uiForwardService: string;
  secretsFile: string;
  configDir: string;
  configFile: string;
  expectedAgents: string[];
  role: string;
};

export type GatewayLiveStatus = {
  gatewayId: GatewayId;
  status: GatewayHealthStatus;
  httpHealthzOk: boolean;
  httpStatusCode: number | null;
  runtimeVersion: string | null;
  defaultAgentId: string | null;
  containerRunning: boolean | null;
  agentCount: number | null;
  sessionCount: number | null;
  cronJobCount: number | null;
  pendingApprovals: number | null;
  error: string | null;
  checkedAt: string;
  projectedAt: string;
};

export type AgentSummary = {
  gatewayId: GatewayId;
  id: string;
  isDefault: boolean;
  model: string | null;
  identityName: string | null;
  workspace: string | null;
};

export type SessionSummary = {
  gatewayId: GatewayId;
  key: string;
  agentId: string | null;
  updatedAt: number | null;
  kind: string | null;
  displayName: string | null;
};

export type CronJobSummary = {
  gatewayId: GatewayId;
  id: string;
  declarationKey: string | null;
  name: string | null;
  enabled: boolean | null;
  agentId: string | null;
};

export type AuthUser = {
  id: string;
  username: string;
  roles: string[];
};

export type ApiErrorBody = {
  error: string;
  code?: string;
  details?: unknown;
};

/** OpenClaw exec approval decision values validated on 2026.7.1 */
export type ExecApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

export type ApprovalKind = 'exec' | 'research_request';

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'error' | 'unknown';

export type ExecApprovalSummary = {
  kind: 'exec';
  gatewayId: GatewayId;
  id: string;
  status: ApprovalStatus;
  requestedAt: number | null;
  agentId: string | null;
  sessionKey: string | null;
  toolName: string | null;
  title: string | null;
  description: string | null;
  command: string | null;
  riskHint: string | null;
  raw: unknown;
};

export type ResearchRequestSummary = {
  kind: 'research_request';
  gatewayId: 'main';
  id: string;
  status: ApprovalStatus;
  query: string | null;
  topicId: string | null;
  valid: boolean;
  validationError: string | null;
  path: string;
  requestedAt: number | null;
};

export type ApprovalItem = ExecApprovalSummary | ResearchRequestSummary;

/**
 * Where an approved research request has got to.
 *
 * Ordered by progress, and derived from ground truth on disk (the seal ledger
 * plus the exchange directories) rather than from anything the control plane
 * remembers — see ResearchService.probeStage. That means a tracker record that
 * is lost, stale, or restored from an old file re-converges on the next pass
 * instead of stranding a request.
 */
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

/** Stages from which nothing further will happen without a human. */
export const TERMINAL_RESEARCH_STAGES: readonly ResearchStage[] = [
  'brief_ready',
  'brief_flagged',
  'condemned',
  'abandoned',
];

export type ResearchBriefClaim = {
  claim: string;
  evidenceExcerpt: string | null;
  sourceReference: string | null;
};

export type ResearchBrief = {
  topicId: string;
  /** Host path. Not the path the agent sees — see ResearchBriefDelivery. */
  path: string;
  /** True when the brief was promoted into briefs-flagged/ rather than briefs/. */
  flagged: boolean;
  /** The curator's own judgement that the source contained imperative text. */
  containsExternalInstructions: boolean;
  /**
   * The sealer's independent witness that the SOURCE reads as instructions.
   * Stronger than the curator's flag: it is computed by the airlock over the
   * normalized text, not self-reported by the cell that read the page.
   */
  sourceReadsImperative: boolean;
  sourceId: string | null;
  sourceType: string | null;
  sourceSha256: string | null;
  claims: ResearchBriefClaim[];
};

export type ResearchDeliveryTarget = {
  gatewayId: GatewayId;
  sessionKey: string;
};

export type TrackedResearchRequest = {
  topicId: string;
  /** Basename (no .json) of the file in exchange/inbox. */
  requestId: string;
  query: string | null;
  approvedAt: string;
  approvedBy: string;
  stage: ResearchStage;
  stageAt: string;
  deliverTo: ResearchDeliveryTarget | null;
  deliveredAt: string | null;
  deliveryError: string | null;
  /** Set when the request file was swept out of exchange/inbox. */
  archivedAt: string | null;
  /** Set once the stall warning has been raised, so it is raised only once. */
  stalledAt: string | null;
};

export type ResearchRequestResult = {
  tracked: TrackedResearchRequest | null;
  stage: ResearchStage;
  brief: ResearchBrief | null;
};

export type AuditEvent = {
  id: string;
  ts: string;
  type: string;
  actorType: 'user' | 'system' | 'agent';
  actorId: string | null;
  gatewayId: string | null;
  approvalId: string | null;
  sessionKey: string | null;
  outcome: 'ok' | 'error' | 'denied' | 'info';
  summary: string;
  details?: unknown;
};

export type ChatSendResult = {
  gatewayId: GatewayId;
  sessionKey: string;
  runId: string | null;
  status: string | null;
  raw: unknown;
};

export type TimelineEvent = {
  id: string;
  ts: number | null;
  role: string | null;
  kind: string;
  summary: string;
  raw?: unknown;
};
