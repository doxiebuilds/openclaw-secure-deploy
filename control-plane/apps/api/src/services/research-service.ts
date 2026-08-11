import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type {
  ResearchBrief,
  ResearchBriefClaim,
  ResearchRequestSummary,
  ResearchStage,
} from '@ocp/domain';

export type ResearchServiceOptions = {
  /** Absolute path to openclaw-enclave */
  enclaveRoot: string;
  scriptPath?: string;
};

export type ApprovedResearchRequest = {
  requestId: string;
  topicId: string | null;
  query: string | null;
  approvedAtMs: number | null;
};

type LedgerInboxRecord = {
  state?: unknown;
  topic_id?: unknown;
  dispatched_at?: unknown;
  completed_at?: unknown;
};

type LedgerTopicRecord = {
  state?: unknown;
  source_reads_imperative?: unknown;
  last_cause?: unknown;
};

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(id);
}

/** Topic ids come out of files the enclave wrote; they still never reach a path unchecked. */
function isSafeTopicId(id: string): boolean {
  return /^[A-Za-z0-9._-]{1,64}$/.test(id);
}

/**
 * Host-side research request HITL (cross-cell main → scout).
 * Wraps openclaw-enclave/scripts/research-request-mover.sh without reimplementing the gate.
 *
 * Beyond the gate it also *reads* the rest of the exchange, because approving a
 * request used to be the last thing the control plane knew about it: the answer
 * takes three more schedulers (sealer 300s, curator 15m, sealer again) and
 * nothing reported on any of them. probeStage/readBrief close that, and they
 * read only — every write to the exchange still goes through the script.
 */
export class ResearchService {
  private readonly exchangeRoot: string;
  private readonly requestsDir: string;
  private readonly inboxDir: string;
  private readonly rawDir: string;
  private readonly normalizedDir: string;
  private readonly briefsPendingDir: string;
  private readonly briefsDir: string;
  private readonly briefsFlaggedDir: string;
  private readonly ledgerPath: string;
  private readonly scriptPath: string;

  constructor(private readonly options: ResearchServiceOptions) {
    this.exchangeRoot = join(options.enclaveRoot, 'exchange');
    this.requestsDir = join(this.exchangeRoot, 'requests');
    this.inboxDir = join(this.exchangeRoot, 'inbox');
    this.rawDir = join(this.exchangeRoot, 'raw');
    this.normalizedDir = join(this.exchangeRoot, 'normalized');
    this.briefsPendingDir = join(this.exchangeRoot, 'briefs-pending');
    this.briefsDir = join(this.exchangeRoot, 'briefs');
    this.briefsFlaggedDir = join(this.exchangeRoot, 'briefs-flagged');
    this.ledgerPath = join(this.exchangeRoot, 'ledger', 'seal-ledger.json');
    this.scriptPath =
      options.scriptPath ?? join(options.enclaveRoot, 'scripts', 'research-request-mover.sh');
  }

