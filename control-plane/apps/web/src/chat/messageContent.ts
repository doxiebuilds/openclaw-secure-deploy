export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'toolCall'; name: string; id: string | null; args: string | null }
  | { kind: 'toolResult'; ok: boolean; tool: string | null; text: string }
  | { kind: 'unknown'; type: string | null; json: string };

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Pretty-print tool arguments, tolerating the JSON-string form some gateways send. */
function formatArgs(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      // `partialArgs` on a streamed call is a truncated JSON string; showing it
      // as-is beats showing nothing while the call is still arriving.
      return trimmed;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parsePart(part: unknown): ContentBlock | null {
  if (typeof part === 'string') {
    return part.trim() ? { kind: 'text', text: part } : null;
  }

  const p = asRecord(part);
  if (!p) return part == null ? null : { kind: 'text', text: String(part) };

  const type = str(p.type);

  // Reasoning. `thinking` is the OpenClaw/Anthropic shape; `reasoning` and
  // `redacted_thinking` show up from other backends and mean the same thing to
  // a reader.
  const thinking = str(p.thinking) ?? str(p.reasoning);
  if (type === 'thinking' || type === 'reasoning' || type === 'redacted_thinking' || thinking) {
    const text = thinking ?? str(p.text) ?? '';
    return text.trim() ? { kind: 'thinking', text } : null;
  }

  // Tool invocation. Matched structurally as well as by `type`, because the
  // same block arrives as `tool_use` from some backends and as a bare
  // `{name, arguments}` from others.
  const nested = asRecord(p.toolCall) ?? asRecord(p.tool_call);
  const call = nested ?? p;
  const callName = str(call.name) ?? str(call.toolName) ?? str(call.tool);
  const rawArgs = call.arguments ?? call.args ?? call.input ?? call.partialArgs;
  if (type === 'toolCall' || type === 'tool_use' || type === 'tool_call' || nested || (callName && rawArgs !== undefined)) {
    if (callName) {
      return {
        kind: 'toolCall',
        name: callName,
        id: str(call.id) ?? str(call.toolCallId) ?? null,
        args: formatArgs(rawArgs),
      };
    }
  }

  // Tool result. An error result is the one an operator most needs to see, so
  // success is inferred conservatively: anything carrying `error` is a failure.
  const errorText = str(p.error);
  if (
    type === 'toolResult' ||
    type === 'tool_result' ||
    errorText ||
    (p.status !== undefined && p.tool !== undefined)
  ) {
    const ok = !errorText && str(p.status) !== 'error' && p.isError !== true;
    const text =
      errorText ??
      str(p.result) ??
      str(p.output) ??
      str(p.content) ??
      str(p.text) ??
      formatArgs(p.result ?? p.output ?? p.content) ??
      '';
    return { kind: 'toolResult', ok, tool: str(p.tool) ?? str(p.name), text };
  }

  const text = str(p.text) ?? str(p.content);
  if (text) return text.trim() ? { kind: 'text', text } : null;

  // Genuinely unrecognised. Pretty-printed rather than minified, and tagged so
  // the UI can present it as "we don't know this shape" instead of as prose.
  return { kind: 'unknown', type, json: JSON.stringify(p, null, 2) };
}

/** Split a message's content into renderable blocks. */
export function parseContent(content: unknown): ContentBlock[] {
  if (content == null) return [];
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      const block = parsePart(part);
      return block ? [block] : [];
    });
  }
  const block = parsePart(content);
  return block ? [block] : [];
}

/**
 * Flatten blocks back to plain text, for the copy button.
 *
 * Reasoning and tool calls are labelled rather than dropped: someone copying a
 * transcript to paste into an issue wants the whole sequence, not just the
 * prose.
 */
export function blocksToPlainText(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      switch (b.kind) {
        case 'text':
          return b.text;
        case 'thinking':
          return `[thinking]\n${b.text}`;
        case 'toolCall':
          return `[tool: ${b.name}]${b.args ? `\n${b.args}` : ''}`;
        case 'toolResult':
          return `[tool result${b.tool ? ` · ${b.tool}` : ''}${b.ok ? '' : ' · error'}]\n${b.text}`;
        case 'unknown':
          return b.json;
      }
    })
    .join('\n\n');
}

/** Plain-text rendering of raw content. Kept for callers that only need a string. */
export function renderContent(content: unknown): string {
  return blocksToPlainText(parseContent(content));
}
