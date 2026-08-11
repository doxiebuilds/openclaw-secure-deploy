import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AuditEvent } from '@ocp/domain';

export type AuditQuery = {
  limit?: number;
  type?: string;
  gatewayId?: string;
  actorId?: string;
  outcome?: string;
  q?: string;
  since?: string;
  until?: string;
};

export type AuditListResult = {
  items: AuditEvent[];
  totalMatched: number;
  integrity: {
    chainOk: boolean;
    eventsChecked: number;
    brokenAtId: string | null;
  };
};

/**
 * Append-only JSONL audit with optional hash-chain fields (Phase 5).
 * Each line may include prevHash + eventHash for integrity verification.
 */
export class AuditStore {
  private lastHash: string | null = null;

  constructor(private readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
    if (!existsSync(filePath)) {
      writeFileSync(filePath, '', 'utf8');
    }
    this.lastHash = this.readLastHash();
  }

  static defaultPath(cwd = process.cwd()): string {
    return join(cwd, 'data', 'audit.jsonl');
  }

  append(
    partial: Omit<AuditEvent, 'id' | 'ts'> & { id?: string; ts?: string }
  ): AuditEvent {
    const event: AuditEvent = {
      id: partial.id ?? randomUUID(),
      ts: partial.ts ?? new Date().toISOString(),
      type: partial.type,
      actorType: partial.actorType,
      actorId: partial.actorId,
      gatewayId: partial.gatewayId,
      approvalId: partial.approvalId,
      sessionKey: partial.sessionKey,
      outcome: partial.outcome,
      summary: partial.summary,
      details: redactDetails(partial.details),
    };

    const prevHash = this.lastHash;
    const eventHash = hashEvent(event, prevHash);
    const line = JSON.stringify({ ...event, prevHash, eventHash });
    appendFileSync(this.filePath, `${line}\n`, 'utf8');
    this.lastHash = eventHash;
    return event;
  }

  list(query: AuditQuery = {}): AuditListResult {
    const all = this.readAll();
    const integrity = verifyChain(all);
    let filtered = all.map(({ event }) => event);

    if (query.type) {
      const t = query.type.toLowerCase();
      filtered = filtered.filter((e) => e.type.toLowerCase().includes(t));
    }
    if (query.gatewayId) {
      filtered = filtered.filter((e) => e.gatewayId === query.gatewayId);
    }
    if (query.actorId) {
      filtered = filtered.filter((e) => e.actorId === query.actorId);
    }
    if (query.outcome) {
      filtered = filtered.filter((e) => e.outcome === query.outcome);
    }
    if (query.since) {
      const since = Date.parse(query.since);
      if (!Number.isNaN(since)) filtered = filtered.filter((e) => Date.parse(e.ts) >= since);
    }
    if (query.until) {
      const until = Date.parse(query.until);
      if (!Number.isNaN(until)) filtered = filtered.filter((e) => Date.parse(e.ts) <= until);
    }
    if (query.q) {
      const q = query.q.toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.summary.toLowerCase().includes(q) ||
          e.type.toLowerCase().includes(q) ||
          (e.actorId || '').toLowerCase().includes(q) ||
          (e.gatewayId || '').toLowerCase().includes(q) ||
          (e.approvalId || '').toLowerCase().includes(q) ||
          (e.sessionKey || '').toLowerCase().includes(q)
      );
    }

    const limit = Math.min(Math.max(query.limit ?? 100, 1), 1000);
    const items = filtered.slice().reverse().slice(0, limit);
    return {
      items,
      totalMatched: filtered.length,
      integrity: {
        chainOk: integrity.ok,
        eventsChecked: integrity.checked,
        brokenAtId: integrity.brokenAtId,
      },
    };
  }

  /** Keep newest `keep` events; rotate older lines to .archive.jsonl */
  retain(keep = 5000): { kept: number; archived: number } {
    const all = this.readAll();
    if (all.length <= keep) return { kept: all.length, archived: 0 };
    const archivedRows = all.slice(0, all.length - keep);
    const keptRows = all.slice(all.length - keep);
    const archivePath = `${this.filePath}.archive`;
    const archiveBody = archivedRows.map((r) => JSON.stringify(r.raw)).join('\n') + '\n';
    appendFileSync(archivePath, archiveBody, 'utf8');
    writeFileSync(this.filePath, keptRows.map((r) => JSON.stringify(r.raw)).join('\n') + '\n', 'utf8');
    this.lastHash = this.readLastHash();
    return { kept: keptRows.length, archived: archivedRows.length };
  }

  private readAll(): Array<{ event: AuditEvent; raw: Record<string, unknown> }> {
    const raw = readFileSync(this.filePath, 'utf8');
    if (!raw.trim()) return [];
    const out: Array<{ event: AuditEvent; raw: Record<string, unknown> }> = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        out.push({
          raw: obj,
          event: {
            id: String(obj.id),
            ts: String(obj.ts),
            type: String(obj.type),
            actorType: obj.actorType as AuditEvent['actorType'],
            actorId: (obj.actorId as string | null) ?? null,
            gatewayId: (obj.gatewayId as string | null) ?? null,
            approvalId: (obj.approvalId as string | null) ?? null,
            sessionKey: (obj.sessionKey as string | null) ?? null,
            outcome: obj.outcome as AuditEvent['outcome'],
            summary: String(obj.summary),
            details: obj.details,
          },
        });
      } catch {
        /* skip */
      }
    }
    return out;
  }

  private readLastHash(): string | null {
    const all = this.readAll();
    if (!all.length) return null;
    const last = all[all.length - 1]!.raw;
    return typeof last.eventHash === 'string' ? last.eventHash : null;
  }
}

function hashEvent(event: AuditEvent, prevHash: string | null): string {
  const payload = JSON.stringify({
    id: event.id,
    ts: event.ts,
    type: event.type,
    actorType: event.actorType,
    actorId: event.actorId,
    gatewayId: event.gatewayId,
    approvalId: event.approvalId,
    sessionKey: event.sessionKey,
    outcome: event.outcome,
    summary: event.summary,
    prevHash,
  });
  return createHash('sha256').update(payload).digest('hex');
}

function verifyChain(
  rows: Array<{ event: AuditEvent; raw: Record<string, unknown> }>
): { ok: boolean; checked: number; brokenAtId: string | null } {
  let prev: string | null = null;
  let checked = 0;
  for (const row of rows) {
    const expected = hashEvent(row.event, prev);
    const actual = typeof row.raw.eventHash === 'string' ? row.raw.eventHash : null;
    // Events without eventHash (pre-phase5) are accepted but don't extend chain verification
    if (!actual) {
      prev = null;
      continue;
    }
    checked += 1;
    if (actual !== expected) {
      return { ok: false, checked, brokenAtId: row.event.id };
    }
    const recordedPrev = (row.raw.prevHash as string | null) ?? null;
    if (recordedPrev !== prev && !(prev === null && recordedPrev === null)) {
      // first event after legacy rows may have prev null
      if (!(prev === null)) {
        return { ok: false, checked, brokenAtId: row.event.id };
      }
    }
    prev = actual;
  }
  return { ok: true, checked, brokenAtId: null };
}

function redactDetails(details: unknown): unknown {
  if (!details || typeof details !== 'object') return details;
  const out: Record<string, unknown> = { ...(details as Record<string, unknown>) };
  for (const key of Object.keys(out)) {
    if (/token|password|secret|authorization|private/i.test(key)) {
      out[key] = 'REDACTED';
    }
  }
  return out;
}

// silence unused rename import if not used
void renameSync;
