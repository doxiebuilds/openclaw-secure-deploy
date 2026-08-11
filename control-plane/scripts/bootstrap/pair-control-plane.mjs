/**
 * Pair the control plane's device identity with each Gateway, end to end.
 *
 * Pairing requests expire (~5 min), so triggering a request and approving it
 * from separate shells races the TTL. This does both per gateway in one pass:
 *
 *   1. connect with the signed device identity  -> PAIRING_REQUIRED + requestId
 *   2. docker exec <container> device.pair.approve --params {requestId}
 *   3. reconnect                                 -> hello-ok, scopes, deviceToken
 *
 * Step 2 grants operator scopes to a host process, which is why it lives in a
 * script you run deliberately rather than in the API's startup path.
 *
 * Usage:  node scripts/bootstrap/pair-control-plane.mjs [--dry-run] [--gateway main]
 *
 * The device keypair is created on first use by ws-connect-signed.mjs and lives
 * at control-plane/data/device-identity.json (0600, gitignored). Re-running is
 * safe: an already-paired gateway short-circuits at step 1 with hello-ok.
 *
 * Never prints tokens or private key material.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const controlPlaneRoot = path.resolve(here, '../..');
const secretsDir = path.join(process.env.HOME || '', '.openclaw-secrets');
const identityPath =
  process.env.CONTROL_PLANE_DEVICE_IDENTITY ?? path.join(controlPlaneRoot, 'data', 'device-identity.json');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ONLY = args.includes('--gateway') ? args[args.indexOf('--gateway') + 1] : null;

const CLIENT_ID = 'gateway-client';
const CLIENT_MODE = 'backend';
const ROLE = 'operator';
const SCOPES = ['operator.admin'];
const CHALLENGE_WAIT_MS = 5_000;
const HANDSHAKE_TIMEOUT_MS = 15_000;

const FLEET = [
  { id: 'main', port: 18789, container: 'openclaw', secrets: 'openclaw-secrets.json' },
  { id: 'scout', port: 18829, container: 'openclaw-scout', secrets: 'scout-secrets.json' },
  { id: 'curator', port: 18869, container: 'openclaw-curator', secrets: 'curator-secrets.json' },
];

function tokenOf(file) {
  const d = JSON.parse(fs.readFileSync(path.join(secretsDir, file), 'utf8'));
  const token = d.gateway?.authToken || d['gateway/authToken'];
  if (!token) throw new Error(`no gateway.authToken in ${file}`);
  return token;
}

function rawPublicKey(pem) {
  return crypto.createPublicKey(pem).export({ type: 'spki', format: 'der' }).subarray(-32);
}

function loadIdentity() {
  if (!fs.existsSync(identityPath)) {
    throw new Error(`no device identity at ${identityPath} — run ws-connect-signed.mjs once to create it`);
  }
  return JSON.parse(fs.readFileSync(identityPath, 'utf8'));
}

/** One connect attempt. Resolves with either hello-ok details or a pairing request id. */
function connectOnce(gw, identity, token) {
  const publicKeyB64u = rawPublicKey(identity.publicKeyPem).toString('base64url');

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gw.port}`);
    let settled = false;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(hard);
      clearTimeout(challenge);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve(r);
    };

    const hard = setTimeout(() => finish({ status: 'error', error: 'handshake timeout' }), HANDSHAKE_TIMEOUT_MS);
    const challenge = setTimeout(
      () => finish({ status: 'error', error: 'no connect.challenge received' }),
      CHALLENGE_WAIT_MS
    );

    ws.addEventListener('error', (e) => finish({ status: 'error', error: String(e?.message || e) }));
    ws.addEventListener('close', (e) => finish({ status: 'error', error: `socket closed (${e?.code})` }));

    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        clearTimeout(challenge);
        const nonce = msg.payload?.nonce ?? msg.payload?.challenge ?? msg.nonce;
        const signedAt = Date.now();
        const payload = [
          'v2',
          identity.deviceId,
          CLIENT_ID,
          CLIENT_MODE,
          ROLE,
          SCOPES.join(','),
          String(signedAt),
          token,
          nonce,
        ].join('|');
        const signature = crypto
          .sign(null, Buffer.from(payload, 'utf8'), crypto.createPrivateKey(identity.privateKeyPem))
          .toString('base64url');

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
              device: { id: identity.deviceId, publicKey: publicKeyB64u, signature, signedAt, nonce },
            },
          })
        );
        return;
      }

      if (msg.type === 'res' && msg.id === 'c1') {
        if (msg.ok) {
          const p = msg.payload || {};
          finish({
            status: 'paired',
            scopes: p.auth?.scopes ?? [],
            role: p.auth?.role ?? null,
            deviceTokenIssued: Boolean(p.auth?.deviceToken),
            protocol: p.protocol ?? null,
            serverVersion: p.server?.version ?? null,
          });
          return;
        }
        const err = msg.error ?? {};
        const details = err.details ?? msg.details ?? {};
        if (details.code === 'PAIRING_REQUIRED' && details.requestId) {
          finish({ status: 'pairing_required', requestId: details.requestId, reason: details.reason ?? null });
          return;
        }
        finish({ status: 'error', error: (typeof err === 'string' ? err : JSON.stringify(err)).slice(0, 300) });
      }
    });
  });
}

/**
 * Approve via the dedicated `openclaw devices approve` CLI.
 *
 * The raw `gateway call device.pair.approve` RPC is refused here: a bare
 * `gateway call` authenticates with the shared token alone, and approving a
 * pairing needs operator.pairing — the scope the paired Control UI device holds
 * and a token-only connect does not. (Note `device.pair.reject` *is* permitted
 * that way; denying access is less privileged than granting it.) The `devices`
 * subcommand goes through the CLI's own device auth instead.
 */
async function approve(gw, requestId) {
  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(
      'docker',
      ['exec', gw.container, 'openclaw', 'devices', 'approve', requestId, '--json', '--timeout', '20000'],
      { timeout: 30_000 }
    ));
  } catch (err) {
    // execFile's message is just "Command failed"; the reason is on stderr.
    const detail = [err.stderr, err.stdout].filter(Boolean).join(' ').trim();
    throw new Error(detail || err.message);
  }

  const text = stdout.trim();
  if (!text) return { ok: true };
  try {
    const parsed = JSON.parse(text);
    if (parsed.ok === false) {
      throw new Error(parsed.error?.message ?? JSON.stringify(parsed.error ?? parsed));
    }
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) return { ok: true, raw: text.slice(0, 200) };
    throw err;
  }
}

const identity = loadIdentity();
console.log(`device identity: ${identityPath}`);
console.log(`deviceId:        ${identity.deviceId}\n`);

let failures = 0;
for (const gw of FLEET) {
  if (ONLY && gw.id !== ONLY) continue;

  process.stdout.write(`${gw.id.padEnd(8)} `);
  let token;
  try {
    token = tokenOf(gw.secrets);
  } catch (err) {
    console.log(`SKIP  ${err.message}`);
    failures += 1;
    continue;
  }

  const first = await connectOnce(gw, identity, token);

  if (first.status === 'paired') {
    console.log(`already paired  scopes=${JSON.stringify(first.scopes)} deviceToken=${first.deviceTokenIssued}`);
    continue;
  }

  if (first.status !== 'pairing_required') {
    console.log(`FAIL  ${first.error}`);
    failures += 1;
    continue;
  }

  if (first.reason && first.reason !== 'not-paired') {
    // A "metadata-upgrade" repair would rewrite an existing device's record.
    console.log(`REFUSE  reason=${first.reason} (would modify an existing paired device) requestId=${first.requestId}`);
    failures += 1;
    continue;
  }

  if (DRY_RUN) {
    console.log(`would approve requestId=${first.requestId} (reason=${first.reason})`);
    continue;
  }

  process.stdout.write(`approving ${first.requestId.slice(0, 8)}… `);
  try {
    await approve(gw, first.requestId);
  } catch (err) {
    console.log(`FAIL\n    ${String(err.message).replace(/\s+/g, ' ').slice(0, 400)}`);
    console.log(`    approve it manually instead:`);
    console.log(`      Control UI  http://127.0.0.1:${gw.port}  (device ${first.requestId})`);
    console.log(`      or          docker exec ${gw.container} openclaw devices approve ${first.requestId}`);
    failures += 1;
    continue;
  }

  const second = await connectOnce(gw, identity, token);
  if (second.status === 'paired') {
    console.log(`OK  scopes=${JSON.stringify(second.scopes)} deviceToken=${second.deviceTokenIssued} proto=${second.protocol}`);
  } else {
    console.log(`FAIL after approve: ${second.error ?? second.status}`);
    failures += 1;
  }
}

if (DRY_RUN) {
  console.log('\ndry run — nothing was approved. Re-run without --dry-run to pair.');
} else {
  console.log(failures === 0 ? '\nall gateways paired' : `\n${failures} gateway(s) not paired`);
}
process.exit(failures === 0 ? 0 : 1);
