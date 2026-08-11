import { describe, expect, it } from 'vitest';
import { blocksToPlainText, parseContent, renderContent } from './messageContent';


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

describe('parseContent', () => {
  it('classifies a thinking block as reasoning, not text', () => {
    const [block] = parseContent([THINKING]);
    expect(block).toEqual({ kind: 'thinking', text: THINKING.thinking });
  });

  it('classifies a tool call and pretty-prints its arguments', () => {
    const [block] = parseContent([TOOL_CALL]);
    expect(block).toMatchObject({ kind: 'toolCall', name: 'read', id: '892919169' });
    expect(block.kind === 'toolCall' && block.args).toContain('"path"');
    expect(block.kind === 'toolCall' && block.args).toContain('dispatch-research/SKILL.md');
  });

  it('marks a tool result carrying an error as failed', () => {
    const [block] = parseContent(TOOL_ERROR);
    expect(block).toMatchObject({ kind: 'toolResult', ok: false, tool: 'read' });
    expect(block.kind === 'toolResult' && block.text).toContain('ENOENT');
  });

  it('leaves plain text alone', () => {
    expect(parseContent([{ type: 'text', text: 'Submitted.' }])).toEqual([{ kind: 'text', text: 'Submitted.' }]);
    expect(parseContent('Submitted.')).toEqual([{ kind: 'text', text: 'Submitted.' }]);
  });

  it('splits a mixed assistant turn into ordered blocks', () => {
    const blocks = parseContent([THINKING, { type: 'text', text: 'Reading the skill.' }, TOOL_CALL]);
    expect(blocks.map((b) => b.kind)).toEqual(['thinking', 'text', 'toolCall']);
  });

  it('accepts the tool_use / nested toolCall spellings', () => {
    expect(parseContent([{ type: 'tool_use', name: 'write', input: { path: '/tmp/x' } }])[0]).toMatchObject({
      kind: 'toolCall',
      name: 'write',
    });
    expect(parseContent([{ toolCall: { name: 'edit', arguments: { file: 'a.ts' } } }])[0]).toMatchObject({
      kind: 'toolCall',
      name: 'edit',
    });
  });

  it('reads reasoning blocks that use the `reasoning` key', () => {
    expect(parseContent([{ type: 'reasoning', reasoning: 'Weighing options.' }])[0]).toEqual({
      kind: 'thinking',
      text: 'Weighing options.',
    });
  });

  it('recovers arguments sent as a JSON string', () => {
    const [block] = parseContent([{ type: 'toolCall', name: 'read', arguments: '{"path":"/a/b"}' }]);
    expect(block.kind === 'toolCall' && block.args).toContain('"/a/b"');
  });

  it('keeps a truncated partialArgs string rather than showing nothing', () => {
    const [block] = parseContent([{ type: 'toolCall', name: 'read', partialArgs: '{"path":"/a' }]);
    expect(block.kind === 'toolCall' && block.args).toBe('{"path":"/a');
  });

  it('tags an unknown shape instead of passing it off as prose', () => {
    const [block] = parseContent([{ type: 'something_new', payload: 42 }]);
    expect(block).toMatchObject({ kind: 'unknown', type: 'something_new' });
    expect(block.kind === 'unknown' && block.json).toContain('42');
  });

  it('drops empty and null content', () => {
    expect(parseContent(null)).toEqual([]);
    expect(parseContent([])).toEqual([]);
    expect(parseContent(['   '])).toEqual([]);
  });
});

describe('blocksToPlainText', () => {
  it('labels reasoning and tool calls so a copied transcript stays complete', () => {
    const text = blocksToPlainText(parseContent([THINKING, TOOL_CALL, TOOL_ERROR]));
    expect(text).toContain('[thinking]');
    expect(text).toContain('[tool: read]');
    expect(text).toContain('error');
    expect(text).toContain('ENOENT');
  });

  it('renderContent no longer emits raw block JSON', () => {
    const text = renderContent([THINKING, TOOL_CALL]);
    expect(text).not.toContain('"type":"thinking"');
    expect(text).not.toContain('"partialArgs"');
  });
});
