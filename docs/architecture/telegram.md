# Telegram shop

The Telegram shop sells packages (provider plans with a warranty code) to buyers in a private Telegram chat. It is split between `apps/telegram`, a stateless public webhook adapter that renders screens, and `apps/api`, which owns the catalogue, stock, orders, payments and contacts in Postgres. Bank transfers settle automatically through SePay; USDT is reconciled by hand.

## Responsibilities

| Concern                                                                                               | Owner                                                                                          |
| ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Telegram webhook authentication, screens, keyboards, localized text                                   | `apps/telegram`                                                                                |
| SePay webhook authentication, payment notifications to buyers, restock fan-out                        | `apps/telegram`                                                                                |
| Contacts, language preference, catalogue, stock, orders, payments, restock history, blocked chats     | `apps/api` (`apps/api/src/api/telegram/`), tables `telegram_*`                                 |
| What the next plain message from a chat means (quantity, price, restock amount, new-product template) | `apps/telegram`, in memory only                                                                |
| Public reachability                                                                                   | `apps/telegram` is the only public part of the shop; the API is reached over a private address |

The adapter has no database. It calls `apps/api` for everything it stores, so a redeploy loses nothing except the short-lived prompt state described in [In-memory state](#in-memory-state).

## Adapter routes

`apps/telegram/src/app.rs` serves four routes on `[::]:$PORT` (default `8090`).

| Route           | Purpose                                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`   | Returns `{"status":"ok","service":"hub-william-telegram"}`. Unauthenticated; used for platform health checks.                                                         |
| `GET /qr.png`   | The shop's fixed VietQR image, compiled into the binary from `apps/telegram/assets/qr-bank.png`. Public because Telegram fetches a photo by URL. Cached for one hour. |
| `POST /webhook` | Telegram updates (`message` and `callback_query`).                                                                                                                    |
| `POST /sepay`   | SePay bank-transaction webhook.                                                                                                                                       |

### Webhook authentication

- `POST /webhook` compares the `X-Telegram-Bot-Api-Secret-Token` header with `TELEGRAM_WEBHOOK_SECRET` in constant time (`secrets_match`). A wrong or missing header returns `403`. The `Json<Update>` extractor parses the body before the handler compares the secret, so a malformed body is rejected by the extractor first.
- `POST /sepay` reads `Authorization: Apikey <key>` and compares it with `SEPAY_API_KEY` in constant time. When `SEPAY_API_KEY` is unset the route returns `403` for every call; a wrong key returns `401`.
- Only `message` and `callback_query` updates are handled. `scripts/configure-webhook.sh` registers exactly those two `allowed_updates` plus the command menu.

### Update handling

- Messages and callbacks from non-private chats or from bots are ignored (`204`).
- Every handled message or callback first calls `POST /internal/telegram/contacts` to upsert the contact and read its saved language (`en` or `vi`). A contact without a saved language is answered in Vietnamese; `/menu` asks for the language first.
- Replies are returned as the webhook response body, a JSON object carrying the Bot API `method` (`sendMessage`, `sendPhoto` or `editMessageText`). The adapter calls the Bot API directly only for `answerCallbackQuery`, `deleteMessage`, `sendChatAction` and `sendMessage` (payment notifications and restock announcements).
- A tapped button is acknowledged only after its work finishes, so Telegram keeps the button in its loading state while the API round trips run. A result that does not deserve a chat message (an unpaid payment check, an API error) is delivered as an alert popup (`answerCallbackQuery` with `show_alert`, text truncated to 200 characters).
- Browsing rewrites one message in place (`editMessageText`). A payment panel replaces the message it was opened from (`deleteMessage` plus a new message), because a text message cannot become a photo.
- A plain message that needs an API round trip first shows the typing indicator (`sendChatAction`).

## Chat surface

| Command            | Behaviour                                                                                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/start`           | Welcome screen. `/start <slug>` (lowercase letters, digits, hyphens) is a deep link: when that product is listed and in stock it opens the quantity prompt; otherwise it opens the menu. |
| `/menu`            | Providers list, or the language picker when the contact has no saved language.                                                                                                           |
| `/lang`            | Language picker (`en` or `vi`).                                                                                                                                                          |
| `/catalog`         | The stock room for owners; the ordinary shop menu for everyone else.                                                                                                                     |
| `/orders`          | The contact's most recent orders (the API returns the latest 10).                                                                                                                        |
| `/help`, `/status` | Static text.                                                                                                                                                                             |

Inline buttons carry a prefix in `callback_data`: `language:`, `menu`, `provider:<slug>`, `catalog:<slug>`, `pay:<action>:<reference>` and `admin…` (owner actions). Every payment button carries its order reference and reads the order back from the API, so a button left in an old message acts on that exact order, or on nothing once the order is settled or cancelled.

### In-memory state

`Sessions` (`apps/telegram/src/checkout.rs`) is the only state the adapter keeps: one `Pending` entry per Telegram user id, expiring 30 minutes after it is set and purged on every access.

| `Pending`        | Set by                            | The next plain message is…                                     |
| ---------------- | --------------------------------- | -------------------------------------------------------------- |
| `Quantity(slug)` | Tapping a package, or a deep link | The quantity to order, an integer from 1 to the sellable stock |
| `Restock(slug)`  | Owner button                      | Units to add                                                   |
| `Price(slug)`    | Owner button                      | The new price in đồng                                          |
| `NewProduct`     | Owner button                      | A filled-in product template (see [Stock room](#stock-room))   |

Owner expectations are re-checked when the answering message arrives, not only when the button was tapped.

## Stock room

`/catalog` for an owner lists every product, including unlisted ones, with buttons to add stock, set the price, toggle `hot` (a 🔥 before the name on the catalogue row and the quantity prompt) or toggle `listed`, and a template for creating a product.

- **Owner check.** `Owners::includes` accepts a Telegram user id listed in `TELEGRAM_OWNER_IDS` or a username (case-insensitive, `@` stripped) listed in `TELEGRAM_OWNER_USERNAMES`. Usernames default to `synasapmob`. Either list grants access, and the check runs on every owner button and every owner prompt reply. Why: a username can be released and reassigned, a numeric id cannot, so the id list is the stronger check.
- **New product template.** Lines of `key: value`. Keys match loosely (accents and case ignored) in Vietnamese or English: provider (`nhà cung cấp`/`provider`), plan (`tên`/`plan`), warranty (`bảo hành`/`warranty`), price (`giá`/`price`) are required; stock (`tồn`/`stock`), category (`danh mục`/`category`), detail (`chi tiết`/`detail`) and variant (`biến thể`/`variant`) are optional. Numbers tolerate space, `.`, `,` and `_` separators.
- **Warranty codes.** `WF` (full), `W7D` (seven days), `NW` (no warranty beyond a one-hour login check). A package carries exactly one; a plan sold under two warranties is two products.

## Catalogue and stock

Tables (`apps/api/migrations/…_create_telegram_*.sql`): `telegram_contacts`, `telegram_orders`, `telegram_payments`, `telegram_providers`, `telegram_products`, `telegram_restocks`.

- A product slug is `provider plan variant` folded to lowercase ASCII (Vietnamese accents are folded) with hyphens, at most 64 characters. Creating a product with an unknown provider creates the provider; a duplicate slug returns a conflict.
- Limits enforced by the API: price 0 to 1,000,000,000 đồng; initial stock 0 to 1,000,000; one restock 1 to 100,000 units (the running total is not capped).
- The title stored on an order is `<provider> <plan> (<variant>) · <detail>`, never including the 🔥.
- **Stock is held, not only counted.** `on_hand` is the count the owner set. `reserved` is the sum of `quantity` over orders with `status = 'awaiting_payment'` and `expires_at > NOW()`. The API returns `available = GREATEST(on_hand − reserved, 0)` on every product read, and the shop sells against that number. There is no sweeper: a reservation lapses when its order's `expires_at` passes. Settling an order consumes stock (below).
- A restock updates `available` and inserts a `telegram_restocks` row (`added`, `available_after`) in one transaction.
- `GET /internal/telegram/catalogue` returns listed providers with listed products only (a provider with nothing listed is omitted); `…/catalogue/full` returns everything.

## Orders and checkout

1. The buyer taps a package and sends a quantity. The adapter calls `POST /internal/telegram/contacts/{id}/orders` with the product slug, quantity, chat id and `lifetime_minutes = 15`.
2. The API validates (`1 ≤ quantity ≤ 1000`, `1 ≤ lifetime ≤ 1440`, product listed, quantity ≤ sellable stock), copies the current price and title onto the order, and inserts it with a random 12-character reference over `A–Z0–9` (up to 8 attempts on a collision). A client can never set its own price.
3. The adapter offers VND or USDT.
   - **VND** shows `/qr.png` and the receiving account (`TELEGRAM_PAYMENT_BANK_NAME`, `…ACCOUNT_HOLDER`, `…ACCOUNT_NUMBER`). The QR is fixed and carries no amount or note, so the buyer types both; the note is `TELEGRAM_PAYMENT_MEMO_PREFIX` (default `CAM TIEN DI CHILL THOI`, uppercase ASCII letters and spaces, at most 32 characters) plus the order reference. Expiry is rendered in UTC+7.
   - **USDT** shows the wallet address, network (default `TRC20`) and an amount rounded up to the cent from the VND total and `TELEGRAM_PAYMENT_USDT_VND_RATE`. It has no automatic settlement and says so.
4. The buyer can check payment (`pay:check:<reference>`; still unpaid answers in a popup so the QR stays on screen) or cancel (`pay:cancel:<reference>`).

Order `status` is `awaiting_payment`, `paid` or `cancelled` (a database `CHECK`), and `paid_at` is set exactly when the status is `paid`. Cancel moves only an `awaiting_payment` order to `cancelled` and stops later matching; a transfer that already arrived stays recorded. An order past `expires_at` keeps the status `awaiting_payment`: it stops reserving stock but remains matchable.

## SePay settlement

1. SePay posts each bank transaction to `POST /sepay`. The adapter authenticates it and forwards the JSON to `POST /internal/telegram/payments/sepay`.
2. In one database transaction the API inserts the payment into `telegram_payments`, keyed by `sepay_transaction_id` (`ON CONFLICT DO NOTHING`). A repeated transaction id returns `duplicate: true` and nothing else happens, so a retry is neither re-recorded nor re-notified.
3. Only `transferType = in` can settle. The API builds a search string from SePay's `code` plus `content`, keeps ASCII letters and digits and upper-cases them (banks rewrite case, spacing and punctuation), then selects the oldest order where `status = 'awaiting_payment'`, the string contains the order `reference`, and `total_vnd <= transferAmount`. `FOR UPDATE SKIP LOCKED` prevents two simultaneous transfers from settling one order. The match does not look at `expires_at`, so a late transfer with the right note still settles. The order becomes `paid`, `paid_at = NOW()`, and the payment row is linked to it.
4. In the same transaction the product's `available` drops by the order quantity (`GREATEST(available − quantity, 0)`, guarding against the owner having lowered the count meanwhile).
5. A transfer that matches nothing is stored for a human to reconcile.
6. The adapter then sends the buyer a `sendMessage` (in the contact's saved language, read without touching `last_seen_at`). A failed notification is logged and does not fail the webhook, because a SePay retry would be deduplicated and the buyer would never hear. `Kiểm tra thanh toán` reads the same order, so it reports the real status.

SePay timestamps (`transactionDate`, `%Y-%m-%d %H:%M:%S`) are read as UTC+7.

## Restock announcements

Adding stock, or creating a product that already has stock, announces it:

- To `TELEGRAM_ANNOUNCE_CHAT_ID` (a channel id or `@name`; the bot must administer it) when configured.
- To every non-blocked contact (`GET /internal/telegram/audience`), detached from the owner's reply and paced at one message every 50 ms to stay under Telegram's bulk limit. The API can mark a chat as blocked (`POST /internal/telegram/audience/{chat_id}/block` sets `blocked_at`, and `GET /internal/telegram/audience` skips such contacts), but the adapter does not reach that call today: `call_telegram` maps every Bot API failure, including a `403`, to `503`, and `broadcast_restock` only calls the block route on a `403`.
- The "Mua ngay" button is a `t.me/<TELEGRAM_BOT_USERNAME>?start=<slug>` deep link; without `TELEGRAM_BOT_USERNAME` the post goes out without a button.

## Internal API

All routes live in `apps/api/src/api/telegram/routes.rs`, are not in the published OpenAPI document, and are blocked at the public edge (`/api/internal` and `/api/internal/*` return `404`, see [deployment](./deployment.md#edge-nginx)).

Each handler calls `authorize_telegram_service`: the `x-hub-william-telegram-token` request header must equal `TELEGRAM_SERVICE_TOKEN` (constant-time comparison). When `TELEGRAM_SERVICE_TOKEN` is unset or blank every route returns `403`, so the API fails closed. The adapter sends the same value from `HUB_API_SERVICE_TOKEN`.

| Method and path                                                   | Purpose                                       |
| ----------------------------------------------------------------- | --------------------------------------------- |
| `POST /internal/telegram/contacts`                                | Upsert contact, return `preferred_language`   |
| `GET /internal/telegram/contacts/{id}`                            | Read language without touching `last_seen_at` |
| `PUT /internal/telegram/contacts/{id}/language`                   | Set language (`en` or `vi`)                   |
| `GET`, `POST /internal/telegram/contacts/{id}/orders`             | List the latest 10 orders; create an order    |
| `GET /internal/telegram/contacts/{id}/orders/{reference}`         | Read one order (scoped to that contact)       |
| `POST /internal/telegram/contacts/{id}/orders/{reference}/cancel` | Cancel an `awaiting_payment` order            |
| `POST /internal/telegram/payments/sepay`                          | Record and settle a SePay transaction         |
| `GET /internal/telegram/audience`                                 | Chats that have not blocked the bot           |
| `POST /internal/telegram/audience/{chat_id}/block`                | Mark a chat blocked                           |
| `GET /internal/telegram/catalogue`, `…/catalogue/full`            | Buyer view; owner view                        |
| `POST /internal/telegram/products`                                | Create a product                              |
| `GET`, `PATCH /internal/telegram/products/{slug}`                 | Read; change `hot`, `listed`, `price_vnd`     |
| `POST /internal/telegram/products/{slug}/restock`                 | Add stock                                     |

## Configuration

Adapter variables (`apps/telegram/src/config.rs`, `apps/telegram/.env.example`). `AppConfig::from_env` fails startup on the first violation.

| Variable                                                                 | Rule                                                                                                                                                         |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HUB_API_SERVICE_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Required. The webhook secret is 1–256 characters of letters, digits, `_` or `-`.                                                                             |
| `HUB_API_INTERNAL_URL`                                                   | Private API origin; defaults to `http://localhost:8080`.                                                                                                     |
| `TELEGRAM_WEBHOOK_URL`, `TELEGRAM_PUBLIC_URL`                            | Public origin for `/qr.png`; `TELEGRAM_PUBLIC_URL` defaults to `TELEGRAM_WEBHOOK_URL`. Without either the VND panel falls back to text-only account details. |
| `TELEGRAM_PAYMENT_BANK_NAME`, `…_ACCOUNT_HOLDER`, `…_ACCOUNT_NUMBER`     | All three or none (a partial set fails startup). The number is digits only. Displayed upper-case and never used to compute anything.                         |
| `TELEGRAM_PAYMENT_USDT_ADDRESS`, `…_USDT_VND_RATE`, `…_USDT_NETWORK`     | Address and rate all-or-nothing, rate a positive integer; network defaults to `TRC20`.                                                                       |
| `SEPAY_API_KEY`                                                          | Optional at boot; without it `/sepay` refuses every call.                                                                                                    |
| `TELEGRAM_OWNER_USERNAMES`, `TELEGRAM_OWNER_IDS`                         | Comma-separated owner lists.                                                                                                                                 |
| `TELEGRAM_ANNOUNCE_CHAT_ID`, `TELEGRAM_BOT_USERNAME`                     | Optional announcement target and deep-link bot name.                                                                                                         |
| `TELEGRAM_API_BASE_URL`                                                  | Test override; defaults to `https://api.telegram.org/`.                                                                                                      |
| `PORT`                                                                   | Defaults to `8090`.                                                                                                                                          |

With a method unconfigured, its button tells the buyer the method is not configured instead of showing invented details. The adapter's outbound HTTP client has a 5 s connect timeout, a 10 s total timeout, ignores proxy variables and binds an IPv4 local address.

`apps/api` needs `TELEGRAM_SERVICE_TOKEN` set to the same value as `HUB_API_SERVICE_TOKEN`; see [deployment](./deployment.md#api-runtime). Operational setup (Railway variables, registering the webhook) is in `apps/telegram/README.md`.

## Not implemented

- **Fulfilment.** `paid` is terminal. Nothing delivers the product; the owner does that by hand after the buyer is notified.
- **Automatic USDT settlement.** USDT orders are reconciled by hand.
- **Order expiry as a status.** Expiry only releases the stock reservation.
- **Linking to browser accounts.** `/start` creates or updates a Telegram contact; it does not create, link or authenticate a Hub William browser account.
