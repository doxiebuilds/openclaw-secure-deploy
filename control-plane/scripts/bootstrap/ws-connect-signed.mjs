/**
 * Phase 1 spike: host WebSocket connect with a signed Ed25519 device identity.
 *
 * Phase 0 concluded TOKEN_ONLY_CONNECT_HAS_NO_SCOPES and inferred that a
 * host-side connector was blocked on an unknown pairing scheme. That inference
 * was wrong: ws-connect.mjs sends `auth: { token }` with no device identity and
 * no signature, so the gateway had nothing to bind scopes to. It still
 * advertised all 236 methods, which made it look like an authorization mystery.
 *
 * Protocol, confirmed empirically against openclaw 2026.7.1 (the shape was led
 * by the OpenClaw remote-agent connect contract, then narrowed by reading this
 * gateway's own schema-validation errors):
 *
 *   params.auth   = { token }
 *   params.device = { id, publicKey, signature, signedAt, nonce }   // all required
 *
 *   id        = sha256(raw 32-byte Ed25519 public key), hex     [verified]
 *   publicKey = base64url(raw 32-byte public key), unpadded
 *   nonce     = from the `connect.challenge` event; NOT optional, so the
 *               challenge must always be awaited (v1/unsigned-nonce is rejected)
 *   signature = Ed25519 over
 *               v2|id|clientId|clientMode|role|scopes_csv|signedAt|token|nonce
 *
 * The control plane keeps its OWN keypair. Do not reuse
 * openclaw-secure-config/identity/device.json — that is the in-container TUI's
 * identity, and presenting it with different client metadata makes the gateway
 * demand a "metadata-upgrade" repair that would clobber the TUI's record.
 *
 * Read-only against the fleet apart from the pairing request a first connect
 * necessarily creates. Never prints tokens or private key material.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const controlPlaneRoot = path.resolve(here, '../..');
const secretsDir = path.join(process.env.HOME || '', '.openclaw-secrets');
const identityPath =
  process.env.CONTROL_PLANE_DEVICE_IDENTITY ?? path.join(controlPlaneRoot, 'data', 'device-identity.json');

const CHALLENGE_WAIT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.admin'];

const FLEET = [
  { id: 'main', port: 18789, secrets: 'openclaw-secrets.json' },
  { id: 'scout', port: 18829, secrets: 'scout-secrets.json' },
  { id: 'curator', port: 18869, secrets: 'curator-secrets.json' },
];

function tokenOf(file) {
  const full = path.join(secretsDir, file);
  if (!fs.existsSync(full)) throw new Error(`missing secrets file: ${full}`);
  const d = JSON.parse(fs.readFileSync(full, 'utf8'));
  const token = d.gateway?.authToken || d['gateway/authToken'];
  if (!token) throw new Error(`no gateway.authToken in ${file}`);
  return token;
}

function rawPublicKey(publicKeyPem) {
  return crypto.createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32);
}

/** Load the control plane's own device identity, creating it on first run. */
function loadOrCreateIdentity() {
  if (fs.existsSync(identityPath)) {
    const d = JSON.parse(fs.readFileSync(identityPath, 'utf8'));
    if (d.privateKeyPem && d.deviceId) return d;
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const raw = rawPublicKey(publicKeyPem);

  const identity = {
    version: 1,
    deviceId: crypto.createHash('sha256').update(raw).digest('hex'),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };

  fs.mkdirSync(path.dirname(identityPath), { recursive: true });
  fs.writeFileSync(identityPath, JSON.stringify(identity, null, 2), { mode: 0o600 });
  fs.chmodSync(identityPath, 0o600);
  console.log(`[identity] created new control-plane device identity at ${identityPath}`);
  console.log(`[identity] deviceId=${identity.deviceId}`);
  return identity;
}

function signConnect({ privateKeyPem, deviceId, token, nonce, signedAt }) {
  const payload = [
    'v2',
    deviceId,
    CLIENT_ID,
    CLIENT_MODE,
    ROLE,
    SCOPES.join(','),
    String(signedAt),
    token,
    nonce,
  ].join('|');
  return crypto
    .sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(privateKeyPem))
    .toString('base64url');
}

