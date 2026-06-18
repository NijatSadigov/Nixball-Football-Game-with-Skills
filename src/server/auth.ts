// Passwordless auth: email magic links + stateless signed session cookies.
// No passwords stored; sessions are an HMAC-signed `accountId.expiry`.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config';
import { consumeLoginToken, saveLoginToken, upsertAccount } from './db';
import { sendMagicLink } from './mailer';

const TOKEN_TTL_MS = 30 * 60 * 1000; // magic link valid 30 min
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // session valid 30 days
export const SESSION_COOKIE = 'nb_session';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 200;
}

function sign(data: string): string {
  return createHmac('sha256', config.sessionSecret).update(data).digest('base64url');
}

export function makeSession(accountId: number): string {
  const exp = Date.now() + SESSION_TTL_MS;
  const body = `${accountId}.${exp}`;
  return `${body}.${sign(body)}`;
}

export function verifySession(cookie: string | undefined): number | null {
  if (!cookie) return null;
  const parts = cookie.split('.');
  if (parts.length !== 3) return null;
  const [idStr, expStr, sig] = parts;
  const body = `${idStr}.${expStr}`;
  const expected = sign(body);
  // constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(expStr) < Date.now()) return null;
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

export function sessionCookieFrom(header: string | undefined): number | null {
  return verifySession(parseCookies(header)[SESSION_COOKIE]);
}

// Create + email a magic link for this address.
export async function requestMagicLink(rawEmail: string): Promise<void> {
  const email = rawEmail.trim().toLowerCase();
  if (!isValidEmail(email)) throw new Error('invalid email');
  const token = randomBytes(32).toString('base64url');
  await saveLoginToken(token, email, new Date(Date.now() + TOKEN_TTL_MS));
  const link = `${config.publicBaseUrl}/api/auth/verify?token=${token}`;
  await sendMagicLink(email, link);
}

// Verify a magic-link token; returns a session cookie value (or null).
export async function verifyMagicLink(token: string): Promise<string | null> {
  if (!token || token.length > 100) {
    console.log('magic link verify failed: malformed token');
    return null;
  }
  const result = await consumeLoginToken(token);
  if (!result.ok) {
    console.log(`magic link verify failed: ${result.reason} (token length ${token.length})`);
    return null;
  }
  const accountId = await upsertAccount(result.email);
  return makeSession(accountId);
}
