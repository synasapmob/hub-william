# Service

The SERVICE product rents agents that the platform owns, and charges as they are
used. A customer tops up a wallet, creates a **service key**, and each request
the key sends is charged at the price of the model it names. There is one
balance, the wallet, and nothing to buy in advance.

There is a second way to buy, which does not meter anything: a **ticket**. The
staff put one of their own agent accounts on sale for some days at a price, and a
customer who buys it pays from the wallet once and gets a key that runs on that one
account until the days are up. See [Tickets](#tickets).

It is a product of its own, apart from the Workspace (Home, Tools, Agents,
Organization) and the Playground. The three kinds of key never meet:

|                | Workspace key (`hw_live_…`)                            | Organization key (`hw_org_…`)                | Service key (`hw_svc_…`)                   |
| -------------- | ------------------------------------------------------ | -------------------------------------------- | ------------------------------------------ |
| Made on        | Workspace → Agents                                     | Organization → Agents                        | Service → Keys                             |
| Served by      | The user's own accounts, and the pools they joined     | The agents shared with that organization     | The platform's stock of accounts only      |
| Costs          | Nothing                                                | Nothing                                      | The model's price, from the owner's wallet |
| Usage shown on | The Workspace                                          | The organization's Usage page                | The Service pages                          |
| Playground     | Kind **Workspace**, a chosen account of the user's own | Kind **Organization**, a chosen organization | Kind **Service**, no account to choose     |

A ticket's key (`hw_tkt_…`) is a fourth kind, described under [Tickets](#tickets).

The Playground has no key of its own; its **Kind** select picks which of the three
it talks as.

## Money

Every amount is an integer number of micro-dollars (1 USD = 1,000,000), so no
amount is a float and no sum is rounded. `service_wallets` holds one number per
user, `wallet_micro`, with a `CHECK` constraint against a negative balance.

`service_ledger` records every top-up and every charge with the balance right
after it (`wallet_after_micro`). Rows are only added. A charge points at the
usage event it was for (`usage_event_id`), and the column is unique, so an event
is charged once; a top-up that was paid by card points at it (`top_up_id`, also
unique), so a payment is credited once. Rows of kind `exchange` and `withdraw`
are history from before pay as you go.

Each movement is one transaction that locks the user's `service_wallets` row
(`SELECT ... FOR UPDATE`) first, so two requests cannot take the same money.
`database_tests.rs` holds the row, lets two charges queue behind it and checks
that together they take no more than the wallet held.

## Pricing

The price list is data: one row per model in `service_model_prices`, with the
price of one million tokens in micro-dollars by kind of token (`input`, `cached`,
`output`), a `name` to show, a `position` among its agent's models and `listed`.
The Pricing page, the check before a request goes out and the charge after it
all read these rows, so the dashboard can add a model, price it or take it off
sale by writing a row, with no release.

- A request for a model with no **listed** row is refused with 422, whatever the
  provider would have said. A model is found under the id the request names, under
  that id without a `models/` prefix (a Gemini route has one), and under it
  without a reasoning effort (`-high`, `-medium`, `-low`), since the effort
  variants of a model are sold as the model.
- A request that was served is charged at the price of its row whether or not the
  row is still listed, so taking a model off sale does not make a request that is
  on its way free. A model with no row at all is charged its agent's price in
  `service_prices`, else the `default` row ($0.60 input, $0.06 cached, $4.70
  output); with every model listed having a row, that is only a safety net.
- The page lists the listed rows, for the six agents in the order ChatGPT,
  Gemini, Claude, DeepSeek, Grok, Groq, and in `position` order within an agent.

**The first rows** (`20261106000030_service_price_list.sql`) are the official API
prices of the agents on 2026-11-06, per million tokens in dollars. They are the
reference a sale price is worked out from, not what an account in the stock costs
the platform, which is a subscription:

| Agent    | Model                       | Input | Cached | Output |
| -------- | --------------------------- | ----: | -----: | -----: |
| ChatGPT  | gpt-6-astra                 | 10.00 |   1.00 |  50.00 |
|          | gpt-6-sol                   |  2.00 |   0.20 |  10.00 |
|          | gpt-6-luna                  |  0.10 |   0.01 |   0.50 |
|          | gpt-5.6-sol                 |  4.00 |   0.40 |  20.00 |
|          | gpt-5.6-terra               |  2.00 |   0.20 |  12.00 |
|          | gpt-5.6-luna                |  0.20 |   0.02 |   1.20 |
| Gemini   | gemini-4-argon              |  2.00 |   0.10 |  10.00 |
|          | gemini-3.8-flash, 3.6-flash |  0.75 |  0.075 |   3.75 |
|          | gemini-3.1-pro              |  2.00 |   0.20 |  12.00 |
| Claude   | claude-fable-5-1            | 10.00 |   0.25 |  50.00 |
|          | claude-opus-5-5             |  4.00 |   0.20 |  20.00 |
|          | claude-sonnet-5             |  2.00 |   0.20 |  10.00 |
|          | claude-haiku-4-5            |  1.00 |   0.10 |   5.00 |
| DeepSeek | deepseek-flash              |  0.30 |  0.006 |   1.20 |
|          | deepseek-v4-pro             |  1.32 |  0.044 |   3.96 |
| Grok     | grok-4.7                    |  2.00 |   0.50 |   6.00 |
| Groq     | qwen/qwen3.8-27b            |  0.80 |   0.80 |   4.00 |
|          | openai/gpt-oss-20b          | 0.075 |  0.075 |   0.30 |
|          | openai/gpt-oss-120b         |  0.15 |   0.15 |   0.60 |

What the table leaves out, on purpose for now:

- **Dates.** gemini-4-argon doubles on 2026-12-01 (4 / 0.20 / 20) and the Gemini
  3.x flash models on 2027-01-01. Change their rows then.
- **Rates the official list varies by request.** DeepSeek is priced at its peak
  rate and is half that off peak; a prompt longer than 272K tokens costs twice the
  input at OpenAI (200K at Gemini Pro and Grok). One row has one price, so neither
  is applied. Claude's more expensive cache writes are counted as input.
- **Cached prices not found.** Groq's list gives none, so its cached price is its
  input price.
- **Not on sale (`listed` false)** until their price is settled: gemini-3.7-flash,
  which Google does not price, and the three models an Antigravity account serves
  for Gemini that belong to other makers (claude-sonnet-4-6 and
  claude-opus-4-6-thinking, priced as Anthropic's 4.6 models, and gpt-oss-120b at
  Groq's price).

A request costs `new input × input + cached × cached + output × output`, where
new input is the input tokens less the cached ones (`input_tokens` already
includes them), rounded up to a micro-dollar so the price is never undercut. A
count the provider did not report costs nothing.

## Service keys

`gateway_keys.kind` is `workspace`, `organization` or `service` (a `CHECK`
requires `organization_id` for the middle one and forbids it for the others). A
service key starts with `hw_svc_` and is made, listed and revoked at
`/service/keys`, never with the other kinds: `GET /gateway-keys` lists only
Workspace keys, `GET /organizations/{id}/gateway-keys` only that member's keys of
that organization, and revoking a key through the wrong route finds nothing. Any
signed-in user can make up to 20 service keys; it needs no account of their own.

The gateway is the same one (`/gateway/openai/v1/responses` and the rest, see
[Gateway](./gateway.md)); the key a request presents says which product it is.
`authorize_gateway_key` reads the kind and `GatewaySelection.service` carries it.

**Stock.** A service key is served by the accounts with
`agent_connections.service_stock`, and by no other: not the owner's own, not a pool,
not an organization (`selection.rs`). A Workspace or organization key never reaches
them. The flag is set by hand, for an account its owner has connected like any
account:

```sql
UPDATE agent_connections SET service_stock = TRUE WHERE id = '<connection id>';
```

With no stock account for the provider the request answers 502 "The service has
no capacity for this provider right now." That is a different error from the
wallet's 402. The dashboard does not manage this stock: what it sells is tickets.

**Before the request goes out** (`service::authorize_request`, called from
`gateway/proxy.rs` and from the Gemini path), a service key's request must:

- name a model the service sells, by an id the agent's API uses or by the id of
  the price list; otherwise 422 `validation`;
- find the owner's wallet holding at least `MIN_BALANCE_MICRO` ($0.05), because
  what a request costs is known only when its stream ends; otherwise 402
  `insufficient_balance`.

Token counting (`count_tokens`) and model listings are not generation requests
and are not held. A request that fails upstream records no usage event, so it is
not charged.

**When the request ends**, `UsageEvent::record` writes the usage event and then
charges it (`service::charge_request`): one `usage` ledger row and the wallet
down by the cost. A request the client abandoned is charged for the usage seen
before it stopped. The wallet never goes below zero: a request that costs more
than is left takes what is left, and the rest is not collected (the platform
logs the shortfall). Several requests that start together can all pass the
minimum, so this is the most the platform can lose per request.

A charge that fails after the event was recorded leaves a service event with no
ledger row, which a query on `gateway_usage_events` joined to `service_ledger`
finds.

## Tickets

A ticket is an agent account of someone on the staff, put on sale once. The staff
connect it like any account (on the Agents page, or from the dashboard, which asks
the same endpoints), and the dashboard verifies it and sells it
([Dashboard](./dashboard.md#hub-williams-tickets)).

**On sale.** `service_listings` holds a ticket: its `provider`, the `connection_id`
that is sold, its `seller_id`, a `name`, how many `days` its key lasts, a
`price_micro` (whole cents, $0.01 to $10,000) and `listed`. When it was verified the
account's provider was asked for something through it (the model list, which costs no
tokens, answered by that very account, since the gateway otherwise fails over to the
owner's others), and what the account had left was read with the Agents page's
usage reader (`quota`, a list of `{label, value, detail}`, and `quota_captured_at`).
ChatGPT, Claude and Grok say; Gemini, DeepSeek and Groq do not, and the list is
empty. An account is on sale in one ticket at a time, and not again while the key of a
customer who bought it still works. It is for sale to customers while it is not sold
and is `listed`, its account is connected, and it is not waiting for its owner to
connect it again (`reauth_required`).

**Buying.** `POST /service/listings/{id}/purchase`. The account is tried first,
outside the transaction, so a customer is not charged for one that stopped working
after it was put on sale. Then, in one transaction: the listing is locked and found
again as still for sale; the price is taken from the wallet (`wallet::purchase`, a
ledger row of kind `purchase` for that listing, unique, so a ticket is bought once);
the customer's key is made (`create_ticket_key`); and the listing is marked sold with
the buyer and the price paid (`sold_at`, `buyer_id`, `sold_price_micro`). Of two
customers who press Buy together, one gets the ticket and the other a 404, charged
nothing. A sold ticket leaves the stock and the shop window, and is in the dashboard's
Sales history.

**The key** is a `gateway_keys` row of kind `ticket` (`hw_tkt_…`) with a `listing_id` and
an `expires_at` (a `CHECK` makes the three go together). Only its hash is kept, so it
cannot be shown again: reissuing revokes it and makes a new one for the same ticket.
It is served by the account of its listing and by no other (`selection.rs`): not the
buyer's own accounts, not a pool, not the platform's stock, and not another agent. It
costs nothing by the token (`selection.service` is false), and it stops at
`expires_at` (`authorize_gateway_key` ignores an expired key, so the answer is the
gateway's 401). The buyer's usage through it is counted as Workspace usage.

**Not built yet.** Nothing watches the account after the sale: one that its seller
uses up, that is rate limited, that needs connecting again or that is disconnected
leaves the customer with a key that does not work, with no refund or replacement. The
seller can still use an account they sold. How much of an account a customer used is
not measured.

## Usage

Every `gateway_usage_events` row carries a `scope`: `service` for a service key
or the Playground's Service kind, `organization` for an organization key or the
Playground's Organization kind, `workspace` otherwise. `GET /gateway-usage` is the
Workspace's: the `workspace` scope only, so neither an organization's nor the
Service's requests are in it (an organization's are on its Usage page). `GET
/service/usage` is the
Service's: the `service` scope only, with what each key and model was charged
(`spent_micro`, the sum of the `usage` ledger rows of its events). Both are
`usage_for_user` with a `UsageScope`.

**The Playground's Service kind** sends no key. `POST /playground/chat` with
`service: true` and no `connection_id` goes through `response_for_service_user`:
the same stock, the same price list and minimum balance, charged to the signed-in
user's wallet and counted in the Service usage. It is chat only; the Call modes
are disabled for it.

## Routes

All routes are in `apps/api/src/api/service/`. A top-up and a new key each have a
budget of 10 per minute per user (`Limit::ServiceWallet`).

| Route                                    | Who       | Behavior                                                                                                                                                                                                                                                                                      |
| ---------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /service/pricing`                   | Public    | `providers`, each with its `provider` id, `label`, `available` (the stock has a connected account for it now) and the listed `models` (`id`, `name`, `price`), `min_balance_micro`, `test_top_up` and `card_top_up`.                                                                          |
| `GET /service/wallet`                    | Signed in | `wallet_micro`. A user who never used the service reads zero.                                                                                                                                                                                                                                 |
| `POST /service/top-up`                   | Signed in | `amount_micro` ($1 to $1,000). With Stripe set up: opens a Checkout Session and returns `checkout_url` (the amount must be whole cents, else 422; 502 when Stripe cannot open one). Without Stripe and with `SERVICE_TEST_TOP_UP`: credits the wallet at once. Otherwise 501.                 |
| `POST /stripe/webhook`                   | Stripe    | Not for customers, and not in the OpenAPI file. Signed (`Stripe-Signature`), answers 403 to anything not signed by the endpoint's secret. See Paying in.                                                                                                                                      |
| `GET /service/listings`                  | Public    | The tickets for sale, by agent: `providers`, each with `provider`, `label` and its `listings` (`id`, `name`, `days`, `price_micro`, `quota`, `quota_captured_at`). An agent with nothing for sale is left out, and nothing says who sells it or which account it is. See Tickets.             |
| `POST /service/listings/{id}/purchase`   | Signed in | Buys a ticket from the wallet and returns its key, whole, once. 402 when the wallet cannot cover the price, 404 when it is not for sale or was sold just now, 422 for one's own ticket, 502 when its account does not answer a test request (nothing is charged). Has the budget of a top-up. |
| `GET /service/tickets`                   | Signed in | The tickets the user bought, newest first, without their keys: `key_id`, `name`, `provider`, `days`, `price_micro`, `last_four`, `purchased_at`, `expires_at`, `status` (`active` or `expired`).                                                                                              |
| `POST /service/tickets/{key_id}/reissue` | Signed in | A new key for the same ticket, whole, once, with the same end; the old one stops. 404 for a ticket that is not the user's, or that has ended.                                                                                                                                                 |
| `GET /service/keys`                      | Signed in | The active service keys, newest first: `id`, `last_four`, `created_at`, `last_used_at`.                                                                                                                                                                                                       |
| `POST /service/keys`                     | Signed in | Makes a service key and returns it, whole, once. 422 when the user already holds 20.                                                                                                                                                                                                          |
| `DELETE /service/keys/{id}`              | Signed in | Revokes a service key; 404 for a key of another kind or another user's.                                                                                                                                                                                                                       |
| `GET /service/usage`                     | Signed in | `days` (1 to 365, default 30): requests, tokens and `spent_micro`, by day, and by key and model.                                                                                                                                                                                              |

`SERVICE_TEST_TOP_UP=true` lets a top-up succeed without a payment. It is for
staging, and it applies only while Stripe is not set up: with Stripe set up a
top-up is always a card payment. Without either, a top-up answers 501.

## Paying in

A top-up by card is Stripe Checkout, and the wallet is credited only by Stripe's
webhook, never because a customer came back to the page. `stripe.rs` holds it.

1. `POST /service/top-up` records a `pending` row in `service_top_ups` (the
   customer, the amount in whole cents) and opens a Checkout Session for that
   amount in USD, with the top-up's id as `metadata[top_up_id]` and the customer
   as `client_reference_id`. It returns the session's URL, and the page sends the
   customer there. Stripe is asked with an idempotency key, so a retry does not
   open a second session. If Stripe refuses, the top-up is marked `expired`.
2. The customer pays on Stripe's page, which sends them back to
   `/service/pricing?topup=success` (or `=cancelled`). The page says so and reads
   the balance again a few times, since the webhook can arrive after the customer.
3. Stripe calls `POST /stripe/webhook`. The signature is checked first: the header
   is `t=<time>,v1=<hex>`, and `v1` is the HMAC-SHA256 of `<t>.<raw body>` under
   `STRIPE_WEBHOOK_SECRET`, compared in constant time, with any one of several
   `v1` values allowed (Stripe's secret rollover) and a timestamp more than five
   minutes off refused. Then for `checkout.session.completed` (and
   `checkout.session.async_payment_succeeded`) of a paid session, `complete_top_up`
   locks the top-up's row and, in one transaction, marks it `paid`, raises the
   wallet and writes the ledger row. It credits only when the amount paid is the
   amount the top-up asked for and the customer is the one it was opened for;
   otherwise it credits nothing and logs it, because money was taken and a person
   has to look. A second report of the same payment, even at the same moment,
   finds the top-up paid and changes nothing. `checkout.session.expired` closes a
   top-up that is still pending.

   Every signed event is answered 200 once it has been dealt with, including those
   that call for nothing, because any other answer makes Stripe send it again and
   that is wanted only when the database failed (500).

Setting it up in test mode:

- Put the test keys in the environment: `STRIPE_SECRET_KEY` (`sk_test_…`) and
  `STRIPE_WEBHOOK_SECRET` (`whsec_…`), set together or not at all (the API refuses
  to start with one). `STRIPE_API_URL` overrides Stripe's address, for tests.
- Locally, `stripe listen --forward-to localhost:8080/stripe/webhook` prints the
  signing secret to use, and the test card `4242 4242 4242 4242` (any future
  expiry, any CVC) pays.
- On an environment, add a webhook endpoint in the Stripe Dashboard (test mode)
  for the events above, at the API's public address (`/api/stripe/webhook` behind
  the nginx edge), and use its signing secret.

Tested without Stripe: the signature rules, the Checkout request (against a local
server that records it), duplicate and concurrent webhooks, and every case where
nothing is credited. Not tested against Stripe itself.

## Pages

The SERVICE group in the sidebar has Pricing, Usage and Keys, all under
`_app.service` whose layout keeps "Your balance" and the Top up button on top of
every page of a signed-in user. A visitor sees no bar at all, and only Pricing:
Usage and Keys are disabled items in the sidebar, and opening their URLs sends
the visitor to Pricing.

The Top up button opens a dialog with preset amounts and a field for any amount
from $1 to $1,000. Where Stripe is set up (`card_top_up`) the button reads "Pay
$10.00 by card", asks for whole cents, and sends the customer to Stripe; on the
way back (`?topup=success` or `?topup=cancelled`) the layout says how it went,
takes the mark off the address and reads the balance again at once and after 2,
5 and 10 seconds, since the webhook that credits it can arrive later. Where only
test top-ups are on (`test_top_up`) it reads "Top up $10.00" and credits the
wallet at once; with neither it says top up is not available yet.

- **Pricing** (`/service/pricing`) is where tickets are bought, and is open to a
  visitor to look at: a grid of cards, three across on a wide screen, one per agent
  that has a ticket for sale (`GET /service/listings`); an agent with none has no
  card, and with nothing for sale there is a line saying so and no card at all. A
  card has the agent's icon, how many plans it has, and a row for each: its name,
  how many days its key lasts, what the account had left when it was put on sale
  (the provider's own words, with when it was read, since it is not live), the
  price and a Buy button. Nothing says who sells it or which account it is. A
  visitor who presses Buy gets the sign-in dialog. A signed-in customer whose balance
  is below the price sees the button disabled, with what to top up; otherwise Buy
  asks first (how much, from what balance, which account, for how long, that the key
  is shown once) and then shows the key once with a Copy button, after which the
  ticket is gone from the page and the balance is lower. A refusal is said in the
  dialog, which stays: a ticket sold just now, a wallet that cannot cover it, an
  account that did not answer a test request (nothing is charged). Under the cards,
  "Your tickets" lists what the customer bought without the keys (the last four,
  when it ends, Active or Ended), with a "New key" button on an active one that asks,
  then shows a replacement once and stops the old key. The page does not show the
  per-token price list; `GET /service/pricing` is still read for the top-up flags.
- **Usage** (`/service/usage`) shows what the service keys sent and what it cost:
  requests, input and output tokens and the amount spent, a chart by day, and a
  table by key and model with what each was charged.
- **Keys** (`/service/keys`) makes, lists and revokes service keys. A new key is
  shown whole once, with a Copy button; the list shows it masked
  (`hw_svc_********` and its last four) with when it was made and last used. Under
  the list, "Use a key" reads top to bottom as:
  - **Agent** and **Model**, taken from Pricing (an agent the stock has no account
    for is listed as unavailable and cannot be chosen);
  - **Key**, a password field that a key just made fills (a key is shown once, so
    an older one has to be pasted);
  - **Copy**, on the right, and below it the **curl** command for that agent and
    model, carrying the key in the field or `YOUR_SERVICE_KEY` while it is empty;
  - **Run test**, which sends that same request from the page and streams the
    answer under the button. The message is fixed ("Hello, how are you?"), so the
    command and the test say the same thing.

  The bodies are the ones the Playground sends, one per agent
  (`service-key-test-request.ts`), so the same agents answer them. The test is a
  real request straight to the gateway with `credentials: "omit"`, so only the key
  is tried and the browser session is not used; it is charged like any other
  request, and the balance above is read again when it ends. A refused key,
  balance or model shows the gateway's own message. Below these, the rules: name a
  model from Pricing, each request is charged to the balance, and a service key
  never uses the user's own agents.

## Not built yet

- **Payments in production.** Card top-ups are built on Stripe's test mode and
  have not been run against Stripe. A live Stripe account needs a business in a
  country Stripe supports.
- **A log of changes to tickets.** The dashboard puts a ticket on sale and
  changes it ([Dashboard](./dashboard.md#hub-williams-tickets)), but keeps no
  record of who did it.
- **Prices from cost.** The rows are the agents' official API prices, not what the
  accounts cost the platform; the quota that would measure that is recorded in
  `gateway_usage_events.quota`.
- **Capacity.** A request goes to the first stock account that is available, with
  the failover every account has; nothing balances load across the stock or
  limits what one customer takes of it.
