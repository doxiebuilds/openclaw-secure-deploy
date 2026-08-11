import type {
  AgentSummary,
  CronJobSummary,
  ExecApprovalSummary,
  GatewayLiveStatus,
  SessionSummary,
} from '@ocp/domain';
import {
  checkHttpHealth,
  extractDefaultAgentId,
  extractRuntimeVersion,
  extractSessionCount,
  mapAgentsList,
  mapCronList,
  mapExecApprovalList,
  mapSessionsList,
} from '@ocp/gateway-client';
import type { GatewayConnector } from '@ocp/gateway-client';

/**
 * A single status sweep, plus the collections it already had to fetch to
 * produce that status. Callers that need agents or pending exec approvals
 * should read them from here rather than issuing the same RPC a second time.
 */
export type GatewayStatusDetail = {
  status: GatewayLiveStatus;
  agents: AgentSummary[];
  execApprovals: ExecApprovalSummary[];
  sessions: SessionSummary[];
  cronJobs: CronJobSummary[];
  /**
   * Which collections this sweep actually retrieved.
   *
   * A failed RPC yields an empty array, which is indistinguishable from a
   * genuinely empty gateway. Callers that cache must not let a transient
   * failure erase known-good data, so they consult these flags instead of
   * treating `[]` as truth.
   */
  fetched: {
    agents: boolean;
    execApprovals: boolean;
    sessions: boolean;
    cronJobs: boolean;
  };
};

export class FleetService {
  constructor(private readonly connector: GatewayConnector) {}

  listGateways() {
    return this.connector.listGateways();
  }

  getGateway(id: string) {
    return this.connector.getGateway(id);
  }

  async statusFor(gatewayId: string): Promise<GatewayLiveStatus> {
    return (await this.statusDetailFor(gatewayId)).status;
  }

  async statusDetailFor(gatewayId: string): Promise<GatewayStatusDetail> {
    const gw = this.connector.getGateway(gatewayId);
    const checkedAt = new Date().toISOString();

    // HTTP healthz is secondary (native Control UI reachability).
    // Primary liveness for Phase 1–2 is docker-exec Gateway RPC (Phase 0 path).
    // It rides in the same Promise.all so its timeout never fronts the sweep.
    const [http, health, status, agents, sessions, cron, approvals] = await Promise.all([
      checkHttpHealth(gw),
      this.connector.tryCall(gatewayId, 'health'),
      this.connector.tryCall(gatewayId, 'status'),
      this.connector.tryCall(gatewayId, 'agents.list'),
      this.connector.tryCall(gatewayId, 'sessions.list'),
      this.connector.tryCall(gatewayId, 'cron.list'),
      this.connector.tryCall(gatewayId, 'exec.approval.list'),
    ]);

    const rpcFailures = [health, status, agents, sessions, cron, approvals].filter((r) => !r.ok);
    const agentIds = agents.ok ? mapAgentsList(gatewayId, agents.data) : [];
    const sessionCount = sessions.ok ? extractSessionCount(sessions.data) : null;
    const cronJobs = cron.ok ? mapCronList(gatewayId, cron.data) : [];
    const pendingApprovals =
      approvals.ok && Array.isArray(approvals.data) ? approvals.data.length : approvals.ok ? 0 : null;

    const rpcAlive = health.ok || status.ok || agents.ok;
    let statusValue: GatewayLiveStatus['status'] = 'online';
    if (!rpcAlive) statusValue = 'offline';
    else if (rpcFailures.length > 0 || !http.ok) statusValue = 'degraded';

    const errors: string[] = [];
    if (!http.ok && http.error) errors.push(`healthz: ${http.error}`);
    for (const f of rpcFailures) {
      if (!f.ok) errors.push(`${f.method}: ${f.error}`);
    }

    return {
      status: {
        gatewayId,
        status: statusValue,
        httpHealthzOk: http.ok,
        httpStatusCode: http.statusCode,
        runtimeVersion: status.ok ? extractRuntimeVersion(status.data) : null,
        defaultAgentId: agents.ok
          ? extractDefaultAgentId(agents.data)
          : health.ok
            ? extractDefaultAgentId(health.data)
            : null,
        containerRunning: rpcAlive,
        agentCount: agents.ok ? agentIds.length : null,
        sessionCount,
        cronJobCount: cron.ok ? cronJobs.length : null,
        pendingApprovals,
        error: errors.length ? errors.join('; ') : null,
        checkedAt,
        projectedAt: checkedAt,
      },
      agents: agentIds,
      execApprovals: approvals.ok ? mapExecApprovalList(gatewayId, approvals.data) : [],
      sessions: sessions.ok
        ? mapSessionsList(gatewayId, sessions.data).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
        : [],
      cronJobs,
      fetched: {
        agents: agents.ok,
        execApprovals: approvals.ok,
        sessions: sessions.ok,
        cronJobs: cron.ok,
      },
    };
  }

  async statusAll(): Promise<GatewayLiveStatus[]> {
    return (await this.statusAllDetail()).map((d) => d.status);
  }

  async statusAllDetail(): Promise<GatewayStatusDetail[]> {
    const gateways = this.listGateways();
    return Promise.all(gateways.map((g) => this.statusDetailFor(g.id)));
  }

  async listAgents(gatewayId?: string): Promise<AgentSummary[]> {
    const ids = gatewayId ? [gatewayId] : this.listGateways().map((g) => g.id);
    const chunks = await Promise.all(
      ids.map(async (id) => {
        const res = await this.connector.tryCall(id, 'agents.list');
        if (!res.ok) {
          throw new Error(`agents.list failed for ${id}: ${res.error}`);
        }
        return mapAgentsList(id, res.data);
      })
    );
    return chunks.flat();
  }

  async getAgent(gatewayId: string, agentId: string): Promise<AgentSummary | null> {
    const agents = await this.listAgents(gatewayId);
    return agents.find((a) => a.id === agentId) ?? null;
  }

  async listSessions(gatewayId: string, agentId?: string): Promise<SessionSummary[]> {
    const res = await this.connector.tryCall(gatewayId, 'sessions.list');
    if (!res.ok) {
      throw new Error(`sessions.list failed for ${gatewayId}: ${res.error}`);
    }
    let sessions = mapSessionsList(gatewayId, res.data);
    if (agentId) {
      sessions = sessions.filter((s) => s.agentId === agentId || s.key.includes(`agent:${agentId}:`));
    }
    // newest first when updatedAt present
    sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return sessions;
  }

  async getChatHistory(gatewayId: string, sessionKey: string, limit = 50) {
    return this.connector.call(gatewayId, 'chat.history', { sessionKey, limit });
  }

  async listCron(gatewayId: string) {
    const res = await this.connector.tryCall(gatewayId, 'cron.list');
    if (!res.ok) throw new Error(res.error);
    return mapCronList(gatewayId, res.data);
  }
}
