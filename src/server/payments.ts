// Stripe Checkout for premium shot effects. We never touch card data — Stripe
// hosts the payment page. Ownership is granted ONLY from the verified webhook,
// never from anything the client says.

import Stripe from 'stripe';
import { config, paymentsEnabled } from './config';
import { getShotFx, SHOT_FX } from '../shared/shotfx';
import { grantFx } from './db';

let stripe: Stripe | null = null;

function client(): Stripe {
  if (!stripe) stripe = new Stripe(config.stripeSecretKey);
  return stripe;
}

// Create a Checkout session for one effect; returns the hosted-page URL.
export async function createCheckout(
  accountId: number,
  email: string,
  fxId: string,
): Promise<string> {
  const fx = getShotFx(fxId);
  if (fx.priceUsd <= 0 || !SHOT_FX.some((f) => f.id === fxId && f.priceUsd > 0)) {
    throw new Error('not a purchasable effect');
  }
  const session = await client().checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: Math.round(fx.priceUsd * 100),
          product_data: {
            name: `NixBall shot effect: ${fx.name}`,
            description: fx.desc,
          },
        },
      },
    ],
    // metadata is echoed back on the webhook — that's how we know what to grant
    metadata: { accountId: String(accountId), fxId },
    success_url: `${config.publicBaseUrl}/?purchased=${encodeURIComponent(fxId)}`,
    cancel_url: `${config.publicBaseUrl}/?canceled=1`,
  });
  if (!session.url) throw new Error('stripe did not return a checkout url');
  return session.url;
}

// Verify the webhook signature and grant ownership on completed checkout.
export async function handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
  if (!paymentsEnabled || !signature) throw new Error('payments not configured');
  const event = client().webhooks.constructEvent(rawBody, signature, config.stripeWebhookSecret);
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.payment_status !== 'paid') return;
    const accountId = Number(session.metadata?.accountId);
    const fxId = session.metadata?.fxId;
    if (Number.isInteger(accountId) && fxId) {
      await grantFx(accountId, fxId, session.id);
      console.log(`granted ${fxId} to account ${accountId} (session ${session.id})`);
    }
  }
}
