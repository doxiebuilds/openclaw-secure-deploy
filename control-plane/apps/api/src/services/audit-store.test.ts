import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { AuditStore } from './audit-store.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('AuditStore', () => {
  it('appends events and supports filters', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocp-audit-'));
    dirs.push(dir);
    const store = new AuditStore(join(dir, 'audit.jsonl'));
    store.append({
      type: 'auth.login',
      actorType: 'user',
      actorId: 'admin',
      gatewayId: null,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: 'login',
    });
    store.append({
      type: 'cron.run',
      actorType: 'user',
      actorId: 'admin',
      gatewayId: 'main',
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: 'ran job',
    });

    const all = store.list({ limit: 10 });
    expect(all.totalMatched).toBe(2);
    expect(all.integrity.chainOk).toBe(true);

    const filtered = store.list({ gatewayId: 'main' });
    expect(filtered.totalMatched).toBe(1);
    expect(filtered.items[0]?.type).toBe('cron.run');

    const search = store.list({ q: 'login' });
    expect(search.totalMatched).toBe(1);
  });

  it('retains newest events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ocp-audit-'));
    dirs.push(dir);
    const path = join(dir, 'audit.jsonl');
    const store = new AuditStore(path);
    for (let i = 0; i < 5; i++) {
      store.append({
        type: `t.${i}`,
        actorType: 'system',
        actorId: null,
        gatewayId: null,
        approvalId: null,
        sessionKey: null,
        outcome: 'info',
        summary: `event ${i}`,
      });
    }
    const result = store.retain(2);
    expect(result.kept).toBe(2);
    expect(result.archived).toBe(3);
    const remaining = readFileSync(path, 'utf8').trim().split('\n');
    expect(remaining.length).toBe(2);
  });
});
