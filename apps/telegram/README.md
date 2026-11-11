# Telegram adapter

`apps/telegram` is Hub William's public webhook service. Its only public
routes are Telegram's authenticated webhook (`POST /webhook`), SePay's
authenticated bank-transaction webhook (`POST /sepay`) and `GET /health`. Two more routes, `POST /internal/announce` and
`POST /internal/payment-notice`, are for `apps/api` alone and need its shared secret
(`x-hub-william-telegram-token`): the dashboard uses them to have the bot send a
message and to tell a buyer their order is paid. It calls the private `apps/api` service for
everything it stores. The catalogue, stock, orders, payments and contacts are
all business-API responsibilities; this service renders them and nothing more.
The full design is in [docs/architecture/telegram.md](../../docs/architecture/telegram.md).

The adapter handles private-chat `/start`, `/menu`, `/catalog`, `/orders`,
`/lang`, `/help`, and `/status`. When a contact has no saved language, `/menu`
first asks for English or Tiếng Việt and persists that choice through the
private API; it then lists providers, and tapping one opens that provider's
packages. `/start` creates or updates a Telegram contact record; it does **not**
create, link, or authenticate a Hub William browser account.

Warranty codes are stable and customer-facing: `WF` is a full warranty, `W7D`
is seven days, `NW` is no warranty. A package carries exactly one of them, shown in brackets on its
row in the package list (`Gemini AI PRO your mail · (NW) · 70,000đ (1 left)`), and a plan sold under
two warranties is two catalogue entries. The code says nothing more: what else a buyer should know
about a package goes in its **package note**, a field of the dashboard's stock form (up to 200
characters). It is shown at the end of the quantity prompt, the screen a buyer reaches by tapping
the package, to readers of both languages exactly as typed: line breaks, blank lines and spacing are
kept (only the ends are trimmed), and the message is sent as plain text so nothing in it is read as
formatting. A package without a note shows none.

A package is called what the shop called it. The provider only groups packages into a card and a
provider screen; it is not put in front of the name, so a shop that wants its brand in the name
writes it there (`Gemini AI PRO your mail`). Orders record the same name.

## Checkout

Tapping a package opens its quantity prompt; a bare number in the same chat
creates an order through the private API and offers VND or USDT. The adapter
keeps only the pending prompt in memory (the tapped package, or an owner's
expected answer, for 30 minutes) — the order itself lives in
`telegram_orders`, so a redeploy cannot lose a buyer's checkout and every
payment button reads its order back by reference.

The VND panel shows a VietQR image made for that order. The shop configures its
receiving account as one QR link (`TELEGRAM_PAYMENT_QR_URL`); every order puts its
own total and transfer note on a copy of that link, so the buyer scans and pays
without typing anything. The note is `TELEGRAM_PAYMENT_MEMO_PREFIX` (default `MOT NGAY VUI VE`)
plus the order reference, and that reference is what settles the order. Telegram
fetches the image from that service, so the panel depends on it being up.

USDT has no automatic settlement and says so on its own panel.

The catalogue lives in Postgres behind `apps/api`, not in this crate: the
adapter reads it on every screen, so an edit shows up without a deploy. A
package the shop is pushing is flagged `hot` and shows a 🔥 in front of its
name, on its catalogue row and on its quantity prompt. That flame is the only
decoration a row carries; everything else stays bare so it keeps meaning
something. An order records the plain title, never the flame.

## The stock room

`/catalog` has two faces. To an owner it opens the stock room — every product
including hidden ones, with buttons to add stock, change a price, flag a
package hot, or hide it from the shop, plus a template for creating a new one.
To everybody else it is the ordinary shop, the same screen `/menu` gives.

Ownership is checked against `TELEGRAM_USERNAME_OWNER`, one Telegram username,
and it is re-checked on every button and on the message that answers a prompt,
not only when `/catalog` was typed. The same username is the handle a buyer is
told to contact.

Adding stock — or creating a product that already has stock — announces it:

```text
🔥 Claude có hàng mới
🛍️ Claude MAX X20 (Personal) · 1M (WF)
📁 Danh mục: AI Tools
💰 Giá: 135,000₫
📦 Tồn kho: 60 · vừa nhập 7

👇 Bấm nút bên dưới để mua ngay:
[🛒 Mua ngay]
```

It goes to everyone who has started the bot, and additionally to
`TELEGRAM_ANNOUNCE_CHAT_ID` when one is configured. The fan-out is detached from
the owner's own reply and paced at one message per 50ms, under Telegram's bulk
limit. The API can record a blocked chat so that later announcements skip it, but
the adapter does not call that route today. The button is a `t.me` deep link, so tapping it opens the
bot on that product's quantity prompt.

The dashboard's own message, typed in the stock form, goes out through
`POST /internal/announce` with the text exactly as written. When the request also
names a `product` slug, both the channel post and the message to each chat carry
the same “🛒 Mua ngay” button for that product; without one the message is bare.
A `product` that is not a slug is refused before anything is sent.

## Stock that is held, not just counted

A product's count on hand is not what a buyer may order. An order that is
awaiting payment and has not expired **reserves** its quantity, so the shop
offers `on hand − reserved`; settling an order consumes the stock for good.
That is what stops two buyers from each taking the last unit, and what stops one
buyer from opening order after order past the shelf. The owner panel shows both
numbers whenever anything is held.

