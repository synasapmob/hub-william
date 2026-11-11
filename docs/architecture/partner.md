# Partner API

Shops that sell on our behalf read the catalogue through `GET /partner/products`. The same keys also decide who may use the bot's internal routes, so one rule answers "who is calling and what may they do". The code is in `apps/api/src/api/access/` (keys and permissions) and `apps/api/src/api/partner/` (the route).

## Keys and permissions

`SHOP_KEYS` holds `name:key` pairs separated by commas, for example `telegram:<key>,shopwatcher.org:<key>`. The environment says who a key belongs to; the table `GRANTS` in `api/access/mod.rs` says what that name may do, so a permission is reviewed in a pull request. Handlers ask for a `Permission`, never for a name.

| Permission     | Opens                              | Held by    |
| -------------- | ---------------------------------- | ---------- |
| `Internal`     | every `/internal/telegram/*` route | `telegram` |
| `ProductsRead` | `GET /partner/products`            | shops      |

- **A name with no line in the table may do nothing.** A key added to `SHOP_KEYS` before its line reaches the table opens nothing. A test pins that only `telegram` holds `Internal`, so a shop key never opens the bot's routes.
- **Parsing.** A name is lowercase letters, digits, `.`, `_` or `-`, so a partner can be named by its domain. A key is at least 32 visible characters and unique. An entry that breaks a rule is skipped and named in the log without its key; it does not stop the API, because the gateway runs in the same process. `openssl rand -hex 32` makes a key.
- **Sending a key.** `Authorization: Bearer <key>`. The bot's `x-hub-william-telegram-token` header is read too, for every key. All keys are compared in constant time.
- **The bot's key.** The `telegram` entry is the bot's key. The bot sends it when it calls the API, and the API presents the same key when it calls the bot ([dashboard](./dashboard.md)), so it must equal the bot's own key exactly. Without it every `/internal/telegram/*` route answers `403` and the dashboard cannot reach the bot. `TELEGRAM_SERVICE_TOKEN` is no longer read on the API, which logs a notice at start if it is still set.
- **Add a shop.** Append `name:key` to `SHOP_KEYS` and add a line for the name to `GRANTS`. **Revoke** by removing the entry. A change to the variable takes effect when the API restarts.
- **Names are public.** The repository is public, so the names in `GRANTS` are readable by anyone. Never commit a key.

## `GET /partner/products`

Public through the storefront's `/api/*` proxy; only `/api/internal` is blocked at the edge, so this route is reachable from the internet and its protection is the key.

- **Response.** Providers with something on sale, each with its products: `id`, `plan`, `variant`, `detail`, `category`, `warranty` (`WF`, `W7D`, `NW`), `price_vnd` and `in_stock`. The count on hand, what unpaid orders hold, the `hot` flag and the buyer notes are not shared.
- **Errors.** `401` (`invalid_partner_key`) without an issued key, `403` for a key that may not read products, `429` with `Retry-After` when over a limit.
- **Cache.** The list is read from Postgres at most every 30 seconds however many shops ask, under one lock, so a burst is one query. The response carries `Cache-Control: private, max-age=30`. A shop that reads every 15 to 30 minutes never notices.
- **Limits.** Ten requests a minute per name (`Limit::PartnerKey`). A request without an issued key counts against its IP (`Limit::PartnerFailedAuth`): the first ten in a minute get `401`, the rest `429`. A valid key is never held back by those failures. The key is read first on purpose, so a client IP that goes wrong cannot lock the shops out. The template does not set `X-Real-IP` itself: behind a plain nginx, `TRUST_PROXY_HEADERS` off or `CLIENT_IP_HEADER=x-forwarded-for` puts every client in one bucket and `x-real-ip` can be forged, and limiting by IP first would let anyone lock every shop out with ten bad requests. On Railway the edge sets `X-Real-IP` to the client address, so the per-IP limits are per client there ([deployment](./deployment.md#api-runtime)). A guessed key is kept out by its length, not by this limit, so make keys with `openssl rand -hex 32`. Buckets are in memory per process.

## Not built

- Keys cannot be created, listed or revoked at run time, and there is no record of when a key was last used.
- Field-level permissions (for example showing price to some shops only) and write permissions such as creating an order.
