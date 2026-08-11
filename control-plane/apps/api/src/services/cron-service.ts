import type { CronJobSummary } from '@ocp/domain';
import { mapCronList } from '@ocp/gateway-client';
import type { GatewayConnector } from '@ocp/gateway-client';
import type { AuditStore } from './audit-store.js';

export type CronJobDetail = CronJobSummary & {
  description: string | null;
  schedule: unknown;
  nextRunAtMs: number | null;
  lastStatus: string | null;
  raw: unknown;
};

export class CronService {
  constructor(
    private readonly connector: GatewayConnector,
    private readonly audit: AuditStore
  ) {}

  async listAll(gatewayId?: string): Promise<CronJobDetail[]> {
    const ids = gatewayId ? [gatewayId] : this.connector.listGateways().map((g) => g.id);
    const chunks = await Promise.all(ids.map((id) => this.listForGateway(id)));
    return chunks.flat();
  }

  async listForGateway(gatewayId: string): Promise<CronJobDetail[]> {
    const res = await this.connector.tryCall(gatewayId, 'cron.list', {});
    if (!res.ok) throw new Error(`cron.list failed for ${gatewayId}: ${res.error}`);
    const root = res.data as Record<string, unknown>;
    const jobs = (root.jobs as unknown[]) || [];
    return jobs.map((job) => mapJob(gatewayId, job));
  }

  async get(gatewayId: string, jobId: string): Promise<CronJobDetail | null> {
    const res = await this.connector.tryCall(gatewayId, 'cron.get', { id: jobId });
    if (!res.ok) {
      // fallback: list and find
      const all = await this.listForGateway(gatewayId);
      return all.find((j) => j.id === jobId) ?? null;
    }
    return mapJob(gatewayId, res.data);
  }

  async setEnabled(
    gatewayId: string,
    jobId: string,
    enabled: boolean,
    actorId: string
  ): Promise<CronJobDetail> {
    const raw = await this.connector.call(gatewayId, 'cron.update', {
      jobId,
      patch: { enabled },
    });
    this.audit.append({
      type: 'cron.update',
      actorType: 'user',
      actorId,
      gatewayId,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `${enabled ? 'Enabled' : 'Disabled'} cron job ${jobId} on ${gatewayId}`,
      details: { jobId, enabled },
    });
    return mapJob(gatewayId, raw);
  }

  async runNow(gatewayId: string, jobId: string, actorId: string): Promise<unknown> {
    const raw = await this.connector.call(gatewayId, 'cron.run', { jobId });
    this.audit.append({
      type: 'cron.run',
      actorType: 'user',
      actorId,
      gatewayId,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `Manually ran cron job ${jobId} on ${gatewayId}`,
      details: { jobId, result: raw },
    });
    return raw;
  }

  async runs(gatewayId: string, jobId: string, limit = 20): Promise<unknown> {
    return this.connector.call(gatewayId, 'cron.runs', { id: jobId, limit });
  }

  async status(gatewayId: string): Promise<unknown> {
    return this.connector.call(gatewayId, 'cron.status', {});
  }
}

function mapJob(gatewayId: string, job: unknown): CronJobDetail {
  const j = (job && typeof job === 'object' ? job : {}) as Record<string, unknown>;
  const state = (j.state && typeof j.state === 'object' ? j.state : {}) as Record<string, unknown>;
  const base = mapCronList(gatewayId, { jobs: [j] })[0];
  return {
    gatewayId,
    id: base?.id || String(j.id ?? ''),
    declarationKey: base?.declarationKey ?? (typeof j.declarationKey === 'string' ? j.declarationKey : null),
    name: base?.name ?? (typeof j.name === 'string' ? j.name : null),
    enabled: base?.enabled ?? (typeof j.enabled === 'boolean' ? j.enabled : null),
    agentId: base?.agentId ?? (typeof j.agentId === 'string' ? j.agentId : null),
    description: typeof j.description === 'string' ? j.description : null,
    schedule: j.schedule ?? null,
    nextRunAtMs: typeof j.nextRunAtMs === 'number' ? j.nextRunAtMs : typeof state.nextRunAtMs === 'number' ? state.nextRunAtMs : null,
    lastStatus:
      typeof state.lastStatus === 'string'
        ? state.lastStatus
        : typeof state.lastRunStatus === 'string'
          ? state.lastRunStatus
          : null,
    raw: j,
  };
}
