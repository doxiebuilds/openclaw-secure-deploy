import { randomUUID } from 'node:crypto';
import type { ChatSendResult } from '@ocp/domain';
import { buildTimelineFromHistory } from '@ocp/gateway-client';
import type { GatewayConnector } from '@ocp/gateway-client';
import type { AuditStore } from './audit-store.js';

export class SessionService {
  constructor(
    private readonly connector: GatewayConnector,
    private readonly audit: AuditStore
  ) {}

  async getDetail(gatewayId: string, sessionKey: string, historyLimit = 80) {
    const [historyRes, describeRes] = await Promise.all([
      this.connector.tryCall(gatewayId, 'chat.history', { sessionKey, limit: historyLimit }),
      this.connector.tryCall(gatewayId, 'sessions.describe', { key: sessionKey }),
    ]);

    const history = historyRes.ok ? historyRes.data : null;
    const timeline = history ? buildTimelineFromHistory(history) : [];
    const describe = describeRes.ok ? describeRes.data : null;

    return {
      gatewayId,
      sessionKey,
      history,
      timeline,
      describe,
      historyError: historyRes.ok ? null : historyRes.error,
      describeError: describeRes.ok ? null : describeRes.error,
      projectedAt: new Date().toISOString(),
    };
  }

  async sendMessage(
    gatewayId: string,
    sessionKey: string,
    message: string,
    actorId: string,
    idempotencyKey?: string
  ): Promise<ChatSendResult> {
    const key = idempotencyKey || `ocp-${randomUUID()}`;
    const raw = await this.connector.call<Record<string, unknown>>(gatewayId, 'chat.send', {
      sessionKey,
      message,
      idempotencyKey: key,
    });

    this.audit.append({
      type: 'session.chat.send',
      actorType: 'user',
      actorId,
      gatewayId,
      approvalId: null,
      sessionKey,
      outcome: 'ok',
      summary: `Sent message to ${sessionKey} on ${gatewayId}`,
      details: {
        runId: raw?.runId ?? raw?.run_id ?? null,
        status: raw?.status ?? null,
        idempotencyKey: key,
        messageChars: message.length,
      },
    });

    return {
      gatewayId,
      sessionKey,
      runId: typeof raw?.runId === 'string' ? raw.runId : typeof raw?.run_id === 'string' ? raw.run_id : key,
      status: typeof raw?.status === 'string' ? raw.status : null,
      raw,
    };
  }
}
