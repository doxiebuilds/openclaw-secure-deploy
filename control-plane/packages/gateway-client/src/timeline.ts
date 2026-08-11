import type { TimelineEvent } from '@ocp/domain';

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as UnknownRecord) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One content part as a line of summary text.
 *
 * The previous fallback was `JSON.stringify(part)` for anything without `.text`
 * or `.content` — which is every reasoning block and every tool call, i.e. most
 * of an agent transcript. Those got dumped raw into the timeline. Naming them
 * costs four branches and makes the summary readable; `JSON.stringify` stays
 * for shapes we genuinely do not know, where the raw object is the honest
 * answer rather than the default one.
 *
 * Deliberately parallel to (not shared with) apps/web/src/chat/messageContent.ts:
 * the web app does not depend on this package, and the two have different jobs —
 * that one builds renderable blocks, this one builds a one-line summary.
 */
function partToText(part: unknown): string {
  if (typeof part === 'string') return part;
  const p = asRecord(part);
  if (!p) return part == null ? '' : String(part);

  const type = str(p.type);

  const thinking = str(p.thinking) ?? str(p.reasoning);
  if (thinking) return `(thinking) ${thinking}`;

  const nested = asRecord(p.toolCall) ?? asRecord(p.tool_call);
  const call = nested ?? p;
  const callName = str(call.name) ?? str(call.toolName) ?? str(call.tool);
  const rawArgs = call.arguments ?? call.args ?? call.input ?? call.partialArgs;
  if (callName && (type === 'toolCall' || type === 'tool_use' || type === 'tool_call' || nested || rawArgs !== undefined)) {
    const args = rawArgs === undefined ? '' : typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
    return `→ ${callName}(${args})`;
  }

  const error = str(p.error);
  if (error) return `✗ ${str(p.tool) ?? 'tool'}: ${error}`;

  const text = str(p.text) ?? str(p.content) ?? str(p.result) ?? str(p.output);
  if (text) return text;

  return JSON.stringify(part);
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(partToText)
      .filter((line) => line.trim())
      .join('\n');
  }
  if (content == null) return '';
  return partToText(content);
}

/** Build a simple execution timeline from chat.history messages. */
export function buildTimelineFromHistory(history: unknown): TimelineEvent[] {
  const root = asRecord(history);
  const messages = (root?.messages as unknown[]) || [];
  const events: TimelineEvent[] = [];

  messages.forEach((msg, index) => {
    const m = asRecord(msg);
    if (!m) return;
    const role = typeof m.role === 'string' ? m.role : typeof m.type === 'string' ? m.type : null;
    const text = contentToText(m.content ?? m.text ?? m.message);
    const toolName =
      typeof m.toolName === 'string'
        ? m.toolName
        : typeof m.name === 'string'
          ? m.name
          : asRecord(m.toolCall)?.name;

    let kind = 'message';
    if (role === 'tool' || m.type === 'tool' || m.type === 'tool_result') kind = 'tool';
    else if (role === 'assistant') kind = 'assistant';
    else if (role === 'user') kind = 'user';
    else if (role === 'system') kind = 'system';

    const summary =
      kind === 'tool'
        ? `Tool${toolName ? ` ${toolName}` : ''}: ${text.slice(0, 200)}`
        : text.slice(0, 280) || `(${role || 'event'})`;

    events.push({
      id: String(m.id ?? m.messageId ?? `${index}`),
      ts: typeof m.timestamp === 'number' ? m.timestamp : typeof m.ts === 'number' ? m.ts : null,
      role,
      kind,
      summary,
      raw: m,
    });
  });

  return events;
}
