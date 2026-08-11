import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { GatewayConnector } from '@ocp/gateway-client';
import type { AuditStore } from './audit-store.js';

export type ConfigVersionMeta = {
  id: string;
  gatewayId: string;
  hash: string;
  createdAt: string;
  author: string;
  note: string | null;
  source: 'snapshot' | 'proposed' | 'applied' | 'rollback';
  path: string;
};

/**
 * Configuration management (Phase 7).
 * Live config SoT is OpenClaw on the host bind-mount.
 * Mutations write the host file (RO inside container) — never through agent tools.
 */
export class ConfigService {
  constructor(
    private readonly connector: GatewayConnector,
    private readonly audit: AuditStore,
    private readonly versionsRoot: string,
    private readonly monorepoRoot: string
  ) {
    mkdirSync(versionsRoot, { recursive: true });
  }

  async getLive(gatewayId: string) {
    const gw = this.connector.getGateway(gatewayId);
    const rpc = await this.connector.call<Record<string, unknown>>(gatewayId, 'config.get', {});
    const hostPath = resolve(this.monorepoRoot, gw.configFile);
    let hostRaw: string | null = null;
    let hostHash: string | null = null;
    if (existsSync(hostPath)) {
      hostRaw = readFileSync(hostPath, 'utf8');
      hostHash = sha256(hostRaw);
    }
    return {
      gatewayId,
      hostPath,
      hostExists: Boolean(hostRaw),
      hostHash,
      rpcHash: typeof rpc.hash === 'string' ? rpc.hash : null,
      valid: rpc.valid ?? null,
      issues: rpc.issues ?? [],
      warnings: rpc.warnings ?? [],
      // Prefer redacted/parsed view from gateway; raw host file for operators
      config: rpc.config ?? rpc.parsed ?? null,
      hostRawPreview: hostRaw ? maskSecretsInJsonText(hostRaw).slice(0, 20_000) : null,
      openclawJsonReadOnlyInContainer: true,
      applyMode: 'host-file-write',
    };
  }

  async schemaLookup(gatewayId: string, path: string) {
    return this.connector.call(gatewayId, 'config.schema.lookup', { path });
  }

  listVersions(gatewayId: string): ConfigVersionMeta[] {
    const dir = join(this.versionsRoot, gatewayId);
    if (!existsSync(dir)) return [];
    const indexPath = join(dir, 'index.json');
    if (!existsSync(indexPath)) return [];
    try {
      return JSON.parse(readFileSync(indexPath, 'utf8')) as ConfigVersionMeta[];
    } catch {
      return [];
    }
  }

  /** Snapshot current host file into version history */
  snapshot(gatewayId: string, author: string, note?: string): ConfigVersionMeta {
    const gw = this.connector.getGateway(gatewayId);
    const hostPath = resolve(this.monorepoRoot, gw.configFile);
    if (!existsSync(hostPath)) {
      throw new Error(`Host config not found: ${hostPath}`);
    }
    const raw = readFileSync(hostPath, 'utf8');
    return this.saveVersion(gatewayId, raw, author, 'snapshot', note ?? null);
  }

