import type { ExecApprovalSummary } from '@ocp/domain';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function pickString(...values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNumber(...values: unknown[]): number | null {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return null;
}

/**
 * Normalize heterogeneous exec.approval.list payload shapes into fleet summaries.
 * Observed shapes may be a bare array or { approvals: [] } / { items: [] }.
 */
export function mapExecApprovalList(gatewayId: string, payload: unknown): ExecApprovalSummary[] {
  let rows: unknown[] = [];
  if (Array.isArray(payload)) {
    rows = payload;
  } else {
    const root = asRecord(payload);
    if (Array.isArray(root?.approvals)) rows = root.approvals as unknown[];
    else if (Array.isArray(root?.items)) rows = root.items as unknown[];
    else if (Array.isArray(root?.pending)) rows = root.pending as unknown[];
  }

  return rows
    .map((item) => asRecord(item))
    .filter((item): item is UnknownRecord => Boolean(item))
    .map((row) => {
      const tool = asRecord(row.toolCall) || asRecord(row.tool_call) || asRecord(row.tool);
      const request = asRecord(row.request) || asRecord(row.payload) || row;
      const rawInput = asRecord(tool?.rawInput) || asRecord(tool?.raw_input) || asRecord(request?.rawInput);

      const command = pickString(
        rawInput?.command,
        request?.command,
        row.command,
        typeof rawInput?.args === 'string' ? rawInput.args : null
      );
      const toolName = pickString(tool?.name, tool?.toolName, request?.toolName, row.toolName, row.tool);
      const title = pickString(tool?.title, request?.title, row.title, toolName);
      const description = pickString(
        rawInput?.description,
        request?.description,
        row.description,
        row.reason
      );

      const id = pickString(row.id, row.approvalId, row.approval_id, request?.id) || '';
      const sessionKey = pickString(row.sessionKey, row.session_key, request?.sessionKey);
      const agentId =
        pickString(row.agentId, row.agent_id, request?.agentId) ||
        (sessionKey?.startsWith('agent:') ? sessionKey.split(':')[1] || null : null);

      return {
        kind: 'exec' as const,
        gatewayId,
        id,
        status: 'pending' as const,
        requestedAt: pickNumber(row.createdAt, row.created_at, row.requestedAt, row.ts, row.timestamp),
        agentId,
        sessionKey,
        toolName,
        title,
        description,
        command,
        riskHint: command
          ? command.length > 120
            ? 'long-command'
            : /rm\s|curl\s|wget\s|chmod\s|sudo|ssh\s/i.test(command)
              ? 'sensitive-pattern'
              : 'exec'
          : toolName || 'unknown',
        raw: row,
      };
    })
    .filter((a) => a.id.length > 0);
}
