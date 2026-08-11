import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type ApiConfig = {
  host: string;
  port: number;
  authDisabled: boolean;
  adminUsername: string;
  adminPassword: string;
  sessionTtlMs: number;
  fleetPath: string | undefined;
  corsOrigin: string;
  enclaveRoot: string;
  monorepoRoot: string;
  auditPath: string;
  configVersionsPath: string;
  /**
   * Gap between background fleet sweeps.
   *
   * Since gateway events drive updates, this is only a safety net for state no
   * event announces — not the mechanism the UI depends on for freshness.
   */
  snapshotRefreshMs: number;
  auditRetention: number;
  loginMaxAttempts: number;
  loginWindowMs: number;
  rpcLog: boolean;
  /**
   * RPC transport. `persistent` holds one device-paired WebSocket per gateway;
   * `docker-exec` is the legacy per-call `docker exec` path, kept as an escape
   * hatch for when a gateway's pairing is being re-established.
   */
  connectorMode: 'persistent' | 'docker-exec';
  /** Control plane's own Ed25519 device keypair (0600, gitignored). */
  deviceIdentityPath: string;
  /** Directory holding per-gateway `*-secrets.json`. */
  secretsDir: string;

  /**
   * Operator-facing conversation names, keyed by gateway + session key.
   *
   * The Gateway has no rename RPC and labels sessions with the client that
   * opened them, so titles are control-plane state — see services/session-titles.ts.
   */
  sessionTitlesPath: string;

  /** Durable record of approved research requests still making their way through the exchange. */
  researchTrackingPath: string;
  /**
   * Gap between exchange sweeps.
   *
   * Cheap — a handful of `stat` calls and one small JSON read — so this is
   * tuned for how quickly a finished brief should surface, not for load. The
   * stages it watches advance on 300s and 15m schedules, so anything under a
   * minute is already far finer-grained than the pipeline itself.
   */
  researchPollMs: number;
  /** How long a request may stay non-terminal before the tracker calls it out. */
  researchStaleAfterMs: number;
  /** How long settled tracker records are kept. */
  researchRetentionMs: number;
  /** Post a notice into a gateway session when a brief is promoted. */
  researchDeliverToSession: boolean;
  /** Sweep answered requests out of exchange/inbox once their brief lands. */
  researchAutoArchive: boolean;
  /** Gateway that owns the research loop (writes requests, reads briefs). */
  researchGatewayId: string;
  /**
   * Where briefs appear INSIDE the agent's container — these are the paths the
   * notice quotes, and they are mount destinations, not host paths. `main` maps
   * <enclave>/exchange/briefs{,-flagged} to these, read-only.
   */
  researchBriefContainerDir: string;
  researchBriefFlaggedContainerDir: string;
};

function envFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const v = value.toLowerCase();
  if (v === 'off' || v === 'false' || v === '0' || v === 'no') return false;
  if (v === 'on' || v === 'true' || v === '1' || v === 'yes') return true;
  return fallback;
}

