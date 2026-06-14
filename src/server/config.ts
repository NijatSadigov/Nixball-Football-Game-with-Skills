// Central config + a tiny .env loader (avoids a dotenv dependency).
// Accounts/payments are optional and activate only when fully configured.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

function loadDotEnv(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

const env = (k: string): string => (process.env[k] ?? '').trim();

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicDir: process.env.PUBLIC_DIR ?? path.resolve(process.cwd(), 'dist/public'),
  publicBaseUrl: env('PUBLIC_BASE_URL') || `http://localhost:${Number(process.env.PORT ?? 3000)}`,
  databaseUrl: env('DATABASE_URL'),
  sessionSecret: env('SESSION_SECRET'),
  stripeSecretKey: env('STRIPE_SECRET_KEY'),
  stripePublishableKey: env('STRIPE_PUBLISHABLE_KEY'),
  stripeWebhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  mailTransport: (env('MAIL_TRANSPORT') || 'console') as 'console' | 'resend',
  resendApiKey: env('RESEND_API_KEY'),
  mailFrom: env('MAIL_FROM') || 'NixBall <login@nixball.example.com>',
};

// accounts (magic-link sign-in) need a DB + a session secret
export const accountsEnabled = Boolean(config.databaseUrl && config.sessionSecret);

// payments additionally need the Stripe keys
export const paymentsEnabled = Boolean(
  accountsEnabled &&
    config.stripeSecretKey &&
    config.stripePublishableKey &&
    config.stripeWebhookSecret,
);

export function logConfigSummary(): void {
  console.log(`accounts: ${accountsEnabled ? 'ENABLED' : 'disabled (no DATABASE_URL/SESSION_SECRET)'}`);
  console.log(
    `payments: ${paymentsEnabled ? 'ENABLED (' + (config.stripeSecretKey.startsWith('sk_live') ? 'LIVE' : 'test') + ' mode)' : 'disabled (missing Stripe config)'}`,
  );
}
