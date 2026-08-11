import { randomUUID } from 'node:crypto';
import type { ApprovalItem, ExecApprovalDecision, ExecApprovalSummary } from '@ocp/domain';
import { mapExecApprovalList } from '@ocp/gateway-client';
import type { GatewayConnector } from '@ocp/gateway-client';
import type { AuditStore } from './audit-store.js';
import type { ResearchService } from './research-service.js';

const VALID_DECISIONS = new Set<ExecApprovalDecision>(['allow-once', 'allow-always', 'deny']);

export class ApprovalService {
  constructor(
    private readonly connector: GatewayConnector,
    private readonly research: ResearchService,
    private readonly audit: AuditStore
  ) {}

  async listPending(): Promise<ApprovalItem[]> {
    const gateways = this.connector.listGateways();
    const execChunks = await Promise.all(
      gateways.map(async (gw) => {
        const res = await this.connector.tryCall(gw.id, 'exec.approval.list', {});
        if (!res.ok) return [] as ExecApprovalSummary[];
        return mapExecApprovalList(gw.id, res.data);
      })
    );
    const research = this.research.listPending();
    return [...execChunks.flat(), ...research];
  }

  async resolveExec(
    gatewayId: string,
    approvalId: string,
    decision: ExecApprovalDecision,
    actorId: string
  ): Promise<{ ok: true; raw: unknown } | { ok: false; error: string }> {
    if (!VALID_DECISIONS.has(decision)) {
      return { ok: false, error: `invalid decision (use allow-once | allow-always | deny)` };
    }
    try {
      const raw = await this.connector.call(gatewayId, 'exec.approval.resolve', {
        id: approvalId,
        decision,
      });
      this.audit.append({
        type: 'approval.exec.resolve',
        actorType: 'user',
        actorId,
        gatewayId,
        approvalId,
        sessionKey: null,
        outcome: decision === 'deny' ? 'denied' : 'ok',
        summary: `Resolved exec approval ${approvalId} on ${gatewayId} as ${decision}`,
        details: { decision },
      });
      return { ok: true, raw };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.audit.append({
        type: 'approval.exec.resolve',
        actorType: 'user',
        actorId,
        gatewayId,
        approvalId,
        sessionKey: null,
        outcome: 'error',
        summary: `Failed to resolve exec approval ${approvalId}: ${message}`,
      });
      return { ok: false, error: message };
    }
  }

  async resolveResearch(
    id: string,
    decision: 'approve' | 'reject',
    actorId: string
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    const result = decision === 'approve' ? await this.research.approve(id) : await this.research.reject(id);
    this.audit.append({
      type: 'approval.research.resolve',
      actorType: 'user',
      actorId,
      gatewayId: 'main',
      approvalId: id,
      sessionKey: null,
      outcome: result.ok ? (decision === 'reject' ? 'denied' : 'ok') : 'error',
      summary: result.ok
        ? `Research request ${id} ${decision}d`
        : `Research request ${id} ${decision} failed: ${result.ok === false ? result.error : ''}`,
      details: result.ok ? { stdout: result.stdout } : { error: result.error },
    });
    return result;
  }

  /** Generate a client-side idempotency key for chat.send */
  static newIdempotencyKey(prefix = 'ocp'): string {
    return `${prefix}-${randomUUID()}`;
  }
}
