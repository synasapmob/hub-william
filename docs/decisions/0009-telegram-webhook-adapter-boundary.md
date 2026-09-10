# ADR-0009: Telegram webhook adapter boundary

- Status: Accepted
- Date: 2026-09-10

## Context

The `@hub_william_bot` bot now exists and needs a production webhook. Telegram
must reach that webhook over public HTTPS, whereas the business API must retain
the private Railway network boundary from ADR-0004. The adapter also needs to
remember that a Telegram user has started the bot without treating a Telegram
identity as a browser account or duplicating order and membership rules.

## Decision

- `apps/telegram` is a separately deployable, publicly reachable webhook
  adapter. Its only public routes are `/health` and the Telegram webhook.
- Telegram's `secret_token` is configured during `setWebhook`; every webhook
  request must match its `X-Telegram-Bot-Api-Secret-Token` header before it is
  parsed or processed.
- The adapter calls `apps/api` through Railway private networking using a
  dedicated shared service token. `apps/api` validates that token before
  accepting internal Telegram contact writes.
- The API owns the durable `telegram_contacts` record. A private-chat `/start`
  upserts contact metadata, but neither creates nor links a Hub William user.
- Commands may use a Telegram webhook reply for immediate messages. The adapter
  may persist a Telegram contact's presentation preference and render a clearly
  temporary catalogue, but live product inventory, orders, SePay confirmation,
  entitlements, and pool membership decisions remain API-owned work for a later
  commerce slice.
- Orders and payments are API-owned. The adapter creates an order through the
  private API when a buyer confirms a quantity, and every payment screen reads
  that order back by reference. The only state the adapter keeps in memory is
  which package a buyer tapped, which is ephemeral by nature.
- SePay is the settlement source. It can only reach a public HTTPS endpoint, so
  the adapter exposes `/sepay`, authenticates SePay's API key, and forwards the
  transaction to the API; the API records it, matches an order still awaiting
  payment by the reference in the transfer note, and marks that order paid. The
  adapter then notifies the buyer. Matching is idempotent by SePay's transaction
  id, so a retried webhook never pays or notifies twice.
- The shop's payment QR is a fixed image of its receiving account, served from
  the adapter's public origin because Telegram fetches a photo by URL. A fixed
  QR carries no amount and no note, so the buyer types both and the panel says
  so plainly.

## Consequences

- The public Telegram origin is not a public API origin; browser traffic still
  reaches business routes only through the frontend's same-origin `/api`
  proxy.
- A failed contact write returns a non-2xx webhook result, allowing Telegram
  to retry an update; the API upsert is idempotent by Telegram user ID.
- A browser-to-Telegram linking flow and payment fulfilment are intentionally
  blocked until their user-visible policies are decided, rather than inferring
  authorization from a Telegram username.
- The temporary catalogue must not be treated as a payment source of truth.
  When commerce is enabled, its product and stock values move behind the API
  without changing Telegram's webhook trust boundary.
- An order survives a redeploy and can be settled by a transfer that arrives
  long after its displayed expiry, because expiry governs the panel rather than
  the match. Cancelling is what actually stops an order from being matched.
- The public Telegram origin now also carries `/sepay`, `/qr.png` and
  `/icons/<provider>.png`. None serves buyer data: `/sepay` is a write
  authenticated by SePay's key, the QR is a fixed image of an account already
  printed on every payment panel, and the provider marks are the same brand
  images the frontend serves publicly.
- Telegram inline buttons carry plain text, so brand marks can only appear on a
  screen rather than on the button that opens it. That makes a provider screen a
  photo message, and because Telegram cannot rewrite a text message into a photo
  message, shop navigation removes the previous screen and sends the next one.
- A transfer whose note matches no order, or that does not cover the total, is
  recorded and left for a human rather than guessed at.
- Nothing yet hands over the purchased account. `paid` is the end of the
  automated path; fulfilment and entitlement remain a later slice.
- Receiving accounts stay in service configuration, never in the repository. An
  unconfigured payment method tells the buyer it is unavailable instead of
  rendering placeholder bank or wallet details.
