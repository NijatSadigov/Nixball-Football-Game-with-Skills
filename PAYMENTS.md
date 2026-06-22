# Accounts & payments (premium shot effects)

NixBall sells cosmetic **shot effects** for $1 each via **Stripe Checkout**.
The whole feature is **optional and env-gated**: with none of the variables
below set, the game runs exactly as before and premium effects fall back to
local preview-unlocks. Set them to turn on real purchases.

**We never see or store card data** — Stripe hosts the payment page. On our
side we store only an email (for sign-in) and which effects an account owns.
Ownership is granted **only** by Stripe's signed webhook, never by the client.

## How it works

```
pick a premium effect → (sign in via emailed magic link) →
  /api/checkout creates a Stripe Checkout session → Stripe hosted payment page →
  Stripe → POST /stripe/webhook (signature verified) → ownership written to Postgres →
  back in the game, the effect is unlocked and equippable
```

## Environment variables

| Var | Needed for | Notes |
| --- | --- | --- |
| `DATABASE_URL` | accounts | Postgres connection string |
| `SESSION_SECRET` | accounts | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `PUBLIC_BASE_URL` | accounts | e.g. `https://nixball.NijatSadigov.com` |
| `STRIPE_SECRET_KEY` | payments | `sk_test_…` then `sk_live_…` |
| `STRIPE_PUBLISHABLE_KEY` | payments | `pk_…` |
| `STRIPE_WEBHOOK_SECRET` | payments | `whsec_…` from the webhook endpoint |
| `MAIL_TRANSPORT` | login email | `console` (logs link) or `resend` |
| `RESEND_API_KEY`, `MAIL_FROM` | resend mail | only if `MAIL_TRANSPORT=resend` |

`accounts: ENABLED` / `payments: ENABLED` is printed at server startup so you
can confirm what's active.

## 1. Postgres database

Run a dedicated Postgres container for NixBall, published on localhost only
(so the host's systemd service can reach it, but the internet can't). This
keeps it fully isolated from the portfolio stack.

```bash
sudo docker run -d --name nixball-db --restart unless-stopped \
  -e POSTGRES_USER=nixball \
  -e POSTGRES_PASSWORD='a-strong-password' \
  -e POSTGRES_DB=nixball \
  -p 127.0.0.1:5433:5432 \
  -v nixball-db-data:/var/lib/postgresql/data \
  postgres:16-alpine
```

Then `DATABASE_URL=postgres://nixball:a-strong-password@127.0.0.1:5433/nixball`.
The app creates its tables automatically on startup.

## 2. Stripe

1. In the Stripe Dashboard (test mode), grab your `sk_test_…` / `pk_test_…`.
2. Add a webhook endpoint → `https://nixball.NijatSadigov.com/stripe/webhook`,
   event `checkout.session.completed`. Copy its `whsec_…` signing secret.
3. Local testing without a public URL: `stripe listen --forward-to
   localhost:3000/stripe/webhook` (the Stripe CLI) prints a `whsec_…` to use.

> The `/stripe/webhook` route must receive the **raw** request body — the
> server reads it raw for signature verification, and Caddy forwards it
> unmodified by default, so no extra proxy config is needed.

## 3. Email (magic links)

- Easiest start: `MAIL_TRANSPORT=console` — the sign-in link is printed to the
  server log (`journalctl -u nixball -f`). Fine for testing.
- Production: create a free [Resend](https://resend.com) account, verify your
  domain, set `MAIL_TRANSPORT=resend`, `RESEND_API_KEY`, and `MAIL_FROM`.

## 4. Put the vars in the service

Add them to `deploy/nixball.service` as `Environment=` lines (or an
`EnvironmentFile=/opt/nixball/.env`), then:

```bash
sudo systemctl daemon-reload && sudo systemctl restart nixball
journalctl -u nixball -n 20   # check "accounts: ENABLED" / "payments: ENABLED (test mode)"
```

## 5. Test the flow (test mode)

1. Open the game, lobby → **Sign in**, enter your email, click the magic link
   (printed in the log if using the console transport).
2. Click a premium effect → Stripe Checkout. Pay with the test card
   `4242 4242 4242 4242`, any future expiry, any CVC.
3. You're redirected back; the effect shows **Owned** and is equippable. Confirm
   the row landed in `purchases`.

## Promo codes

Players can redeem a promo code in the lobby (under "Shot effect") to unlock
effects for free — handy for giveaways, testers, or unlocking skins while the
webhook is still being set up. Codes live in the `promo_codes` table; create
them with psql:

```bash
# a code that unlocks one effect (Inferno), unlimited uses
sudo docker exec nixball-db psql -U nixball -d nixball -c \
  "INSERT INTO promo_codes (code, fx_id) VALUES ('WELCOME', 'flame');"

# a code that unlocks ALL premium effects, limited to 50 uses
sudo docker exec nixball-db psql -U nixball -d nixball -c \
  "INSERT INTO promo_codes (code, fx_id, max_uses) VALUES ('FOUNDER', 'all', 50);"
```

- `fx_id` is a shot-effect id (`flame`, `bolt`, `confetti`, `shock`, `nova`) or
  `all` for every premium effect.
- `max_uses` NULL = unlimited; each code can be redeemed once per account.
- Disable a code: `UPDATE promo_codes SET active = false WHERE code = 'WELCOME';`

Redeeming requires the player to be signed in (the unlock is tied to their
account, so it follows them across devices).

## Going live

- Swap the test keys for **live** keys and re-create the webhook in live mode.
- **Roll any secret key that was ever shared in plaintext** (chat, screenshots).
- Review Stripe tax/payout settings for your country, and add a short
  refund/contact note since you're selling to real people.
