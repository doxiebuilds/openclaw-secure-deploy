/**
 * The control plane's own Ed25519 device identity.
 *
 * Every Gateway grants operator scopes to *paired devices*, not to bearers of
 * the shared token — Phase 0's `TOKEN_ONLY_CONNECT_HAS_NO_SCOPES` finding was a
 * missing device identity, not an authorization mystery (see
 * scripts/bootstrap/ws-connect-signed.mjs).
 *
 * This keypair is deliberately separate from
 * openclaw-secure-config/identity/device.json: that one belongs to the
 * in-container TUI, and presenting it with different client metadata makes the
 * gateway demand a "metadata-upgrade" repair that would clobber the TUI's
 * record.
 *
 * Pairing is a deliberate, human-run step (scripts/bootstrap/pair-control-plane.mjs).
 * Nothing here silently escalates: an unpaired identity simply fails the
 * handshake with PAIRING_REQUIRED.
 *
 * Never logs private key material or gateway tokens.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
} from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Wire identity of this client. The gateway validates these against a fixed enum. */
export const CLIENT_ID = 'gateway-client';
export const CLIENT_MODE = 'backend';
export const CLIENT_ROLE = 'operator';

/**
 * `operator.admin` is required, not aspirational: the control plane calls
 * config.apply / config.rollback / cron.update, which are admin-scoped. Narrower
 * scope sets fail those routes at the gateway rather than at our boundary.
 */
export const CLIENT_SCOPES = ['operator.admin'] as const;

export type DeviceIdentity = {
  version: number;
  deviceId: string;
  publicKeyPem: string;
  privateKeyPem: string;
  createdAtMs: number;
};

/** The gateway keys devices by sha256 of the raw 32-byte Ed25519 public key. */
function rawPublicKey(publicKeyPem: string): Buffer {
  return createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }).subarray(-32);
}

export function publicKeyB64u(identity: DeviceIdentity): string {
  return rawPublicKey(identity.publicKeyPem).toString('base64url');
}

/**
 * Load the identity, creating a fresh keypair on first use.
 *
 * A newly created identity is unpaired; the first connect returns
 * PAIRING_REQUIRED until an operator approves it inside the container.
 */
export function loadOrCreateIdentity(identityPath: string): DeviceIdentity {
  if (existsSync(identityPath)) {
    const parsed = JSON.parse(readFileSync(identityPath, 'utf8')) as Partial<DeviceIdentity>;
    if (parsed.privateKeyPem && parsed.deviceId && parsed.publicKeyPem) {
      return parsed as DeviceIdentity;
    }
  }

  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

  const identity: DeviceIdentity = {
    version: 1,
    deviceId: createHash('sha256').update(rawPublicKey(publicKeyPem)).digest('hex'),
    publicKeyPem,
    privateKeyPem,
    createdAtMs: Date.now(),
  };

  mkdirSync(dirname(identityPath), { recursive: true });
  // Written 0600 up front, then chmod'd: writeFileSync's mode is subject to
  // umask, so the explicit chmod is what actually guarantees the permissions.
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  chmodSync(identityPath, 0o600);
  return identity;
}

/**
 * Ed25519 signature over the gateway's v2 connect payload.
 *
 * Field order is protocol, not preference — it must match the gateway's
 * verifier exactly:
 *   v2|deviceId|clientId|clientMode|role|scopes_csv|signedAt|token|nonce
 *
 * The nonce comes from the `connect.challenge` event and is mandatory, which is
 * why the challenge must always be awaited before sending connect.
 */
export function signConnect(params: {
  identity: DeviceIdentity;
  token: string;
  nonce: string;
  signedAt: number;
}): string {
  const payload = [
    'v2',
    params.identity.deviceId,
    CLIENT_ID,
    CLIENT_MODE,
    CLIENT_ROLE,
    CLIENT_SCOPES.join(','),
    String(params.signedAt),
    params.token,
    params.nonce,
  ].join('|');

  return edSign(
    null,
    Buffer.from(payload, 'utf8'),
    createPrivateKey(params.identity.privateKeyPem)
  ).toString('base64url');
}