function probe(gw, identity) {
  let token;
  try {
    token = tokenOf(gw.secrets);
  } catch (err) {
    return Promise.resolve({ id: gw.id, ok: false, stage: 'token', error: String(err.message || err) });
  }

  const publicKeyB64u = rawPublicKey(identity.publicKeyPem).toString('base64url');

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`);
    const result = { id: gw.id, ok: false, stage: 'connect' };
    let settled = false;
    let rpcSeq = 0;
    const pending = new Map();

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      clearTimeout(challengeTimer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ ...result, ...extra });
    };

    const hardTimeout = setTimeout(
      () => finish({ error: `handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms` }),
      HANDSHAKE_TIMEOUT_MS
    );
    // The gateway requires a nonce, so a missing challenge is fatal, not a fallback.
    const challengeTimer = setTimeout(
      () => finish({ stage: 'challenge', error: 'no connect.challenge received' }),
      CHALLENGE_WAIT_MS
    );

    const call = (method) =>
      new Promise((res) => {
        const id = `r${++rpcSeq}`;
        pending.set(id, res);
        ws.send(JSON.stringify({ type: 'req', id, method, params: {} }));
        setTimeout(() => {
          if (pending.delete(id)) res({ ok: false, error: 'rpc timeout' });
        }, 8000);
      });

    ws.addEventListener('error', (e) => finish({ error: String(e?.message || e) }));
    ws.addEventListener('close', (e) =>
      finish({ error: `socket closed (${e?.code}) ${e?.reason || ''}`.trim() })
    );

    ws.addEventListener('message', async (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        clearTimeout(challengeTimer);
        result.challengeReceived = true;
        const nonce = msg.payload?.nonce ?? msg.payload?.challenge ?? msg.nonce;
        const signedAt = Date.now();
        ws.send(
          JSON.stringify({
            type: 'req',
            id: 'c1',
            method: 'connect',
            params: {
              minProtocol: 3,
              maxProtocol: 4,
              client: {
                id: CLIENT_ID,
                displayName: 'openclaw-control-plane',
                version: '0.0.1',
                platform: process.platform === 'darwin' ? 'macos' : process.platform,
                mode: CLIENT_MODE,
              },
              role: ROLE,
              scopes: SCOPES,
              caps: ['tool-events'],
              auth: { token },
              device: {
                id: identity.deviceId,
                publicKey: publicKeyB64u,
                signature: signConnect({
                  privateKeyPem: identity.privateKeyPem,
                  deviceId: identity.deviceId,
                  token,
                  nonce,
                  signedAt,
                }),
                signedAt,
                nonce,
              },
            },
          })
        );
        return;
      }

      if (msg.type === 'res' && msg.id === 'c1') {
        if (!msg.ok) {
          const err = msg.error ?? {};
          const details = err.details ?? msg.details ?? {};
          const text = typeof err === 'string' ? err : JSON.stringify(err);
          finish({
            stage: 'hello',
            pairingRequired: details.code === 'PAIRING_REQUIRED' || /pairing.?required/i.test(text),
            pairingReason: details.reason ?? null,
            requestId: details.requestId ?? null,
            error: text.slice(0, 300),
          });
          return;
        }

        const p = msg.payload || {};
        const granted = p.auth?.scopes ?? [];
        result.stage = 'rpc';
        result.protocol = p.protocol ?? null;
        result.serverVersion = p.server?.version ?? null;
        result.role = p.auth?.role ?? null;
        result.scopesGranted = granted;
        result.deviceTokenIssued = Boolean(p.auth?.deviceToken);
        result.methodsCount = (p.features?.methods || []).length;

        const t0 = Date.now();
        const agentsRes = await call('agents.list');
        const agentsMs = Date.now() - t0;
        const t1 = Date.now();
        const approvalsRes = await call('exec.approval.list');
        const approvalsMs = Date.now() - t1;

        finish({
          ok: granted.length > 0 && agentsRes.ok && approvalsRes.ok,
          agentsListOk: agentsRes.ok,
          agentsListError: agentsRes.ok ? null : agentsRes.error,
          agentsListMs: agentsMs,
          approvalsListOk: approvalsRes.ok,
          approvalsListError: approvalsRes.ok ? null : approvalsRes.error,
          approvalsListMs: approvalsMs,
        });
        return;
      }

      if (msg.type === 'res' && pending.has(msg.id)) {
        const res = pending.get(msg.id);
        pending.delete(msg.id);
        res(msg.ok ? { ok: true } : { ok: false, error: String(msg.error ?? 'unknown').slice(0, 200) });
      }
    });
  });
}

const identity = loadOrCreateIdentity();
console.log(`[identity] deviceId=${identity.deviceId}\n`);

const results = [];
for (const gw of FLEET) {
  // Sequential: these gateways serialise hard under concurrent load.
  results.push(await probe(gw, identity));
}

const outDir = path.join(here, 'fixtures');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'ws-connect-signed-latest.json'),
  JSON.stringify(
    {
      ranAt: new Date().toISOString(),
      deviceId: identity.deviceId,
      note: 'Host WS connect with signed Ed25519 device identity (control-plane own keypair).',
      results,
    },
    null,
    2
  )
);

for (const r of results) {
  console.log(
    `${r.ok ? 'PASS' : 'FAIL'} ${r.id}: stage=${r.stage} challenge=${r.challengeReceived ?? false} ` +
      `scopes=${JSON.stringify(r.scopesGranted ?? [])} deviceToken=${r.deviceTokenIssued ?? '-'} ` +
      `agents.list=${r.agentsListOk ?? '-'}${r.agentsListMs !== undefined ? ` (${r.agentsListMs}ms)` : ''} ` +
      `approvals=${r.approvalsListOk ?? '-'}${r.approvalsListMs !== undefined ? ` (${r.approvalsListMs}ms)` : ''}` +
      `${r.pairingRequired ? ` PAIRING_REQUIRED reason=${r.pairingReason} requestId=${r.requestId}` : ''}` +
      `${!r.ok && !r.pairingRequired && r.error ? ` err=${r.error}` : ''}`
  );
}