  /**
   * Propose a full JSON document (must be valid JSON object).
   * Does not apply until applyVersion is called.
   */
  propose(gatewayId: string, document: unknown, author: string, note?: string): ConfigVersionMeta {
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new Error('document must be a JSON object');
    }
    const raw = `${JSON.stringify(document, null, 2)}\n`;
    // basic guardrails
    assertNoSecretsInPlaintext(document);
    return this.saveVersion(gatewayId, raw, author, 'proposed', note ?? null);
  }

  /**
   * Apply a stored version to the host openclaw.json path.
   * Caller should restart/reload gateway after apply.
   */
  applyVersion(
    gatewayId: string,
    versionId: string,
    author: string,
    expectedHostHash?: string | null
  ): { meta: ConfigVersionMeta; hostPath: string; previousHash: string | null } {
    const gw = this.connector.getGateway(gatewayId);
    const hostPath = resolve(this.monorepoRoot, gw.configFile);
    if (!existsSync(hostPath)) throw new Error(`Host config not found: ${hostPath}`);

    const currentRaw = readFileSync(hostPath, 'utf8');
    const currentHash = sha256(currentRaw);
    if (expectedHostHash && expectedHostHash !== currentHash) {
      throw new Error(
        `Concurrent modification: host hash ${currentHash.slice(0, 12)}… != expected ${expectedHostHash.slice(0, 12)}…`
      );
    }

    // Always snapshot pre-apply
    this.saveVersion(gatewayId, currentRaw, author, 'snapshot', 'pre-apply automatic snapshot');

    const versions = this.listVersions(gatewayId);
    const meta = versions.find((v) => v.id === versionId);
    if (!meta) throw new Error(`Unknown version ${versionId}`);
    const nextRaw = readFileSync(meta.path, 'utf8');
    // validate JSON
    const parsed = JSON.parse(nextRaw) as unknown;
    assertNoSecretsInPlaintext(parsed);

    // atomic-ish write
    const tmp = `${hostPath}.ocp-tmp-${process.pid}`;
    writeFileSync(tmp, nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`, 'utf8');
    // backup
    copyFileSync(hostPath, `${hostPath}.ocp-backup`);
    writeFileSync(hostPath, nextRaw.endsWith('\n') ? nextRaw : `${nextRaw}\n`, 'utf8');

    const applied = this.saveVersion(gatewayId, nextRaw, author, 'applied', `applied ${versionId}`);
    this.audit.append({
      type: 'config.apply',
      actorType: 'user',
      actorId: author,
      gatewayId,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `Applied config version ${versionId} to ${gatewayId}`,
      details: {
        versionId,
        previousHash: currentHash,
        newHash: applied.hash,
        hostPath,
        note: 'Gateway may need restart/reload to pick up RO bind-mount changes',
      },
    });

    return { meta: applied, hostPath, previousHash: currentHash };
  }

  rollback(gatewayId: string, author: string): ConfigVersionMeta {
    const versions = this.listVersions(gatewayId).filter((v) => v.source === 'snapshot' || v.source === 'applied');
    if (versions.length < 2) throw new Error('Not enough versions to rollback');
    // newest first in list — we store newest at front
    const previous = versions[1];
    if (!previous) throw new Error('No previous version');
    const result = this.applyVersion(gatewayId, previous.id, author);
    this.audit.append({
      type: 'config.rollback',
      actorType: 'user',
      actorId: author,
      gatewayId,
      approvalId: null,
      sessionKey: null,
      outcome: 'ok',
      summary: `Rolled back ${gatewayId} to version ${previous.id}`,
    });
    return result.meta;
  }

  private saveVersion(
    gatewayId: string,
    raw: string,
    author: string,
    source: ConfigVersionMeta['source'],
    note: string | null
  ): ConfigVersionMeta {
    const dir = join(this.versionsRoot, gatewayId);
    mkdirSync(dir, { recursive: true });
    const hash = sha256(raw);
    const id = randomUUID();
    const path = join(dir, `${id}.json`);
    writeFileSync(path, raw.endsWith('\n') ? raw : `${raw}\n`, 'utf8');
    const meta: ConfigVersionMeta = {
      id,
      gatewayId,
      hash,
      createdAt: new Date().toISOString(),
      author,
      note,
      source,
      path,
    };
    const indexPath = join(dir, 'index.json');
    const existing = this.listVersions(gatewayId);
    const next = [meta, ...existing].slice(0, 50);
    writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return meta;
  }
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function assertNoSecretsInPlaintext(doc: unknown): void {
  const text = JSON.stringify(doc);
  // Block obvious secret material being written via CP forms
  if (/sk-[A-Za-z0-9]{10,}|xoxb-|xapp-|BEGIN PRIVATE KEY|OPENCLAW_GATEWAY_PASSWORD/i.test(text)) {
    throw new Error('Refusing to store obvious secrets in config document via control plane');
  }
}

function maskSecretsInJsonText(raw: string): string {
  return raw
    .replace(/("(?:token|password|secret|apiKey|authToken)"\s*:\s*")([^"]+)(")/gi, '$1***$3')
    .replace(/(sk-[A-Za-z0-9]{8,})/g, 'sk-***');
}
