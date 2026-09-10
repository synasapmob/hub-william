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
  persists a Telegram contact's presentation preference through the API and
  renders the catalogue, but owns none of it: products, stock, orders, SePay
  confirmation, entitlements, and pool membership are all API-owned.
- The catalogue is API-owned data, not adapter code. The owner edits it from
  Telegram through `/catalog`, which is the ordinary shop for everyone else.
  Ownership is a configured allowlist of Telegram usernames and numeric ids,
  re-checked on every button and on every message that answers a prompt, because
  a username can be released and re-registered by somebody else.
- New stock is announced by one post to a configured channel rather than a
  message to each contact. That keeps the bot clear of Telegram's bulk-message
  limits, needs no opt-out, and cannot be blocked away by individual buyers.
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
- The catalogue moved out of adapter code and into `telegram_products`, seeded
  from what was hardcoded so the shop reads the same across the move. Adding
  stock or a product is now a database write, not a deploy, and the adapter
  reads the catalogue on every screen rather than caching it.
- Owner access rests on a Telegram identity rather than a Hub William account,
  because the stock room is reached from Telegram and there is no owner role on
  `users`. A username allowlist is convenient but reassignable; the numeric-id
  allowlist is the one that cannot be taken over.
- Stock is still not decremented when an order is paid, so the count a buyer
  sees is what the owner set rather than what is unsold.
- An order survives a redeploy and can be settled by a transfer that arrives
  long after its displayed expiry, because expiry governs the panel rather than
  the match. Cancelling is what actually stops an order from being matched.
- The public Telegram origin now also carries `/sepay` and `/qr.png`. Neither
  serves buyer data: `/sepay` is a write authenticated by SePay's key, and the
  QR is a fixed image of an account already printed on every payment panel.
- The frontend's brand images cannot appear beside a name in Telegram: a custom
  emoji renders only for bots that bought a Fragment username, and an inline
  keyboard button carries plain text. Rather than approximate a logo with a
  stock emoji, a catalogue row carries no mark at all unless the shop is pushing
  that package, which shows a 🔥. Every shop screen therefore stays text and is
  rewritten in place; only a payment panel, which needs a photo, replaces its
  message.
- A transfer whose note matches no order, or that does not cover the total, is
  recorded and left for a human rather than guessed at.
- Nothing yet hands over the purchased account. `paid` is the end of the
  automated path; fulfilment and entitlement remain a later slice.
- Receiving accounts stay in service configuration, never in the repository. An
  unconfigured payment method tells the buyer it is unavailable instead of
  rendering placeholder bank or wallet details.
