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

`apps/telegram/src/app.rs` serves six routes on `[::]:$PORT` (default `8090`). The last two are for `apps/api` alone.

| Route                           | Purpose                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                   | Returns `{"status":"ok","service":"hub-william-telegram"}`. Unauthenticated; used for platform health checks.                                                                                                                                                                                                                                                                                              |
| `POST /webhook`                 | Telegram updates (`message` and `callback_query`).                                                                                                                                                                                                                                                                                                                                                         |
| `POST /sepay`                   | SePay bank-transaction webhook.                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /internal/announce`       | The dashboard's message: posts `{"text", "product"?}` to `TELEGRAM_ANNOUNCE_CHAT_ID` when set and starts sending it to every non-blocked contact, paced like a restock. A `product` slug adds the restock's “Mua ngay” deep-link button. Answers `{"channel", "audience"}`; `422` for an empty text, one over 4,096 characters, or a `product` that is not a slug, `503` when the audience cannot be read. |
| `POST /internal/payment-notice` | Tells one buyer their order is paid (`{"reference"}`), after the dashboard marked it paid by hand. Reads the order from the API and refuses (`422`) one that is not paid.                                                                                                                                                                                                                                  |

### Webhook authentication

- `POST /internal/*` compares the `x-hub-william-telegram-token` header with `TELEGRAM_SERVICE_TOKEN`, the secret the adapter already uses to call the API, in constant time. A wrong or missing header returns `403`. `apps/api` reaches the adapter at `TELEGRAM_ADAPTER_URL`; without it the dashboard reports that it is not connected to the bot.

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

Inline buttons carry a prefix in `callback_data`: `language:`, `menu`, `provider:<slug>`, `catalog:<slug>`, `refresh:<screen>`, `pay:<action>:<reference>` and `admin…` (owner actions). `refresh:` is followed by the data that opens a screen (`refresh:provider:claude`, `refresh:catalog:claude-pro`) and draws that screen again from the API, with a short toast ("Đã tải lại") because Telegram refuses an edit that changes nothing. A package that has since sold out or been hidden is shown in its provider's list, and a provider that has gone, in the menu. The button sits below "Quay trở lại" on the package list and on the quantity prompt, and is left off when its data would pass Telegram's 64-byte limit. Every payment button carries its order reference and reads the order back from the API, so a button left in an old message acts on that exact order, or on nothing once the order is settled or cancelled.

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

- **Owner check.** `Owner::includes` accepts the one username (case-insensitive, `@` stripped) set in `TELEGRAM_USERNAME_OWNER`, which defaults to `synasapmob`, and the check runs on every owner button and every owner prompt reply. The same username is the handle buyers are told to contact. Why one username and no numeric id: a username belongs to one account at a time, so losing the account is the only way to lose the shop's owner, and that is the operator's own risk.
- **New product template.** Lines of `key: value`. Keys match loosely (accents and case ignored) in Vietnamese or English: provider (`nhà cung cấp`/`provider`), plan (`tên`/`plan`), warranty (`bảo hành`/`warranty`), price (`giá`/`price`) are required; stock (`tồn`/`stock`), category (`danh mục`/`category`), detail (`chi tiết`/`detail`) and variant (`biến thể`/`variant`) are optional. Numbers tolerate space, `.`, `,` and `_` separators.
- **Warranty codes.** `WF` (full), `W7D` (seven days), `NW` (no warranty beyond a one-hour login check). A package carries exactly one; a plan sold under two warranties is two products. Each code has a standard note shown in the quantity prompt; the dashboard form can replace it with the shop's own words (up to 200 characters), stored for both languages.

## Catalogue and stock

Tables (`apps/api/migrations/…_create_telegram_*.sql`): `telegram_contacts`, `telegram_orders`, `telegram_payments`, `telegram_providers`, `telegram_products`, `telegram_restocks`.

- A product slug is `provider plan variant` folded to lowercase ASCII (Vietnamese accents are folded) with hyphens, at most 64 characters. Creating a product with an unknown provider creates the provider; a duplicate slug returns a conflict.
- Limits enforced by the API: price 0 to 1,000,000,000 đồng; initial stock 0 to 1,000,000; one restock 1 to 100,000 units (the running total is not capped).
- The title stored on an order is `<provider> <plan> (<variant>) · <detail>`, never including the 🔥.
- **Stock is held, not only counted.** `on_hand` is the count the owner set. `reserved` is the sum of `quantity` over orders with `status = 'awaiting_payment'` and `expires_at > NOW()`. The API returns `available = GREATEST(on_hand − reserved, 0)` on every product read, and the shop sells against that number. There is no sweeper: a reservation lapses when its order's `expires_at` passes. Settling an order consumes stock (below).
- A restock updates `available` and inserts a `telegram_restocks` row (`added`, `available_after`) in one transaction.
- `GET /internal/telegram/catalogue` returns listed providers with listed products only (a provider with nothing listed is omitted); `…/catalogue/full` returns everything.

## Accounts handed out automatically

A package made with `delivers_accounts` hands the buyer an account when they have paid. The accounts are loaded in advance from the dashboard, one `email|password` line each, into `telegram_stock_accounts`.

- **Encrypted at rest.** Each line is sealed with AES-256-GCM under `STOCK_ENCRYPTION_KEY`, which lives in the API's environment and nowhere else: not in the database, not in the repository, not in the bot. The nonce is random per line and the row's id is the associated data, so a ciphertext copied onto another row does not open. A copy of the database alone shows no account.
- **One line is one account.** Two accounts may share an email and differ in their password: each line is a unit of stock and is handed to one buyer. Only the very same line twice (the email in any case, the password exactly) is a repeat, because it would hand one account to two buyers; a keyed hash (HMAC-SHA-256 under a key derived from the encryption key) is unique per package for that, so a repeat is noticed without keeping the line readable, and a repeated line is counted as a duplicate and left out. A second hash of the email alone only serves the search for an email in full.
- **The count follows the accounts.** The package's count is recounted from the accounts not yet sold on every load, never added to. The dashboard's stock change, the bot owner's restock and the form's stock stepper all refuse such a package.
- **Nothing returns an account.** Loading answers counts only, listings carry no account, a refused line is never quoted back, and the request type is not `Debug` so it cannot be logged by accident.
- **Who loaded what, and changing it.** Each account records who loaded it. A collaborator (role `stock-keeper`) sees only the accounts they loaded and can delete or change only those; an owner or manager can delete or change any. An unsold account can be taken out, or given a new email and/or password without being opened (`PUT /dashboard/telegram/accounts/{id}`: the server opens it, changes it and seals it again, so the caller never needs the old password; a change that would make it exactly the same line as another account of the package is refused). A sold account can be neither, because it already belongs to a buyer.
- **Opening and editing as a block (owner only).** The owner proves who they are with their password once and opens any number of accounts at a time (`POST /dashboard/telegram/accounts/reveal`; each account opened is recorded). They are shown as one `email|password` line each, to read and edit as text, and saved with `PUT /dashboard/telegram/products/{slug}/accounts`, which says first (`dry_run`) what it would do: a line left as it was is untouched; a line changed is rewritten in place (paired with the new line of the same email, else the next new line, so a changed password keeps the account, its id, its loader and its date); a line deleted takes the account out of stock; a line added is put in. Accounts the block never opened are not touched, so a collaborator's load made meanwhile survives. If any account opened was sold or removed since, the whole edit is refused, since the block no longer describes the package. The count moves by what was taken out and put in, and the change is recorded. The page drops the opened accounts after five minutes without a keystroke.
- **Seeing and managing all of them.** The dashboard's Accounts page lists every account of every such package, sold or not, with filters, counts and a search; the email is hidden in the list and a search for it needs the whole address. It is also where accounts are added, opened and edited, and deleted, so the package form is not the only way in. See `GET /dashboard/telegram/accounts`.
- **Looking at a password is the owner's alone.** Only the `secrets` permission, which only the owner holds, opens an account in the clear, one at a time. It needs the owner's login password, is limited to five tries a minute, is recorded (who, which account, when) before the account is returned, and is sent with `no-store`. The page hides it again after 30 seconds. The login has no second factor, so this is as strong as the owner's password; the record is for noticing afterwards, not for preventing.
- **The flag is fixed at creation.** Flipping it on a package with a hand-set count would leave the count and the accounts disagreeing.
- **Handed out when the order is paid.** In the same transaction that marks the order paid (SePay or by hand from the dashboard), the oldest unsold accounts are given to it, `quantity` of them, with `FOR UPDATE SKIP LOCKED`: an account another sale is taking at that moment is skipped, so two sales at once never take the same account and neither waits for the other. The count is lowered by what was actually taken. A retried SePay transaction is a duplicate and hands out nothing a second time.
- **An order can be paid and find none left.** Two buyers can both be let through for the last account (the stock check when an order is made is not atomic, and the order is made before anyone pays). Both orders stay paid. The first to settle gets the account; the other gets what is left, possibly nothing, and its message says how many are missing and tells the buyer to write to the owner (`TELEGRAM_USERNAME_OWNER`) with the order's reference. Refunding or finding another account is then between the two of them; the system does nothing more.
- **A package with no accounts loaded is handed over by the owner.** A package that does not hand out accounts (its count is set by hand) has nothing to put in the buyer's message, so the paid message tells the buyer to write to the owner with the order's reference, and the owner gives them the account. The owner is not told of the payment; the buyer's message starts it. The same sentence is what a buyer reads if the API could not say what was handed out.
- **Who is turned away, and when.** An open order reserves its quantity, so once the last unit is in someone's order the next buyers are told it is sold out before they pay, and get the unit back if that order expires. The "write to the owner" message after paying is for what gets past that: orders made in the same moment, or stock taken out while an order was open. The stock check when an order is made is not atomic with making it. Money sent for an order that has already expired is stored for the owner to reconcile and settles nothing. If the note names that order, SePay's result carries it as `late` (with the amount) and the bot tells the buyer the money arrived, the order did not complete, and to write to the owner with the order's reference; only a transfer that came after the order ran out counts, so a transfer that is short or for an order stopped by the buyer is not announced, and a transfer SePay sends twice is announced once.
- **How the buyer gets them.** After a payment the adapter asks `GET /internal/telegram/contacts/{id}/orders/{reference}/delivery`. The API opens the accounts and answers `{accounts, missing}` to the contact whose order it is, only once it is paid, and the same on every ask. The paid message carries them, numbered when there are several. The check-payment button asks again, so a buyer whose message did not arrive gets them back from the payment panel. If the API cannot be asked, the paid message goes out without accounts rather than not at all. Nothing in the adapter or the API logs an account, and the types that hold one are not `Debug`.
- **Ten at a time.** A package that hands out accounts sells at most 10 in one order (the API refuses more; the bot shows the lower maximum), so an order's accounts, at most 300 characters each, always fit in the one Telegram message that carries them.

## Orders and checkout

1. The buyer taps a package and sends a quantity. The adapter calls `POST /internal/telegram/contacts/{id}/orders` with the product slug, quantity, chat id and `lifetime_minutes = 5`.
2. The API validates (`1 ≤ quantity ≤ 1000`, `1 ≤ lifetime ≤ 1440`, product listed, quantity ≤ sellable stock), copies the current price and title onto the order, and inserts it with a random 12-character reference over `A–Z0–9` (up to 8 attempts on a collision). A client can never set its own price.
3. The adapter offers VND or USDT.
   - **VND** shows a VietQR image of the order, from SePay's QR service (`https://vietqr.app/img`), and the receiving account, both read from `TELEGRAM_PAYMENT_QR_URL`. Each order puts its total and transfer note on a copy of that link, so the buyer types nothing; the note is `TELEGRAM_PAYMENT_MEMO_PREFIX` (default `MOT NGAY VUI VE`, uppercase ASCII letters and spaces, at most 32 characters) plus the order reference. Expiry is rendered in UTC+7.
   - **USDT** shows the wallet address, network (default `TRC20`) and an amount rounded up to the cent from the VND total and `TELEGRAM_PAYMENT_USDT_VND_RATE`. It has no automatic settlement and says so.
4. The buyer can check payment (`pay:check:<reference>`; still unpaid answers in a popup so the QR stays on screen) or cancel (`pay:cancel:<reference>`).

Order `status` is `awaiting_payment`, `paid` or `cancelled` (a database `CHECK`), and `paid_at` is set exactly when the status is `paid`. Cancel moves only an `awaiting_payment` order to `cancelled` and stops later matching; a transfer that already arrived stays recorded. An order past `expires_at` keeps the status `awaiting_payment`: it stops reserving stock and a transfer can no longer settle it, though staff can still mark it paid by hand on the dashboard.

## SePay settlement

1. SePay posts each bank transaction to `POST /sepay`. The adapter authenticates it and forwards the JSON to `POST /internal/telegram/payments/sepay`.
2. In one database transaction the API inserts the payment into `telegram_payments`, keyed by `sepay_transaction_id` (`ON CONFLICT DO NOTHING`). A repeated transaction id returns `duplicate: true` and nothing else happens, so a retry is neither re-recorded nor re-notified.
3. Only `transferType = in` can settle. The API builds a search string from SePay's `code` plus `content`, keeps ASCII letters and digits and upper-cases them (banks rewrite case, spacing and punctuation), then selects the oldest order where `status = 'awaiting_payment'`, the string contains the order `reference`, and `total_vnd <= transferAmount`. `FOR UPDATE SKIP LOCKED` prevents two simultaneous transfers from settling one order. The match also needs `expires_at` to be later than the time the bank made the transfer (SePay's `transactionDate`, read as Vietnamese local time, or the moment the webhook arrives when it is missing). A transfer made in time still settles when its webhook is a little late; a later one is stored unmatched, like any other transfer that matches nothing. The order becomes `paid`, `paid_at = NOW()`, and the payment row is linked to it.
4. In the same transaction the product's `available` drops by the order quantity (`GREATEST(available − quantity, 0)`, guarding against the owner having lowered the count meanwhile). For a package that hands out accounts the accounts are handed to the order here and `available` drops by the number actually given (see above).
5. A transfer that matches nothing is stored for a human to reconcile. When it names an order that had already run out before the money moved (`expires_at` at or before the transfer's time), nothing is settled either, but the result carries `late: {amount_vnd, order}` so the adapter can tell that buyer.
6. The adapter then sends the buyer a `sendMessage` (for `late`, the message that the money arrived but the order did not complete) (in the contact's saved language, read without touching `last_seen_at`). A failed notification is logged and does not fail the webhook, because a SePay retry would be deduplicated and the buyer would never hear. `Kiểm tra thanh toán` reads the same order, so it reports the real status.

SePay timestamps (`transactionDate`, `%Y-%m-%d %H:%M:%S`) are read as UTC+7.

## Restock announcements

Adding stock, or creating a product that already has stock, announces it:

- To `TELEGRAM_ANNOUNCE_CHAT_ID` (a channel id or `@name`; the bot must administer it) when configured.
- To every non-blocked contact (`GET /internal/telegram/audience`), detached from the owner's reply and paced at one message every 50 ms to stay under Telegram's bulk limit. The API can mark a chat as blocked (`POST /internal/telegram/audience/{chat_id}/block` sets `blocked_at`, and `GET /internal/telegram/audience` skips such contacts), but the adapter does not reach that call today: `call_telegram` maps every Bot API failure, including a `403`, to `503`, and `broadcast_restock` only calls the block route on a `403`.
- The "Mua ngay" button is a `t.me/<TELEGRAM_BOT_USERNAME>?start=<slug>` deep link; without `TELEGRAM_BOT_USERNAME` the post goes out without a button.

## Internal API

All routes live in `apps/api/src/api/telegram/routes.rs`, are not in the published OpenAPI document, and are blocked at the public edge (`/api/internal` and `/api/internal/*` return `404`, see [deployment](./deployment.md#edge-nginx)).

Each handler calls `authorize_telegram_service`: the `x-hub-william-telegram-token` request header must equal `TELEGRAM_SERVICE_TOKEN` (constant-time comparison). When `TELEGRAM_SERVICE_TOKEN` is unset or blank every route returns `403`, so the API fails closed. The adapter has the same variable and sends its value.

| Method and path                                                    | Purpose                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `POST /internal/telegram/contacts`                                 | Upsert contact, return `preferred_language`              |
| `GET /internal/telegram/contacts/{id}`                             | Read language without touching `last_seen_at`            |
| `PUT /internal/telegram/contacts/{id}/language`                    | Set language (`en` or `vi`)                              |
| `GET`, `POST /internal/telegram/contacts/{id}/orders`              | List the latest 10 orders; create an order               |
| `GET /internal/telegram/contacts/{id}/orders/{reference}`          | Read one order (scoped to that contact)                  |
| `POST /internal/telegram/contacts/{id}/orders/{reference}/cancel`  | Cancel an `awaiting_payment` order                       |
| `GET /internal/telegram/contacts/{id}/orders/{reference}/delivery` | The accounts a paid order was handed, for its buyer only |
| `POST /internal/telegram/payments/sepay`                           | Record and settle a SePay transaction                    |
| `GET /internal/telegram/audience`                                  | Chats that have not blocked the bot                      |
| `POST /internal/telegram/audience/{chat_id}/block`                 | Mark a chat blocked                                      |
| `GET /internal/telegram/catalogue`, `…/catalogue/full`             | Buyer view; owner view                                   |
| `POST /internal/telegram/products`                                 | Create a product                                         |
| `GET`, `PATCH /internal/telegram/products/{slug}`                  | Read; change `hot`, `listed`, `price_vnd`                |
| `POST /internal/telegram/products/{slug}/restock`                  | Add stock                                                |

## Configuration

Adapter variables (`apps/telegram/src/config.rs`, `apps/telegram/.env.example`). `AppConfig::from_env` fails startup on the first violation.

| Variable                                                                  | Rule                                                                                                                                                                                                     |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_SERVICE_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` | Required. The webhook secret is 1–256 characters of letters, digits, `_` or `-`. The service token was `HUB_API_SERVICE_TOKEN`, which is still read while the new name is not set.                       |
| `HUB_API_INTERNAL_URL`                                                    | Private API origin; defaults to `http://localhost:8080`.                                                                                                                                                 |
| `TELEGRAM_WEBHOOK_URL`                                                    | Public origin of this service. Only `scripts/configure-webhook.sh` reads it, to register the Telegram webhook; the running service does not.                                                             |
| `TELEGRAM_PAYMENT_QR_URL`                                                 | The receiving account as an HTTPS QR link. It must carry `bank`, `acc` (digits only) and `holder`, or startup fails. Those are shown upper-case; any `amount` or `des` in it is replaced for each order. |
| `TELEGRAM_PAYMENT_USDT_ADDRESS`, `…_USDT_VND_RATE`, `…_USDT_NETWORK`      | Address and rate all-or-nothing, rate a positive integer; network defaults to `TRC20`.                                                                                                                   |
| `SEPAY_API_KEY`                                                           | Optional at boot; without it `/sepay` refuses every call.                                                                                                                                                |
| `TELEGRAM_USERNAME_OWNER`                                                 | One Telegram username (5-32 letters, digits or underscores; the `@` is optional). Defaults to `synasapmob`; anything else fails startup.                                                                 |
| `TELEGRAM_ANNOUNCE_CHAT_ID`, `TELEGRAM_BOT_USERNAME`                      | Optional announcement target and deep-link bot name.                                                                                                                                                     |
| `TELEGRAM_API_BASE_URL`                                                   | Test override; defaults to `https://api.telegram.org/`.                                                                                                                                                  |
| `PORT`                                                                    | Defaults to `8090`.                                                                                                                                                                                      |

With a method unconfigured, its button tells the buyer the method is not configured instead of showing invented details. The adapter's outbound HTTP client has a 5 s connect timeout, a 10 s total timeout, ignores proxy variables and binds an IPv4 local address.

`apps/api` and `apps/telegram` both take `TELEGRAM_SERVICE_TOKEN`, and it must be the same value on both; see [deployment](./deployment.md#api-runtime). Operational setup (Railway variables, registering the webhook) is in `apps/telegram/README.md`.

## Not implemented

- **Fulfilment.** `paid` is terminal. Nothing delivers the product; the owner does that by hand after the buyer is notified. Packages that hand out accounts are the exception: their accounts are delivered automatically (see above).
- **Automatic USDT settlement.** USDT orders are reconciled by hand.
- **Order expiry as a status.** Expiry releases the stock reservation and stops a transfer from settling the order, but the row stays `awaiting_payment`; nothing marks it `cancelled`, so the dashboard's awaiting queue still lists it.
- **Linking to browser accounts.** `/start` creates or updates a Telegram contact; it does not create, link or authenticate a Hub William browser account.