function detectMonorepoRoot(envRoot?: string): string {
  if (envRoot && existsSync(envRoot)) return resolve(envRoot);
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/api/src -> control-plane -> openclaw
  const candidates = [
    join(here, '../../../..'),
    join(process.cwd(), '../..'),
    join(process.cwd(), '..'),
    process.cwd(),
  ];
  for (const c of candidates) {
    const resolved = resolve(c);
    if (existsSync(join(resolved, 'openclaw-enclave')) && existsSync(join(resolved, 'control-plane'))) {
      return resolved;
    }
  }
  return resolve(join(here, '../../../..'));
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const authMode = (env.CONTROL_PLANE_AUTH ?? 'on').toLowerCase();
  const monorepoRoot = detectMonorepoRoot(env.CONTROL_PLANE_MONOREPO_ROOT);
  const enclaveRoot = env.CONTROL_PLANE_ENCLAVE_ROOT
    ? resolve(env.CONTROL_PLANE_ENCLAVE_ROOT)
    : join(monorepoRoot, 'openclaw-enclave');
  const dataRoot = env.CONTROL_PLANE_DATA_DIR
    ? resolve(env.CONTROL_PLANE_DATA_DIR)
    : join(process.cwd(), 'data');

  return {
    host: env.CONTROL_PLANE_HOST ?? '127.0.0.1',
    port: Number(env.CONTROL_PLANE_PORT ?? '8787'),
    authDisabled: authMode === 'off' || authMode === 'false' || authMode === '0',
    adminUsername: env.CONTROL_PLANE_USER ?? 'admin',
    adminPassword: env.CONTROL_PLANE_PASSWORD ?? 'admin',
    sessionTtlMs: Number(env.CONTROL_PLANE_SESSION_TTL_MS ?? String(12 * 60 * 60 * 1000)),
    fleetPath: env.CONTROL_PLANE_FLEET_PATH,
    corsOrigin: env.CONTROL_PLANE_CORS_ORIGIN ?? 'http://127.0.0.1:5173',
    enclaveRoot,
    monorepoRoot,
    auditPath: env.CONTROL_PLANE_AUDIT_PATH ?? join(dataRoot, 'audit.jsonl'),
    configVersionsPath: env.CONTROL_PLANE_CONFIG_VERSIONS ?? join(dataRoot, 'config-versions'),
    // Over docker-exec a full sweep cost ~30s, which is why this used to be
    // tuned as "the gap between sweeps that keeps the fleet from saturating".
    // Over the persistent connector a sweep is 18 multiplexed RPCs and costs
    // well under a second, and events cover the fast path regardless — so this
    // is now a slow reconciliation pass, not the freshness mechanism.
    snapshotRefreshMs: Number(env.CONTROL_PLANE_SNAPSHOT_REFRESH_MS ?? '15000'),
    auditRetention: Number(env.CONTROL_PLANE_AUDIT_RETENTION ?? '5000'),
    loginMaxAttempts: Number(env.CONTROL_PLANE_LOGIN_MAX_ATTEMPTS ?? '8'),
    loginWindowMs: Number(env.CONTROL_PLANE_LOGIN_WINDOW_MS ?? String(15 * 60 * 1000)),
    rpcLog: (env.CONTROL_PLANE_RPC_LOG ?? 'on').toLowerCase() !== 'off',
    connectorMode:
      (env.CONTROL_PLANE_CONNECTOR ?? 'persistent').toLowerCase() === 'docker-exec'
        ? 'docker-exec'
        : 'persistent',
    // Deliberately NOT under `dataRoot`: that is cwd-relative, so running the
    // API from apps/api rather than control-plane/ would mint a second, unpaired
    // keypair while the pairing script kept using the first — a silent
    // split-brain that presents as "pairing did nothing". The pairing script
    // resolves this same path from its own location, so both must agree
    // regardless of cwd.
    deviceIdentityPath:
      env.CONTROL_PLANE_DEVICE_IDENTITY ??
      join(monorepoRoot, 'control-plane', 'data', 'device-identity.json'),
    secretsDir: env.CONTROL_PLANE_SECRETS_DIR ?? join(env.HOME ?? '', '.openclaw-secrets'),

    sessionTitlesPath: env.CONTROL_PLANE_SESSION_TITLES ?? join(dataRoot, 'session-titles.json'),

    researchTrackingPath:
      env.CONTROL_PLANE_RESEARCH_TRACKING ?? join(dataRoot, 'research-tracking.json'),
    researchPollMs: Number(env.CONTROL_PLANE_RESEARCH_POLL_MS ?? '20000'),
    // The pipeline's worst case is ~25 minutes (sealer 300s + curator 15m +
    // sealer 300s), so this sits comfortably past it: late enough not to cry
    // wolf over an ordinary slow run, early enough to beat the operator asking.
    researchStaleAfterMs: Number(env.CONTROL_PLANE_RESEARCH_STALE_MS ?? String(45 * 60 * 1000)),
    researchRetentionMs: Number(
      env.CONTROL_PLANE_RESEARCH_RETENTION_MS ?? String(14 * 24 * 60 * 60 * 1000)
    ),
    researchDeliverToSession: envFlag(env.CONTROL_PLANE_RESEARCH_DELIVER, true),
    researchAutoArchive: envFlag(env.CONTROL_PLANE_RESEARCH_AUTO_ARCHIVE, true),
    researchGatewayId: env.CONTROL_PLANE_RESEARCH_GATEWAY ?? 'main',
    researchBriefContainerDir:
      env.CONTROL_PLANE_RESEARCH_BRIEF_DIR ?? '/home/node/exchange/briefs',
    researchBriefFlaggedContainerDir:
      env.CONTROL_PLANE_RESEARCH_BRIEF_FLAGGED_DIR ?? '/home/node/exchange/briefs-flagged',
  };
}
