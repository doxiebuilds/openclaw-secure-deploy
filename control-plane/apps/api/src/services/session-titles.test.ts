import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SessionTitleStore,
  deriveTitleFromHistory,
  deriveTitleFromMessage,
  fallbackTitleFromKey,
} from './session-titles.js';

let dir: string;
let storePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ocp-titles-'));
  storePath = join(dir, 'session-titles.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('deriveTitleFromMessage', () => {
  it('uses the first meaningful line', () => {
    expect(deriveTitleFromMessage('Fix the approvals page\n\nMore detail here')).toBe(
      'Fix the approvals page'
    );
  });

  it('strips markdown chrome', () => {
    expect(deriveTitleFromMessage('## Plan the migration')).toBe('Plan the migration');
    expect(deriveTitleFromMessage('- check the sealer logs')).toBe('check the sealer logs');
    expect(deriveTitleFromMessage('1. restart the gateway')).toBe('restart the gateway');
    expect(deriveTitleFromMessage('**bold** opener')).toBe('bold opener');
  });

  it('skips a leading code fence', () => {
    expect(deriveTitleFromMessage('```bash\nnpm run dev\n```')).toBe('npm run dev');
  });

  it('truncates on a word boundary', () => {
    const long = `${'word '.repeat(40)}`;
    const title = deriveTitleFromMessage(long)!;
    expect(title.length).toBeLessThanOrEqual(73);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toContain('wor…');
  });

  it('returns null for a message with nothing in it', () => {
    expect(deriveTitleFromMessage('   \n\n  ')).toBeNull();
  });
});

describe('deriveTitleFromHistory', () => {
  it('reads the first user turn, string content', () => {
    const history = {
      messages: [
        { role: 'system', content: 'you are an agent' },
        { role: 'user', content: 'Audit the exec approvals' },
        { role: 'assistant', content: 'Sure' },
      ],
    };
    expect(deriveTitleFromHistory(history)).toBe('Audit the exec approvals');
  });

  it('reads block-shaped content', () => {
    const history = {
      messages: [{ role: 'human', content: [{ type: 'text', text: 'Why did the sealer stall?' }] }],
    };
    expect(deriveTitleFromHistory(history)).toBe('Why did the sealer stall?');
  });

  it('returns null when there is no user turn', () => {
    expect(deriveTitleFromHistory({ messages: [{ role: 'assistant', content: 'hi' }] })).toBeNull();
    expect(deriveTitleFromHistory(null)).toBeNull();
  });
});

describe('fallbackTitleFromKey', () => {
  it('reads an agent-scoped key as agent + short id', () => {
    expect(fallbackTitleFromKey('agent:main:6f2b91c4-9d1a-4f6e-b0f2-77c1a2b3c4d5')).toBe('main · 6f2b91c4');
  });

  it('passes anything else through', () => {
    expect(fallbackTitleFromKey('cron-nightly')).toBe('cron-nightly');
  });
});

describe('SessionTitleStore', () => {
  it('never shows the connecting client name as a title', () => {
    const store = new SessionTitleStore(storePath);
    expect(store.resolve('main', 'agent:main:abcdef12-0000', 'openclaw-control-plane')).toBe(
      'main · abcdef12'
    );
    expect(store.resolve('main', 'agent:main:abcdef12-0000', 'openclaw-control-plane/1.0.0')).toBe(
      'main · abcdef12'
    );
  });

  it('keeps a real gateway label when there is one', () => {
    const store = new SessionTitleStore(storePath);
    expect(store.resolve('main', 'agent:main:abcdef12', 'Slack #ops')).toBe('Slack #ops');
  });

  it('titles from the first message and does not re-title afterwards', () => {
    const store = new SessionTitleStore(storePath);
    store.setFromFirstMessage('main', 'k', 'Investigate the drift check');
    store.setFromFirstMessage('main', 'k', 'and now something completely different');
    expect(store.resolve('main', 'k')).toBe('Investigate the drift check');
  });

  it('lets a manual rename win, and an empty one reset', () => {
    const store = new SessionTitleStore(storePath);
    store.setFromFirstMessage('main', 'agent:main:abcdef12', 'auto name');
    store.set('main', 'agent:main:abcdef12', 'Nightly triage', 'manual');
    expect(store.get('main', 'agent:main:abcdef12')).toMatchObject({
      title: 'Nightly triage',
      source: 'manual',
    });

    store.set('main', 'agent:main:abcdef12', '', 'manual');
    expect(store.get('main', 'agent:main:abcdef12')).toBeNull();
    expect(store.resolve('main', 'agent:main:abcdef12')).toBe('main · abcdef12');
  });

  it('survives a restart', () => {
    new SessionTitleStore(storePath).set('main', 'k', 'Persisted title', 'manual');
    expect(new SessionTitleStore(storePath).resolve('main', 'k')).toBe('Persisted title');
  });

  it('keeps gateways apart', () => {
    const store = new SessionTitleStore(storePath);
    store.set('main', 'k', 'Main side', 'manual');
    store.set('scout', 'k', 'Scout side', 'manual');
    expect(store.resolve('main', 'k')).toBe('Main side');
    expect(store.resolve('scout', 'k')).toBe('Scout side');
  });
});
