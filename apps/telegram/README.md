# Telegram adapter

`apps/telegram` is Hub William's public Telegram webhook service. It accepts
only Telegram's authenticated webhook traffic and calls the private `apps/api`
service to persist contact metadata. Product inventory, orders, payments,
entitlements, and pool membership remain business-API responsibilities.

The adapter handles private-chat `/start`, `/menu`, `/orders`, `/lang`,
`/help`, and `/status`. `/menu` first asks for English or Tiếng Việt, persists
that choice through the private API, and then lists providers; tapping one
opens that provider's packages. `/start` creates or updates a Telegram contact
record; it does **not** create, link, or authenticate a Hub William browser
account.

Warranty codes are stable and customer-facing: `WF` is a full warranty, `W7D`
is seven days, `NW` is none. A package carries exactly one of them — a plan
sold under two warranties is two catalogue entries.

## Checkout

Tapping a package opens its quantity prompt; a bare number in the same chat
creates an order through the private API and offers VND or USDT. The adapter
keeps only the tapped package in memory — the order itself lives in
`telegram_orders`, so a redeploy cannot lose a buyer's checkout and every
payment button reads its order back by reference.

The VND panel shows `assets/qr-bank.png`, the shop's fixed VietQR image, served
publicly at `/qr.png` because Telegram fetches a photo by URL. A fixed QR
carries no amount and no note, so the buyer types both; the note is
`TELEGRAM_PAYMENT_MEMO_PREFIX` plus the order reference, and that reference is
what settles the order.

USDT has no automatic settlement and says so on its own panel.

A tapped button is left unacknowledged until its work finishes, so Telegram
keeps its own loading state on the button rather than looking frozen; a plain
message that needs an API round trip gets the typing indicator instead. Opening
a payment panel removes the message it was tapped from, so the chat holds one
live panel instead of a stack. A payment check that is still unpaid answers in
a popup and leaves the chat untouched, so the QR stays on screen.

## SePay settlement

SePay watches the shop's bank account and posts each transaction to `/sepay`,
authenticated with `Authorization: Apikey $SEPAY_API_KEY`. The adapter is the
only publicly reachable service, so it verifies that key and forwards the
transaction to the private API, which:

- records it in `telegram_payments`, keyed by SePay's transaction id, so a
  retry is recorded and notified exactly once;
- matches an order still awaiting payment whose reference appears in the
  transfer note once punctuation, spacing and case are stripped, and whose
  total the transfer covers;
- marks that order `paid`.

The adapter then messages the buyer. `Kiểm tra thanh toán` reads the same
record, so it reports a real result rather than a guess. An incoming transfer
that matches nothing is still stored for a human to reconcile, and an order
that expires stays matchable — a late transfer with the right note still
settles it.

Point SePay's webhook at `https://<public-host>/sepay` and set the same API key
on both sides.

## Local development

Copy `.env.example` into your local secret manager, then start the API and
adapter separately:

```bash
pnpm api:dev
pnpm telegram:dev
```

The webhook endpoint is `POST /webhook`; its `/health` endpoint is public only
for Railway health checks. Telegram validates requests through the
`X-Telegram-Bot-Api-Secret-Token` header supplied by `setWebhook`.

## Railway setup

Create a public Railway service named `telegram` from `apps/telegram/Dockerfile`.
Set these service variables:

- `HUB_API_INTERNAL_URL`: the existing private API host, for example
  `http://backend.railway.internal:8080` while that Railway private hostname
  remains assigned.
- `HUB_API_SERVICE_TOKEN`: a long random secret.
- `TELEGRAM_WEBHOOK_SECRET`: a different random token of 1–256 letters,
  numbers, `_`, or `-`.
- `TELEGRAM_BOT_TOKEN`: the BotFather token, sealed in Railway. The adapter
  uses it only to acknowledge an inline-button callback; the configuration
  script also uses it to register Telegram's webhook and command menu.
- `TELEGRAM_WEBHOOK_URL`: the public Railway URL, for example
  `https://telegram-production-example.up.railway.app`.
- `SEPAY_API_KEY`: the key SePay sends on its webhook. Without it `/sepay`
  refuses every call, so bank transfers are never settled automatically.
- `TELEGRAM_PAYMENT_BANK_NAME`, `TELEGRAM_PAYMENT_ACCOUNT_HOLDER`, and
  `TELEGRAM_PAYMENT_ACCOUNT_NUMBER`: the shop's receiving account, displayed
  beside the QR. Set all three or none; a partial set fails startup, and an
  unset set makes the VND button say transfers are not configured.
  `TELEGRAM_PAYMENT_MEMO_PREFIX` is an optional override.
- `TELEGRAM_PUBLIC_URL`: optional; defaults to `TELEGRAM_WEBHOOK_URL`. Telegram
  fetches `/qr.png` from it, so without either the VND panel falls back to
  text-only account details.
- `TELEGRAM_PAYMENT_USDT_ADDRESS` and `TELEGRAM_PAYMENT_USDT_VND_RATE`:
  optional, and also all-or-nothing. `TELEGRAM_PAYMENT_USDT_NETWORK` defaults
  to `TRC20`. Without them the USDT button says the method is not configured
  rather than showing an address the shop does not own.

To change the payment QR, replace `assets/qr-bank.png` and update the three
account variables to match; the image is compiled into the binary, so the
service has to be rebuilt.

Set `TELEGRAM_SERVICE_TOKEN` on `apps/api` to the **same** value as
`HUB_API_SERVICE_TOKEN`. The API remains private; this second secret ensures
that another service on the private network cannot write Telegram contacts.

After Railway gives `telegram` a public HTTPS URL, configure Telegram from a
shell where the BotFather token is available, without saving it into Git:

```bash
TELEGRAM_BOT_TOKEN='…' \
TELEGRAM_WEBHOOK_URL='https://telegram-production-…up.railway.app' \
TELEGRAM_WEBHOOK_SECRET='the-same-secret-in-Railway' \
bash apps/telegram/scripts/configure-webhook.sh
```

The script registers the command menu and requests `message` and
`callback_query` updates.
Run it again after changing the public URL or webhook secret. Use Telegram's
`getWebhookInfo` Bot API method to inspect delivery errors; do not use
`getUpdates` while the webhook remains active.

When all five variables are stored on the Railway `telegram` service, the same
script can run without copying a token into a local shell:

```bash
railway run --service telegram -- bash apps/telegram/scripts/configure-webhook.sh
```
