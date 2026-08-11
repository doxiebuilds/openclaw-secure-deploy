import { describe, expect, it } from 'vitest';
import { buildTimelineFromHistory } from './timeline.js';

/**
 * The blocks below are copied from a real `main` transcript — the one where a
 * user asked for the NYC forecast and every reasoning block and tool call was
 * rendered into the conversation as raw JSON. They are the regression.
 */
const THINKING = {
  type: 'thinking',
  thinking: 'The user is asking me to search the web for weather in NYC.\nI have no web tools.',
};

const TOOL_CALL = {
  type: 'toolCall',
  id: '892919169',
  name: 'read',
  arguments: { path: '/app/skills/dispatch-research/SKILL.md' },
  partialArgs: '{"path":"/app/skills/dispatch-research/SKILL.md"}',
};

const TOOL_ERROR = {
  status: 'error',
  tool: 'read',
  error: "ENOENT: no such file or directory, access '/app/skills/dispatch-research/SKILL.md'",
};

function summaries(messages: unknown[]): string[] {
  return buildTimelineFromHistory({ messages }).map((e) => e.summary);
}

describe('buildTimelineFromHistory', () => {
  it('names a thinking block instead of dumping its JSON', () => {
    const [summary] = summaries([{ role: 'assistant', content: [THINKING] }]);
    expect(summary).toContain('(thinking)');
    expect(summary).toContain('asking me to search the web');
    expect(summary).not.toContain('"type"');
    expect(summary).not.toContain('{');
  });

  it('renders a tool call as a call, not as an object literal', () => {
    const [summary] = summaries([{ role: 'assistant', content: [TOOL_CALL] }]);
    expect(summary).toContain('→ read(');
    expect(summary).toContain('dispatch-research/SKILL.md');
    expect(summary).not.toContain('"partialArgs"');
    expect(summary).not.toContain('"type":"toolCall"');
  });

  it('surfaces a failed tool result as an error line', () => {
    const [summary] = summaries([{ role: 'tool', content: [TOOL_ERROR] }]);
    expect(summary).toContain('✗ read:');
    expect(summary).toContain('ENOENT');
  });

  it('keeps ordinary text untouched', () => {
    const [summary] = summaries([
      { role: 'assistant', content: [{ type: 'text', text: "I've submitted a research request." }] },
    ]);
    expect(summary).toBe("I've submitted a research request.");
  });

  it('handles a mixed assistant turn the way the transcript actually arrives', () => {
    const [summary] = summaries([
      { role: 'assistant', content: [THINKING, { type: 'text', text: 'Let me read the skill.' }, TOOL_CALL] },
    ]);
    const lines = summary.split('\n');
    expect(lines[0]).toContain('(thinking)');
    expect(lines).toContain('Let me read the skill.');
    expect(summary).toContain('→ read(');
  });

  it('still shows an unrecognised block rather than swallowing it', () => {
    const [summary] = summaries([{ role: 'assistant', content: [{ type: 'something_new', payload: 42 }] }]);
    expect(summary).toContain('something_new');
    expect(summary).toContain('42');
  });

  it('tolerates the tool_use / tool_call spellings from other backends', () => {
    expect(summaries([{ role: 'assistant', content: [{ type: 'tool_use', name: 'write', input: { path: '/tmp/x' } }] }])[0]).toContain(
      '→ write('
    );
    expect(
      summaries([{ role: 'assistant', content: [{ toolCall: { name: 'edit', arguments: { file: 'a.ts' } } }] }])[0]
    ).toContain('→ edit(');
  });

  it('reads reasoning blocks that use the `reasoning` key', () => {
    expect(summaries([{ role: 'assistant', content: [{ type: 'reasoning', reasoning: 'Weighing options.' }] }])[0]).toContain(
      '(thinking) Weighing options.'
    );
  });
});
