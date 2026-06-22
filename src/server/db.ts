// Postgres access for accounts + cosmetic ownership. Only used when
// accountsEnabled (a DATABASE_URL is configured).

import pg from 'pg';
import { accountsEnabled, config } from './config';
import { SHOT_FX } from '../shared/shotfx';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
    pool.on('error', (err) => console.error('pg pool error', err));
  }
  return pool;
}

export async function initDb(): Promise<void> {
  if (!accountsEnabled) return;
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS accounts (
      id          SERIAL PRIMARY KEY,
      email       TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS login_tokens (
      token       TEXT PRIMARY KEY,
      email       TEXT NOT NULL,
      expires_at  TIMESTAMPTZ NOT NULL,
      used        BOOLEAN NOT NULL DEFAULT false
    );
    CREATE TABLE IF NOT EXISTS purchases (
      id                SERIAL PRIMARY KEY,
      account_id        INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      fx_id             TEXT NOT NULL,
      stripe_session_id TEXT UNIQUE,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (account_id, fx_id)
    );
    CREATE TABLE IF NOT EXISTS promo_codes (
      code      TEXT PRIMARY KEY,
      fx_id     TEXT NOT NULL,           -- a shot-fx id, or 'all'
      max_uses  INTEGER,                 -- NULL = unlimited
      uses      INTEGER NOT NULL DEFAULT 0,
      active    BOOLEAN NOT NULL DEFAULT true
    );
    CREATE TABLE IF NOT EXISTS promo_redemptions (
      code       TEXT NOT NULL,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (code, account_id)
    );
  `);
  console.log('database ready (accounts + purchases + promo codes)');
}

export async function upsertAccount(email: string): Promise<number> {
  const p = getPool();
  const res = await p.query<{ id: number }>(
    `INSERT INTO accounts (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email],
  );
  return res.rows[0].id;
}

export async function getAccountEmail(accountId: number): Promise<string | null> {
  const p = getPool();
  const res = await p.query<{ email: string }>(`SELECT email FROM accounts WHERE id = $1`, [
    accountId,
  ]);
  return res.rows[0]?.email ?? null;
}

export async function ownedFx(accountId: number): Promise<string[]> {
  const p = getPool();
  const res = await p.query<{ fx_id: string }>(
    `SELECT fx_id FROM purchases WHERE account_id = $1`,
    [accountId],
  );
  return res.rows.map((r) => r.fx_id);
}

export async function grantFx(
  accountId: number,
  fxId: string,
  stripeSessionId: string,
): Promise<void> {
  const p = getPool();
  // idempotent: a webhook may be delivered more than once
  await p.query(
    `INSERT INTO purchases (account_id, fx_id, stripe_session_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id, fx_id) DO NOTHING`,
    [accountId, fxId, stripeSessionId],
  );
}

// ---- promo codes ----

export type RedeemResult =
  | { ok: true; granted: string[] }
  | { ok: false; reason: 'invalid' | 'notfound' | 'exhausted' | 'already' };

// Redeem a promo code for the account: grants the code's effect(s). Each code
// can be redeemed once per account; ownership grants are idempotent.
export async function redeemPromo(accountId: number, rawCode: string): Promise<RedeemResult> {
  const code = rawCode.trim().toUpperCase();
  if (!code || code.length > 32) return { ok: false, reason: 'invalid' };
  const p = getPool();
  const res = await p.query<{ fx_id: string; max_uses: number | null; uses: number; active: boolean }>(
    `SELECT fx_id, max_uses, uses, active FROM promo_codes WHERE upper(code) = $1`,
    [code],
  );
  const row = res.rows[0];
  if (!row || !row.active) return { ok: false, reason: 'notfound' };
  if (row.max_uses != null && row.uses >= row.max_uses) return { ok: false, reason: 'exhausted' };

  // one redemption per account
  const claim = await p.query(
    `INSERT INTO promo_redemptions (code, account_id) VALUES ($1, $2)
     ON CONFLICT DO NOTHING RETURNING code`,
    [code, accountId],
  );
  if (claim.rowCount === 0) return { ok: false, reason: 'already' };

  const fxIds =
    row.fx_id === 'all' ? SHOT_FX.filter((f) => f.priceUsd > 0).map((f) => f.id) : [row.fx_id];
  for (const fx of fxIds) {
    await p.query(
      `INSERT INTO purchases (account_id, fx_id, stripe_session_id)
       VALUES ($1, $2, $3) ON CONFLICT (account_id, fx_id) DO NOTHING`,
      [accountId, fx, `promo:${code}:${fx}`],
    );
  }
  await p.query(`UPDATE promo_codes SET uses = uses + 1 WHERE upper(code) = $1`, [code]);
  return { ok: true, granted: fxIds };
}

// ---- magic-link tokens ----

export async function saveLoginToken(token: string, email: string, expiresAt: Date): Promise<void> {
  const p = getPool();
  await p.query(`INSERT INTO login_tokens (token, email, expires_at) VALUES ($1, $2, $3)`, [
    token,
    email,
    expiresAt,
  ]);
}

export type ConsumeResult =
  | { ok: true; email: string }
  | { ok: false; reason: 'notfound' | 'expired' };

// Validate a login token. Expiry is checked against the Node clock (the same
// clock that SET expires_at) to avoid host/DB clock-skew false-expiries. The
// link stays usable for its whole window so a double-click or a browser/email
// prefetch doesn't burn it; we still flag it used for later cleanup.
export async function consumeLoginToken(token: string): Promise<ConsumeResult> {
  const p = getPool();
  const res = await p.query<{ email: string; expires_at: Date }>(
    `SELECT email, expires_at FROM login_tokens WHERE token = $1`,
    [token],
  );
  const row = res.rows[0];
  if (!row) return { ok: false, reason: 'notfound' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { ok: false, reason: 'expired' };
  await p.query(`UPDATE login_tokens SET used = true WHERE token = $1`, [token]);
  return { ok: true, email: row.email };
}
