import type { AgentSummary, CronJobSummary, SessionSummary } from '@ocp/domain';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

export function mapAgentsList(gatewayId: string, payload: unknown): AgentSummary[] {
  const root = asRecord(payload);
  const agents = (root?.agents as unknown[]) || [];
  const defaultId = typeof root?.defaultId === 'string' ? root.defaultId : null;

  return agents
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((a) => {
      const id = String(a.id ?? a.agentId ?? '');
      const identity = asRecord(a.identity);
      return {
        gatewayId,
        id,
        isDefault: Boolean(a.isDefault) || id === defaultId,
        model: typeof a.model === 'string' ? a.model : null,
        identityName:
          (identity && typeof identity.name === 'string' && identity.name) ||
          (typeof a.name === 'string' ? a.name : null),
        workspace: typeof a.workspace === 'string' ? a.workspace : null,
      };
    })
    .filter((a) => a.id.length > 0);
}

export function mapSessionsList(gatewayId: string, payload: unknown): SessionSummary[] {
  const root = asRecord(payload);
  const sessions = (root?.sessions as unknown[]) || [];
  return sessions
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((s) => {
      const key = String(s.key ?? s.sessionKey ?? '');
      const agentId =
        typeof s.agentId === 'string'
          ? s.agentId
          : key.startsWith('agent:')
            ? key.split(':')[1] || null
            : null;
      return {
        gatewayId,
        key,
        agentId,
        updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : typeof s.updated_at === 'number' ? s.updated_at : null,
        kind: typeof s.kind === 'string' ? s.kind : typeof s.channel === 'string' ? s.channel : null,
        displayName: typeof s.displayName === 'string' ? s.displayName : typeof s.label === 'string' ? s.label : null,
      };
    })
    .filter((s) => s.key.length > 0);
}

export function mapCronList(gatewayId: string, payload: unknown): CronJobSummary[] {
  const root = asRecord(payload);
  const jobs = (root?.jobs as unknown[]) || (Array.isArray(payload) ? payload : []);
  return jobs
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((j) => ({
      gatewayId,
      id: String(j.id ?? ''),
      declarationKey: typeof j.declarationKey === 'string' ? j.declarationKey : null,
      name: typeof j.name === 'string' ? j.name : null,
      enabled: typeof j.enabled === 'boolean' ? j.enabled : null,
      agentId: typeof j.agentId === 'string' ? j.agentId : typeof j.agent === 'string' ? j.agent : null,
    }))
    .filter((j) => j.id.length > 0 || j.declarationKey);
}

export function extractSessionCount(payload: unknown): number | null {
  const root = asRecord(payload);
  if (!root) return null;
  if (typeof root.totalCount === 'number') return root.totalCount;
  if (typeof root.count === 'number') return root.count;
  if (Array.isArray(root.sessions)) return root.sessions.length;
  return null;
}

export function extractRuntimeVersion(statusPayload: unknown): string | null {
  const root = asRecord(statusPayload);
  return typeof root?.runtimeVersion === 'string' ? root.runtimeVersion : null;
}

export function extractDefaultAgentId(healthOrAgents: unknown): string | null {
  const root = asRecord(healthOrAgents);
  if (typeof root?.defaultAgentId === 'string') return root.defaultAgentId;
  if (typeof root?.defaultId === 'string') return root.defaultId;
  return null;
}