A tapped button is left unacknowledged until its work finishes, so Telegram
keeps its own loading state on the button rather than looking frozen; a plain
message that needs an API round trip gets the typing indicator instead.
The package list and the quantity prompt end with "Quay trở lại" and, below it, "Tải lại", which
draws the screen again so a count or a price that changed shows up. Every back button says the
same thing, wherever it goes back to.
Browsing the shop rewrites one message in place, so nothing stacks up and the
shop never moves to the end of the chat. Only a payment panel replaces the
message it was opened from, because Telegram cannot rewrite a text message into
the photo the QR needs. A payment check that is still unpaid answers in a popup
and leaves the chat untouched, so the QR stays on screen.

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

The adapter then messages the buyer, with the accounts in the message for a
package that hands them out. When none were left for the order, the message says
how many are missing and tells the buyer to write to the owner with the order's
reference; refunds are settled between the two. A package with no accounts loaded
(its stock is a count set by hand) has nothing to put in the message, so the
message tells the buyer to write to the owner with the order's reference to
receive the account. The owner is not told of the payment, so the buyer's message
is what starts the handover. `Kiểm tra thanh toán` reads the same
record, so it reports a real result rather than a guess. An incoming transfer
that matches nothing is still stored for a human to reconcile, and an order
that expires is void: a buyer has five minutes to pay, and a transfer the bank
made after that is stored for a human to reconcile but does not settle it. When
such a transfer names the expired order, the buyer is messaged all the same: the
money arrived, the order did not complete, and they are to write to the owner with
the order's reference, who gives them the goods or the money back. The owner is
not told; the buyer's message starts it.

Point SePay's webhook at `https://<public-host>/sepay` and set the same API key
on both sides.

## Local development

Copy `.env.example` into your local secret manager, then start the API and
adapter separately:

```bash
pnpm api:dev
pnpm telegram:dev
```

The webhook endpoint is `POST /webhook`; `GET /health` is unauthenticated and
returns no data beyond the service name. Telegram validates requests through the
`X-Telegram-Bot-Api-Secret-Token` header supplied by `setWebhook`.

## Railway setup

Create a public Railway service named `telegram` from `apps/telegram/Dockerfile`.
Set these service variables:

- `HUB_API_INTERNAL_URL`: the private API origin, for example
  `http://backend.railway.internal:8080`.
- `TELEGRAM_SERVICE_TOKEN`: a long random secret, the same value as the
  `telegram` key in `SHOP_KEYS` on `apps/api` (or `TELEGRAM_SERVICE_TOKEN` there). The adapter's former name for it,
  `HUB_API_SERVICE_TOKEN`, is still read while this one is not set, so an existing
  deployment keeps working; rename the variable when convenient.
- `TELEGRAM_WEBHOOK_SECRET`: a different random token of 1–256 letters,
  numbers, `_`, or `-`.
- `TELEGRAM_BOT_TOKEN`: the BotFather token, sealed in Railway. The adapter
  uses it for the Bot API calls it makes itself (`answerCallbackQuery`,
  `deleteMessage`, `sendChatAction`, and `sendMessage` for payment
  notifications and restock announcements); the configuration script also uses
  it to register Telegram's webhook and command menu.
- `TELEGRAM_WEBHOOK_URL`: the public Railway URL, for example
  `https://telegram-production-example.up.railway.app`. The running service does
  not read it; `scripts/configure-webhook.sh` does, to register Telegram's webhook.
- `TELEGRAM_USERNAME_OWNER`: the one Telegram username that owns the shop, with
  or without the `@`. It may use the owner side of `/catalog`, and buyers are told
  to contact it. Defaults to `synasapmob`. Anything that is not a single username
  (for example a comma-separated list) fails startup.
- `SEPAY_API_KEY`: the key SePay sends on its webhook. Without it `/sepay`
  refuses every call, so bank transfers are never settled automatically.
- `TELEGRAM_PAYMENT_QR_URL`: the shop's receiving account as an HTTPS link to
  SePay's QR service, for example
  `https://vietqr.app/img?bank=MBBank&acc=<account number>&holder=<account holder>&showinfo=true&fullacc=true`.
  It must carry `bank`, `acc` (digits only) and `holder`; a link without them
  fails startup. Those three are shown on the panel, and any `amount` or `des` in
  the link is replaced for each order. Unset, the VND button says transfers are
  not configured. `TELEGRAM_PAYMENT_MEMO_PREFIX` is an optional override.
- `TELEGRAM_PAYMENT_USDT_ADDRESS` and `TELEGRAM_PAYMENT_USDT_VND_RATE`:
  optional, and also all-or-nothing. `TELEGRAM_PAYMENT_USDT_NETWORK` defaults
  to `TRC20`. Without them the USDT button says the method is not configured
  rather than showing an address the shop does not own.

To change the receiving account, change `TELEGRAM_PAYMENT_QR_URL`. Nothing needs
rebuilding.

`apps/api` takes it as the `telegram` entry of `SHOP_KEYS` (or, as before, as
`TELEGRAM_SERVICE_TOKEN`): set it there to the **same** value. The API remains private; this second secret ensures
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

When `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_URL` and `TELEGRAM_WEBHOOK_SECRET`
(the three variables the script requires) are stored on the Railway `telegram`
service, the same script can run without copying a token into a local shell:

```bash
railway run --service telegram -- bash apps/telegram/scripts/configure-webhook.sh
```