  listPending(): ResearchRequestSummary[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.requestsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    return files.map((file) => {
      const id = file.replace(/\.json$/, '');
      const path = join(this.requestsDir, file);
      let query: string | null = null;
      let topicId: string | null = null;
      let valid = false;
      let validationError: string | null = null;
      let requestedAt: number | null = null;

      try {
        const st = statSync(path);
        requestedAt = st.mtimeMs;
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        query = typeof raw.query === 'string' ? raw.query : null;
        topicId = typeof raw.topic_id === 'string' ? raw.topic_id : null;
        // Lightweight mirror of script validation for UI (script re-validates on approve)
        if (!query || query.length < 1 || query.length > 300) {
          validationError = 'bad-query';
        } else if (!topicId || !/^[A-Za-z0-9._-]{1,64}$/.test(topicId)) {
          validationError = 'bad-topic_id';
        } else if (/[;&|`$(){}<>\n\\]/.test(query) || /https?:\/\//i.test(query)) {
          validationError = 'query:unsafe';
        } else {
          valid = true;
        }
      } catch (err) {
        validationError = err instanceof Error ? err.message : String(err);
      }

      return {
        kind: 'research_request' as const,
        gatewayId: 'main' as const,
        id,
        status: 'pending' as const,
        query,
        topicId,
        valid,
        validationError,
        path,
        requestedAt,
      };
    });
  }

  /**
   * Requests that are past the gate: approved, sitting in exchange/inbox.
   *
   * The tracker adopts these at boot. Without that, a control plane restarted
   * between approval and brief would forget the request entirely — and because
   * `inbox/` retains until archived, the operator would have no signal but the
   * ledger to tell in-flight from long-abandoned.
   */
  listApproved(): ApprovedResearchRequest[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.inboxDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }

    return files.map((file) => {
      const requestId = file.replace(/\.json$/, '');
      const path = join(this.inboxDir, file);
      let topicId: string | null = null;
      let query: string | null = null;
      let approvedAtMs: number | null = null;
      try {
        approvedAtMs = statSync(path).mtimeMs;
        const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        query = typeof raw.query === 'string' ? raw.query : null;
        topicId = typeof raw.topic_id === 'string' ? raw.topic_id : null;
      } catch {
        /* an unreadable request still deserves to be tracked as stalled */
      }
      return { requestId, topicId, query, approvedAtMs };
    });
  }

  /**
   * Where a request has actually got to, computed from disk on every call.
   *
   * Highest stage wins, and the directory checks are ordered accordingly. That
   * ordering is load-bearing: the sealer's phase ④ sweeps a promoted source out
   * of normalized/ into normalized/archive/, so `normalized/<topic>.md` is
   * absent for exactly the requests that are furthest along. Checking briefs
   * first means that disappearance reads as progress, not regression.
   */
  probeStage(topicId: string | null, requestId: string): ResearchStage {
    const ledger = this.readLedger();

    if (topicId && isSafeTopicId(topicId)) {
      if (existsSync(join(this.briefsDir, `${topicId}.json`))) return 'brief_ready';
      if (existsSync(join(this.briefsFlaggedDir, `${topicId}.json`))) return 'brief_flagged';

      const topicRec = ledger.entries[topicId];
      if (typeof topicRec?.state === 'string' && topicRec.state === 'condemned') {
        return 'condemned';
      }

      if (existsSync(join(this.briefsPendingDir, `${topicId}.json`))) return 'distilling';
      if (existsSync(join(this.normalizedDir, `${topicId}.md`))) return 'normalized';
      if (existsSync(join(this.rawDir, `${topicId}.md`))) return 'fetched';
    }

    const inboxRec = ledger.inbox[`${requestId}.json`];
    const state = typeof inboxRec?.state === 'string' ? inboxRec.state : null;
    if (state === 'abandoned') return 'abandoned';
    // `done` means scout's fetch completed. The raw file it produced is normally
    // still on disk and caught above; if the sealer already consumed it and the
    // brief has not landed yet, this is the honest remaining answer.
    if (state === 'done') return 'fetched';
    if (state === 'dispatched') return 'dispatched';
    return 'queued';
  }

  /** The promoted brief for a topic, from briefs/ or briefs-flagged/, or null. */
  readBrief(topicId: string): ResearchBrief | null {
    if (!isSafeTopicId(topicId)) return null;

    const candidates: Array<{ path: string; flagged: boolean }> = [
      { path: join(this.briefsDir, `${topicId}.json`), flagged: false },
      { path: join(this.briefsFlaggedDir, `${topicId}.json`), flagged: true },
    ];

    for (const { path, flagged } of candidates) {
      if (!existsSync(path)) continue;
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      const rawClaims = Array.isArray(doc.claims) ? doc.claims : [];
      const claims: ResearchBriefClaim[] = rawClaims.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const c = entry as Record<string, unknown>;
        if (typeof c.claim !== 'string') return [];
        return [
          {
            claim: c.claim,
            evidenceExcerpt: typeof c.evidence_excerpt === 'string' ? c.evidence_excerpt : null,
            sourceReference: typeof c.source_reference === 'string' ? c.source_reference : null,
          },
        ];
      });

      const topicRec = this.readLedger().entries[topicId];
      return {
        topicId,
        path,
        flagged,
        containsExternalInstructions: doc.contains_external_instructions === true,
        sourceReadsImperative: topicRec?.source_reads_imperative === true,
        sourceId: typeof doc.source_id === 'string' ? doc.source_id : null,
        sourceType: typeof doc.source_type === 'string' ? doc.source_type : null,
        sourceSha256: typeof doc.source_sha256 === 'string' ? doc.source_sha256 : null,
        claims,
      };
    }
    return null;
  }

  /** True once the seal ledger records scout's fetch for this request as finished. */
  isInboxRecordDone(requestId: string): boolean {
    const rec = this.readLedger().inbox[`${requestId}.json`];
    return rec?.state === 'done' || rec?.state === 'abandoned';
  }

  /** True while the request file is still sitting in exchange/inbox. */
  isInInbox(requestId: string): boolean {
    if (!isSafeId(requestId)) return false;
    return existsSync(join(this.inboxDir, `${requestId}.json`));
  }

  async approve(id: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    return this.run('approve', id);
  }

  async reject(id: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    return this.run('reject', id);
  }

  /**
   * Sweep one answered request out of exchange/inbox.
   *
   * The script refuses unless its own ledger says the request reached `done` or
   * `abandoned`, so this cannot discard work in flight — the decision stays in
   * the script, and the control plane only chooses when to ask.
   */
  async archive(id: string): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    return this.run('archive', id);
  }

  private readLedger(): {
    inbox: Record<string, LedgerInboxRecord>;
    entries: Record<string, LedgerTopicRecord>;
  } {
    // Deliberately re-read per call and never cached. The sealer rewrites this
    // file every 300s from another process, and a cache here would show the
    // operator a stage the enclave had already moved past.
    try {
      const doc = JSON.parse(readFileSync(this.ledgerPath, 'utf8')) as Record<string, unknown>;
      return {
        inbox: (doc.inbox && typeof doc.inbox === 'object' ? doc.inbox : {}) as Record<
          string,
          LedgerInboxRecord
        >,
        entries: (doc.entries && typeof doc.entries === 'object' ? doc.entries : {}) as Record<
          string,
          LedgerTopicRecord
        >,
      };
    } catch {
      // Fail-open, matching the sealer's own loader: an unreadable ledger must
      // degrade the stage report, not blank it. The directory checks above
      // still carry the stages that matter most.
      return { inbox: {}, entries: {} };
    }
  }

  private run(
    mode: 'approve' | 'reject' | 'archive',
    id: string
  ): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
    if (!isSafeId(id)) {
      return Promise.resolve({ ok: false, error: `refusing unsafe id: ${id}` });
    }
    return new Promise((resolve) => {
      const child = spawn('sh', [this.scriptPath, mode, id], {
        env: {
          ...process.env,
          ENCLAVE_ROOT: this.options.enclaveRoot,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c: string) => {
        stdout += c;
      });
      child.stderr.on('data', (c: string) => {
        stderr += c;
      });
      child.on('error', (err) => resolve({ ok: false, error: err.message }));
      child.on('close', (code) => {
        if (code === 0) resolve({ ok: true, stdout: (stdout || stderr).trim() });
        else resolve({ ok: false, error: (stderr || stdout || `exit ${code}`).trim() });
      });
    });
  }
}
