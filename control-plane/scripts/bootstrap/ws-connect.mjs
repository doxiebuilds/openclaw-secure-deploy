#!/usr/bin/env node
/**
 * Phase 0 host-side WebSocket connect experiment.
 *
 * Proves that:
 *  1. Host can open ws://127.0.0.1:{18789,18829,18869}
 *  2. connect.challenge + connect handshake with gateway token succeeds
 *  3. Token-only host clients do NOT receive operator scopes on this deployment
 *     (method calls fail with "missing scope: operator.read")
 *
 * In-container `openclaw gateway call` remains the reliable Phase 0 probe path.
 * Phase 1 must implement device identity + pairing (or an equivalent trusted
 * host client path) before the control plane can use host WebSocket RPCs.
 *
 * Usage:
 *   node control-plane/scripts/bootstrap/ws-connect.mjs
 *
 * Never prints tokens. Writes redacted summary to fixtures/ws-connect-latest.json
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const secretsDir = path.join(os.homedir(), '.openclaw-secrets');
const fixturesDir = path.join(__dirname, 'fixtures');

const fleet = [
  { id: 'main', port: 18789, file: 'openclaw-secrets.json' },
  { id: 'scout', port: 18829, file: 'scout-secrets.json' },
  { id: 'curator', port: 18869, file: 'curator-secrets.json' },
];

/** @param {string} file */
function tokenOf(file) {
  const full = path.join(secretsDir, file);
  if (!fs.existsSync(full)) {
    throw new Error(`missing secrets file: ${full}`);
  }
  const d = JSON.parse(fs.readFileSync(full, 'utf8'));
  const token = d.gateway?.authToken || d['gateway/authToken'];
  if (!token) throw new Error(`no gateway.authToken in ${file}`);
  return token;
}

/**
 * @param {{ id: string, port: number, file: string }} gw
 */
function connectOnce(gw) {
  const token = tokenOf(gw.file);
  const url = `ws://127.0.0.1:${gw.port}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    const timeout = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ id: gw.id, connectOk: false, error: 'timeout' });
    }, 15000);

    /** @param {unknown} result */
    const finish = (result) => {
      clearTimeout(timeout);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(result);
    };

    ws.addEventListener('error', (e) => {
      finish({ id: gw.id, connectOk: false, error: String(/** @type {Error} */ (e).message || e) });
    });

    ws.addEventListener('message', (ev) => {
      /** @type {any} */
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        // Allowed client.id values are a fixed enum (cli | webchat | gateway-client | …).
        // Allowed client.mode values: ui | cli | node | backend | probe (not "operator").
        // Token-only connect may succeed then fail RPCs with missing scopes, or fail
        // outright with "device identity required" depending on gateway policy.
        ws.send(
          JSON.stringify({
            type: 'req',
            id: 'c1',
            method: 'connect',
            params: {
              minProtocol: 4,
              maxProtocol: 4,
              client: {
                id: 'cli',
                version: '0.0.1',
                platform: process.platform === 'darwin' ? 'macos' : process.platform,
                mode: 'cli',
              },
              role: 'operator',
              scopes: ['operator.read', 'operator.write', 'operator.approvals', 'operator.admin'],
              caps: ['tool-events', 'exec-approvals', 'approvals'],
              auth: { token },
              userAgent: 'openclaw-cp-phase0/0.0.1',
            },
          })
        );
        return;
      }

      if (msg.type === 'res' && msg.id === 'c1') {
        if (!msg.ok) {
          finish({ id: gw.id, connectOk: false, error: msg.error });
          return;
        }
        const p = msg.payload || {};
        const methods = p.features?.methods || [];
        const events = p.features?.events || [];

        const want = [
          'health',
          'status',
          'agents.list',
          'sessions.list',
          'sessions.subscribe',
          'chat.history',
          'chat.send',
          'cron.list',
          'cron.status',
          'cron.add',
          'cron.update',
          'cron.run',
          'cron.runs',
          'exec.approval.list',
          'exec.approval.resolve',
          'exec.approvals.get',
          'config.get',
          'config.schema',
          'config.schema.lookup',
          'config.patch',
          'config.apply',
          'tasks.list',
        ];

        const methodPresence = Object.fromEntries(want.map((m) => [m, methods.includes(m)]));

        // Probe agents.list to detect empty scopes
        ws.send(JSON.stringify({ type: 'req', id: 'a1', method: 'agents.list', params: {} }));

        const onRpc = (ev2) => {
          /** @type {any} */
          let m2;
          try {
            m2 = JSON.parse(String(ev2.data));
          } catch {
            return;
          }
          if (m2.type !== 'res' || m2.id !== 'a1') return;
          ws.removeEventListener('message', onRpc);

          finish({
            id: gw.id,
            connectOk: true,
            protocol: p.protocol,
            serverVersion: p.server?.version ?? null,
            scopesGranted: p.auth?.scopes ?? [],
            role: p.auth?.role ?? null,
            methodsCount: methods.length,
            eventsCount: events.length,
            methodPresence,
            agentsListOk: Boolean(m2.ok),
            agentsListError: m2.error?.message || m2.error || null,
            agentCount: m2.payload?.agents?.length ?? null,
            finding:
              !m2.ok && String(m2.error?.message || '').includes('missing scope')
                ? 'TOKEN_ONLY_CONNECT_HAS_NO_SCOPES'
                : m2.ok
                  ? 'SCOPES_WORK'
                  : 'AGENTS_LIST_FAILED',
            eventsSample: events
              .filter((e) => /approval|session|cron|agent|health|presence|chat|connect/.test(e))
              .sort(),
          });
        };
        ws.addEventListener('message', onRpc);
      }
    });
  });
}

const results = [];
for (const gw of fleet) {
  try {
    results.push(await connectOnce(gw));
  } catch (e) {
    results.push({ id: gw.id, connectOk: false, error: String(/** @type {Error} */ (e).message || e) });
  }
}

fs.mkdirSync(fixturesDir, { recursive: true });
const outPath = path.join(fixturesDir, 'ws-connect-latest.json');
const report = {
  generatedAt: new Date().toISOString(),
  note: 'Host token-only WebSocket experiment. See PHASE0_PROTOCOL.md.',
  results,
  summary: {
    allConnectOk: results.every((r) => r.connectOk),
    allScopesWork: results.every((r) => r.finding === 'SCOPES_WORK'),
    findings: [...new Set(results.map((r) => r.finding).filter(Boolean))],
  },
};
fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
console.log(`wrote ${outPath}`);
process.exit(report.summary.allConnectOk ? 0 : 1);
