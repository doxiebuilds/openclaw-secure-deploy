import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthUser } from '@ocp/domain';
import type { ApiConfig } from './config.js';

type Session = {
  token: string;
  user: AuthUser;
  expiresAt: number;
};

const sessions = new Map<string, Session>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    const filler = Buffer.alloc(ba.length);
    timingSafeEqual(ba, filler);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

export function login(
  config: ApiConfig,
  username: string,
  password: string
): { ok: true; token: string; user: AuthUser } | { ok: false; code: string } {
  const userOk = safeEqual(username, config.adminUsername);
  const passOk = safeEqual(password, config.adminPassword);
  if (!userOk || !passOk) {
    return { ok: false, code: 'invalid_credentials' };
  }
  const token = randomBytes(32).toString('base64url');
  const user: AuthUser = {
    id: 'local-admin',
    username: config.adminUsername,
    roles: ['admin', 'operator', 'approver', 'viewer'],
  };
  sessions.set(hashToken(token), {
    token,
    user,
    expiresAt: Date.now() + config.sessionTtlMs,
  });
  return { ok: true, token, user };
}

export function logout(token: string | null | undefined): void {
  if (!token) return;
  sessions.delete(hashToken(token));
}

export function resolveUser(config: ApiConfig, token: string | null | undefined): AuthUser | null {
  if (config.authDisabled) {
    return {
      id: 'dev',
      username: 'dev',
      roles: ['admin', 'operator', 'approver', 'viewer'],
    };
  }
  if (!token) return null;
  const session = sessions.get(hashToken(token));
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(hashToken(token));
    return null;
  }
  return session.user;
}
