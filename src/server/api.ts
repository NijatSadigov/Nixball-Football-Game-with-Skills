// HTTP API for accounts + payments. Returns true if it handled the request,
// false to fall through to the static file handler.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { accountsEnabled, config, paymentsEnabled } from './config';
import {
  isValidEmail,
  makeSession,
  requestMagicLink,
  SESSION_COOKIE,
  sessionCookieFrom,
  verifyMagicLink,
} from './auth';
import { getAccountEmail, ownedFx } from './db';
import { createCheckout, handleWebhook } from './payments';
import { SHOT_FX } from '../shared/shotfx';

function json(res: ServerResponse, status: number, body: unknown): void {
  const raw = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(raw);
}

function readBody(req: IncomingMessage, maxBytes = 16_384): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function setSessionCookie(res: ServerResponse, value: string): void {
  const secure = config.publicBaseUrl.startsWith('https://') ? '; Secure' : '';
  res.setHeader(
    'set-cookie',
    `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 60 * 60}${secure}`,
  );
}

const premiumFx = () => SHOT_FX.filter((f) => f.priceUsd > 0).map((f) => f.id);

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const p = url.pathname;
  if (!p.startsWith('/api/') && p !== '/stripe/webhook') return false;

  // ---- Stripe webhook (must use the RAW body for signature verification) ----
  if (p === '/stripe/webhook' && req.method === 'POST') {
    try {
      const raw = await readBody(req, 1_000_000);
      await handleWebhook(raw, req.headers['stripe-signature'] as string | undefined);
      json(res, 200, { received: true });
    } catch (err) {
      console.error('webhook error', (err as Error).message);
      json(res, 400, { error: 'webhook verification failed' });
    }
    return true;
  }

  // ---- public config (so the client knows whether to show sign-in/buy) ----
  if (p === '/api/me' && req.method === 'GET') {
    const base = {
      accountsEnabled,
      paymentsEnabled,
      premium: premiumFx(),
    };
    const accountId = accountsEnabled ? sessionCookieFrom(req.headers.cookie) : null;
    if (accountId) {
      try {
        const [email, owned] = await Promise.all([getAccountEmail(accountId), ownedFx(accountId)]);
        json(res, 200, { ...base, signedIn: true, email, owned });
        return true;
      } catch (err) {
        console.error('me error', err);
      }
    }
    json(res, 200, { ...base, signedIn: false, email: null, owned: [] });
    return true;
  }

  if (!accountsEnabled) {
    json(res, 503, { error: 'accounts are not enabled on this server' });
    return true;
  }

  // ---- request a magic link ----
  if (p === '/api/auth/request' && req.method === 'POST') {
    try {
      const { email } = JSON.parse((await readBody(req)).toString() || '{}');
      if (!isValidEmail(String(email ?? ''))) {
        json(res, 400, { error: 'invalid email' });
        return true;
      }
      await requestMagicLink(String(email));
    } catch (err) {
      console.error('auth request error', err);
    }
    // always report success (don't reveal whether an email exists)
    json(res, 200, { ok: true });
    return true;
  }

  // ---- verify a magic link (clicked from email) ----
  if (p === '/api/auth/verify' && req.method === 'GET') {
    const token = url.searchParams.get('token') ?? '';
    const session = await verifyMagicLink(token);
    if (session) {
      setSessionCookie(res, session);
      res.writeHead(302, { location: `${config.publicBaseUrl}/?signedin=1` });
      res.end();
    } else {
      res.writeHead(302, { location: `${config.publicBaseUrl}/?login=expired` });
      res.end();
    }
    return true;
  }

  // ---- sign out ----
  if (p === '/api/auth/logout' && req.method === 'POST') {
    setSessionCookie(res, '');
    res.setHeader('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    json(res, 200, { ok: true });
    return true;
  }

  // ---- create a Stripe Checkout session ----
  if (p === '/api/checkout' && req.method === 'POST') {
    if (!paymentsEnabled) {
      json(res, 503, { error: 'payments are not enabled on this server' });
      return true;
    }
    const accountId = sessionCookieFrom(req.headers.cookie);
    if (!accountId) {
      json(res, 401, { error: 'sign in first' });
      return true;
    }
    try {
      const { fxId } = JSON.parse((await readBody(req)).toString() || '{}');
      const email = await getAccountEmail(accountId);
      if (!email) {
        json(res, 401, { error: 'unknown account' });
        return true;
      }
      const checkoutUrl = await createCheckout(accountId, email, String(fxId ?? ''));
      json(res, 200, { url: checkoutUrl });
    } catch (err) {
      console.error('checkout error', (err as Error).message);
      json(res, 400, { error: 'could not start checkout' });
    }
    return true;
  }

  json(res, 404, { error: 'not found' });
  return true;
}
