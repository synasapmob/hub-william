# Dashboard

The dashboard is a React Router SPA in `apps/dashboard`, a back office for the shop and its staff: stock, orders, history, revenue and staff. Every page runs on the real API: sign-in, the Telegram shop's stock, orders, history, revenue and staff, the messages the bot sends, and Hub William's tickets (the agent accounts the staff sell) with the ones that were sold. What customers pay into their wallets is not shown yet; what they pay for a ticket is, in the Sales history. It shares nothing with `apps/frontend` at runtime; the two apps only share a design (the same Tailwind theme and shadcn primitives, copied into `apps/dashboard/src/components/ui/` and `public/css/index.css`).

It runs on port 5174 (`pnpm dashboard:dev`) so it can sit beside the storefront on Vite's default port. The UI is Vietnamese, except the sidebar, whose labels are English (Shop: Inventory, Orders, Sales history; Management: Revenue, Staff), and the screens before the dashboard, which are English too: login, register, "No access to the dashboard", and log out. They use the storefront's words (Login, Register, Log out). The server's own messages are shown as they come, so a refused save or an unknown username is English inside a Vietnamese page. Amounts are in đồng or dollars.

## Pages

Routes are file-based (`flatRoutes()`), all inside the `_app` layout. `/` redirects to the first page the signed-in role may open (`routes/_app._index`).

| Path       | Route module   | Purpose                                                                                                                                                                                                                                                                    |
| ---------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/pos`     | `_app.pos`     | Stock as one card per provider: Telegram's packages, and Hub William's tickets. Search, filter by type, add (from a provider's card, or from the header, which asks Telegram or Hub William first), edit one with its pencil button, add or take stock, delete.            |
| `/orders`  | `_app.orders`  | The bot's orders, newest first, 20 to a page, from the server. The status tabs start on Tất cả; awaiting payment (oldest first), paid and cancelled follow, each with its count. Search by reference, buyer or item. Mark paid (choosing how the money arrived) or cancel. |
| `/history` | `_app.history` | What was sold, for Telegram (paid orders grouped by day, in đồng) or Hub William (tickets, in dollars), filtered by range and seller, with a full-width search above the table, the number sold and what they come to.                                                     |
| `/revenue` | `_app.revenue` | Takings against the previous period of the same length, a daily chart, best sellers, by seller. Telegram only, in đồng.                                                                                                                                                    |
| `/staff`   | `_app.staff`   | The team with what each did today, role changes, add a member by username, remove a member, and the permission matrix.                                                                                                                                                     |

## Stock

`/pos` is the one page that manages stock. Its header is a search box (it matches the name), a dropdown that filters by type (Mọi loại, Telegram, Hub William) and "Thêm hàng". The body is one card per provider (ChatGPT, Claude, Grok…), in the order the shop keeps them, in one column on a phone, two on a tablet and three on a wide screen. A card has the provider's icon and name, its type badge, how many packages it holds and how many are left, then one row for each package: its name and variant, "Hot" and "Đang ẩn" badges, the warranty, what is left (amber from 5 down, red "Hết hàng" at 0) and the price. Every package is listed, however many; nothing is folded away.

The icon is the one Hub William shows for that agent. `public/assets/` holds copies of `apps/frontend/public/assets/*-icon.*` for ChatGPT, Claude, Gemini, Grok, DeepSeek and Groq, and `utils.provider-icon.ts` finds the file by the provider's name in any case (a shop may write "ChatGPT" or "chatgpt"). A provider Hub William has no icon for, such as one the shop sells on its own, shows its first letter instead. When Hub William changes an icon, copy the file again.

A package is edited with the pencil button at the end of its row, which opens the form filled in; pressing the row does nothing, so a stray click cannot open it. "Thêm gói" at the foot of a card opens the same form for a new package, with that provider filled in and the cursor on the package's name. "Thêm hàng" in the header first asks Telegram or Hub William; Telegram opens the form empty, on the provider. The provider is chosen from a popover (`components/provider-select.tsx`) and never typed, so a typing slip cannot make a card of its own: it lists the six agents Hub William supports, in its own order, each with its icon, and adds any provider the shop already sells under another name, so those packages can still be edited. The API matches providers by their slug, so "claude" is "Claude". A search shows only the rows that match, and a provider with none has no card.

The form (`stock-form-dialog.tsx`) has the provider (chosen from a popover), the name fields, the price, the switches, the Telegram message, and a stock adjuster that adds or takes an amount and says what the count comes to before saving. There is no picture to choose: the icon of the provider is what shows, on its card and everywhere the dashboard names it. A package that already had a picture keeps it when it is edited (the form sends back the address it had), and a new one has none. Limits follow `apps/api`: price 0 to 1,000,000,000 đồng, a first stock of 0 to 1,000,000, one addition of at most 100,000, a slug that does not already exist. The form does not show the slug; it only says "Đã có gói này rồi." when the package exists.

The two kinds of card (`StockType` in `src/services/sales/sales-types.ts`) sell different things:

|         | `telegram`                                                               | `hub-william` (the Service)                                                              |
| ------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Card    | A provider and its packages: plan, variant, warranty (`WF`, `W7D`, `NW`) | An agent that has a ticket on sale, and its tickets; none, no card                       |
| Row     | A package, counted in units; what orders hold is reserved                | A ticket: one agent account of the staff, sold once, for some days, at a price           |
| Money   | VND, whole đồng                                                          | USD, in micro-dollars (1 USD = 1,000,000), as the wallet keeps it, whole cents           |
| Changes | Name, price, stock, shown or hidden, deleted                             | Name, days, price, on or off sale, taken off sale; sold, it leaves for the Sales history |

VND and USD are never added together: totals, tiles and charts show one amount per currency.

`/pos` reads and changes the Telegram stock through `stockService` (`src/services/stock/stock-service.ts`), which calls the API below. An edit that also moves the count is two calls, the fields first and then the difference in stock; the list is refreshed whether they succeed or not, since the first can land when the second does not. A refused save keeps the form open, with what was typed, and says why. A package's picture, when it has one, is sent back as it came.

`TelegramProduct` keeps the field names `GET /internal/telegram/catalogue/full` already returns.

## Hub William's tickets

Hub William is a stock of its own, apart from the Telegram shop: nothing in one changes the other. They live in different tables and have their own money. Telegram counts packages (`telegram_products`). Hub William sells **tickets** (`service_listings`): a member of the staff puts one of their own agent accounts on sale for a number of days at a price, and a customer who buys it pays from their wallet once and gets a key that runs on that one account until the days are up. Nothing is charged by the token. Both are on `/pos`, as Hub William cards beside the Telegram ones; the type filter shows one kind or both. `serviceStockService` (`src/services/service-stock/service-stock-service.ts`) reads and changes them.

- **What is on the page.** A card is one agent (ChatGPT, Gemini, Claude, DeepSeek, Grok, Groq, in Hub William's own order) and **exists only while it has a ticket to show**: with nothing on sale there is no card, and the first ticket is added from the header. Its header says how many tickets it holds, then each ticket is a row: its name, how many days it lasts, what its account had left (the provider's own words, such as "5-hour limit 80% left"), a badge when it is not for sale (`Đang ẩn`, `Cần kết nối lại`, `Account đã gỡ`), and its price. A ticket that is sold is no longer here: it is a sale in the history. A ticket that is not for sale because it is switched off or its account needs attention stays, with its badge, so the seller can see what to fix; only the ones for sale are shown to customers.
- **Adding.** "Thêm hàng" in the header first asks which stock, Telegram or Hub William (`add-stock-kind-dialog.tsx`). Hub William opens `service-listing-form-dialog.tsx`: the agent (a popover with the six), how many days the key lasts (from the moment it is bought, 1 to 365, 7 to start with), the price in dollars (whole cents, $0.01 to $10,000, worked out on the digits), and the account, connected and verified there. "Thêm" waits for the verification. "Thêm gói" in an agent's card opens the same form on that agent. The ticket is named after what was verified (the agent, the plan of the account and the days), and can be renamed with its pencil.
- **Connecting the account** (`service-account-connect.tsx`) is the Agents page's own flow, asked through the same endpoints with the same session (`agentConnectionService`): ChatGPT, Claude and Gemini sign in at the provider: "Lấy link đăng nhập" opens the provider's page in a window of its own (opened in the click and pointed at the provider once the sign-in has started, as the Agents page does, so the browser does not take it for a popup nobody asked for; "Mở lại trang đăng nhập" opens it again) and the person pastes the address it sends them back to; Grok does the same and shows a code, and finishes on its own; DeepSeek and Groq take an API key. **Verify** (`POST /dashboard/service/verify`) then asks the provider for something through that account, exactly as a customer's request would be answered, and reads what the account has left. ChatGPT, Claude and Grok say (the 5-hour and weekly windows, or credits); Gemini, DeepSeek and Groq do not, and then the form says so. A key that does not connect, or a verification that does not pass, is a toast with the reason and the form stays; verifying again does not connect again. The account is verified once more on the server as the ticket is made.
- **An account that is connected here and not put on sale is let go.** Closing the form, or choosing another agent, disconnects it (the same call as the Agents page), so no account is left in the seller's Agents that nobody asked for. Once the ticket is on sale the account is kept.
- **Editing** (`service-listing-dialog.tsx`): name, days, price and "Đang bán". It also shows the account (name, plan), the seller, the state and what the account had left when it was verified, with the time. "Gỡ khỏi bán" asks first and then takes the ticket off sale; the account is left as it was. A sold ticket cannot be edited or removed.
- **Search** matches a ticket's name, its agent, the name of its account and its plan; a search leaves only the agents it found something in.
- **The Sales history** (`/history`, type "Hub William") lists the tickets that were sold in the range, newest first: when, the ticket, who bought it, who sold it, the last four characters of the key the customer got, and what they paid. It counts them and adds up what they came to in dollars. The price is what was paid, whatever the ticket was changed to afterwards. Telegram's history is in đồng and the two are never added together. The Revenue page is still Telegram's only.
- **What is not done yet:** nothing watches the account after the sale. An account that is used up by its seller, rate limited, or disconnected leaves the customer with a key that does not work, and there is no refund or replacement. Hub William's own per-token Service (`/service/keys`, prices per model) is still there and untouched, but the dashboard no longer shows its price list.

## Roles and permissions

`rolePermissions` in `src/services/sales/sales-labels.ts` is the one table of what each role may do. Pages ask `can(permission)` and never look at a role.

| Permission | `owner` | `manager` | `cashier` | `stock-keeper` |
| ---------- | :-----: | :-------: | :-------: | :------------: |
| `orders`   |    ✓    |     ✓     |     ✓     |                |
| `history`  |    ✓    |     ✓     |     ✓     |                |
| `stock`    |    ✓    |     ✓     |           |       ✓        |
| `revenue`  |    ✓    |     ✓     |           |                |
| `staff`    |    ✓    |           |           |                |

The sidebar hides a link, and a group with no link, for a role without the permission. A page opened anyway renders `PermissionGate` instead of its data.

Everything sits behind `DashboardSessionGate` (`components/dashboard-shell/`), which asks `GET /dashboard/session` and shows one of four things: the dashboard for a member of staff, a sign-in form when there is no session, a refusal for an account that is not (or is no longer) staff, or "cannot reach the server" with a retry. An expired access session is refreshed once with `POST /auth/refresh`, as the storefront does. Signing in is the account's own username and password through `POST /auth/login`; there is no separate dashboard password. The sign-in screen also offers Register, which makes the same Hub William account the storefront makes (`POST /auth/register`: username, recovery email, password) and signs it in. That account is not staff, so the next screen is "No access to the dashboard", which names the account for the owner to add on `/staff`; an account that is an owner (a row of `dashboard_staff` with the role `owner`) goes straight in. Signing out ends the session and forgets everything fetched as that member of staff. Pages only ask `can(permission)`, and what a role may open is the API's answer, kept as it came; the API refuses the same requests on its own, so hiding a link is only a courtesy.

A staff member is added by the username of the account they registered (3 to 32 letters, digits, underscores or hyphens, the rule of an account in `apps/api`), not by a Telegram name, and signs in as exactly that account. Removing a member ends their access; there is no switch to lock one out, and the owner cannot be removed.

## Messages to the person

Every success and every failure is a toast, whichever page or form it comes from: logging in and out, registering, saving, deleting, marking paid, cancelling, changing a role, adding staff, putting a ticket on sale, verifying an account. A field that is not valid is the exception: it says so next to the field, as the form is being filled in, because it is a hint and not a result. A refused change keeps its form open, with what was typed.

A request that fails to load shows its panel with a retry, and a toast as well. Toasts are made for a failed query in one place, `createQueryClient` (`utils/utils.query-client.ts`), so a page cannot forget one; a query that fails again replaces its toast instead of stacking another. A refused change is reported by the page that asked for it, because only the page knows what it was doing.

The access session lasts five hours and the refresh session seven days. `sessionFetch` (`services/api/api-client.ts`) answers a 401 by refreshing the session once and asking again, so a dashboard left open overnight carries on. Only when the refresh fails does the 401 reach the page: `createQueryClient` then shows "Your session has expired", the session gate shows the login form, and what the pages fetched is forgotten once they are gone. A wrong password is a 401 with a code of its own (`invalid_credentials`) and is never taken for an expired session; "Log in to continue." (`unauthorized`) is.

## Telegram pushes

The form has an optional "Tin nhắn Telegram" box, for a new item and for an edit. Left empty (or with only spaces) it sends nothing. With text in it, the page saves the package first and then calls `POST /dashboard/telegram/announcements`: the bot posts exactly that text to the channel and sends it to everyone who pressed Start. The text is limited to 4,096 characters, Telegram's own limit, and the form refuses a longer one.

The toast says only what the bot reported: that it posted to the channel and is sending to N chats (they go one by one, at a pace Telegram allows, so N is how many it has started on), that there is no channel, or that there is nobody to send to. If the bot is not connected (`501`) or did not answer (`502`), the package is still saved and the toast says the message was not sent and why; it never claims a message went out. The page keeps no log of announcements.

`apps/telegram` holds the bot token and `apps/api` does not. So the API asks the adapter over HTTP, with the same shared secret the adapter uses to call the API (`TELEGRAM_SERVICE_TOKEN`, the same variable on both sides): `POST /internal/announce` for a message to the channel and the audience, and `POST /internal/payment-notice` to tell one buyer their order is paid. The API knows where the adapter is from `TELEGRAM_ADAPTER_URL`; without it the dashboard answers `501`.

## Lists

`components/table-pagination.tsx` pages a table: "Hiển thị 1–20 trong 100 đơn" and the pages to move between. Up to seven pages are all shown; past that only the first, the last and the ones around the current, with a gap between. `/orders` and `/history` use it at 20 to a page; the server pages, counts and totals, so a page never holds more than it shows. Any change of filter or search returns to page 1, and settling the last order of a page steps back to the last page that is left. The queue's `#` counts across pages. A search waits for a pause in typing before it asks the server, and `/orders` looks again every 15 seconds, since orders arrive from Telegram all day.

`/orders` asks how the money arrived before it marks an order paid (bank transfer, USDT or cash), because the order is paid once and for good. The server takes the stock, records who handled it and tries to tell the buyer through the bot; when the bot cannot, the order is still paid and the page says the buyer was not told, so a member of staff messages them. Cancelling asks first, since it returns the held stock and cannot be undone.

## Revenue chart

`components/revenue-chart.tsx` draws daily columns in HTML and CSS, not SVG, so text stays crisp and the chart is responsive. Columns are at most 24px, with a 4px rounded top and 1px of surface on each side. Each column is a button: hover or focus shows a tooltip, and a table view of the same numbers is one tab away. One chart has one currency and one series, so it has no legend and no second axis.

## The API

`apps/api/src/api/dashboard/` holds what the dashboard calls. Every route needs a signed-in account that is staff: no session is `401`, and an account that is not staff, or whose access is switched off, is `403`. Most routes also need a permission.

| Route                                                | Needs     | Does                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /dashboard/session`                             | any staff | Who is signed in, the role and its permissions.                                                                                                                                                                                                                                 |
| `GET /dashboard/telegram/products`                   | `stock`   | Every product, hidden ones included, with `on_hand`, `reserved` and `available`.                                                                                                                                                                                                |
| `POST /dashboard/telegram/products`                  | `stock`   | Makes a product; the slug is made once from provider, plan and variant. `409 already_exists` when it is taken.                                                                                                                                                                  |
| `PUT /dashboard/telegram/products/{slug}`            | `stock`   | Edits the name, warranty, price, flags and picture. The slug never changes, so orders keep pointing at it.                                                                                                                                                                      |
| `POST /dashboard/telegram/products/{slug}/stock`     | `stock`   | Puts in (up to 100,000) or takes out units. The guard against going below zero is in the SQL, so two changes made together cannot. Each change is kept in `telegram_stock_changes` with the account that made it.                                                               |
| `DELETE /dashboard/telegram/products/{slug}`         | `stock`   | Removes a product. Refused with `422` while a buyer has an order for it that awaits payment and has not expired; orders keep their own title and price.                                                                                                                         |
| `POST /dashboard/images`                             | `stock`   | Stores a PNG, JPEG, GIF or WebP of up to 5 MiB in the database. The type is read from the bytes, never taken from the upload, and SVG is not accepted.                                                                                                                          |
| `GET /dashboard/images/{id}`                         | any staff | Serves a picture.                                                                                                                                                                                                                                                               |
| `POST /dashboard/telegram/announcements`             | `stock`   | Has the bot send a text to the channel and to the audience. `501` when the dashboard is not connected to the bot, `502` when the bot did not answer.                                                                                                                            |
| `GET /dashboard/telegram/orders`                     | `orders`  | A page of orders by `status`, `q`, `page` and `page_size`, with how many orders each status has under the search. The queue is oldest first, the rest newest first.                                                                                                             |
| `POST /dashboard/telegram/orders/{reference}/pay`    | `orders`  | Marks an order paid by hand with `payment_method` (`bank_transfer`, `usdt` or `cash`), takes its stock, records who did it, and asks the bot to tell the buyer. Answers `notified`. `422` unless it awaits payment.                                                             |
| `POST /dashboard/telegram/orders/{reference}/cancel` | `orders`  | Cancels an order that awaits payment and records who did it.                                                                                                                                                                                                                    |
| `GET /dashboard/telegram/sales`                      | `history` | Paid orders in a range of shop days (`from`, `to`), by seller (`handled_by`, a username or `bot` for what SePay settled) and search, newest first, with the total in đồng and every seller there has been.                                                                      |
| `GET /dashboard/telegram/revenue`                    | `revenue` | Takings per day for `days` (7, 14 or 30) and the same number before, every day present, with the best sellers and the sellers of the period.                                                                                                                                    |
| `GET /dashboard/service/listings`                    | `stock`   | The tickets that are not sold, with their state (`for_sale`, `hidden`, `needs_reconnect`, `disconnected`), the account's name and plan, the seller and what the account had left when it was verified.                                                                          |
| `POST /dashboard/service/verify`                     | `stock`   | Asks the provider for something through an account the signed-in member connected, as a customer's request would be answered, and reads what the account has left. `422` for an account that is not theirs or not connected; `502` when the provider did not answer through it. |
| `POST /dashboard/service/listings`                   | `stock`   | Puts a verified account on sale: `connection_id`, `name`, `days` (1 to 365) and `price_micro` (whole cents, $0.01 to $10,000). The account is verified again. `409` when it is on sale already or its sold ticket has not ended.                                                |
| `PUT /dashboard/service/listings/{id}`               | `stock`   | Changes a ticket that is not sold: `name`, `days`, `price_micro` and `listed`. `404` once it is sold.                                                                                                                                                                           |
| `DELETE /dashboard/service/listings/{id}`            | `stock`   | Takes a ticket that is not sold off sale; the account is untouched. `404` once it is sold.                                                                                                                                                                                      |
| `GET /dashboard/service/sales`                       | `history` | The tickets that were sold, newest first, the last 500: buyer, seller, the price paid, the last four characters of the key and when it ends.                                                                                                                                    |
| `GET /dashboard/service/models`                      | `stock`   | The per-token price list of the older Service, every model with a price, listed or not. The dashboard does not show it.                                                                                                                                                         |
| `PUT /dashboard/service/models`                      | `stock`   | Adds a model or reprices the one with that `provider` and `model` (micro-dollars per million tokens).                                                                                                                                                                           |
| `GET /dashboard/staff`                               | `staff`   | Everyone who may use the dashboard, with the orders they marked paid today and when they last signed in.                                                                                                                                                                        |
| `POST /dashboard/staff`                              | `staff`   | Makes an existing account staff by username, as `manager`, `cashier` or `stock-keeper`. `422` when no account has that username, `409` when it is staff already.                                                                                                                |
| `PUT /dashboard/staff/{user_id}`                     | `staff`   | Changes a role, the owner's included. The last active owner cannot be given another role.                                                                                                                                                                                       |
| `DELETE /dashboard/staff/{user_id}`                  | `staff`   | Removes a member. Not oneself, and not the last active owner.                                                                                                                                                                                                                   |

Who is staff: an account with an active row in `dashboard_staff`, which `/staff` adds, changes and removes. Nothing in the environment makes anyone an owner: an owner is a row with the role `owner`, and may make other owners. The one rule is that the shop always has an active owner, so the last one cannot be demoted or removed (two owners who demote each other at the same moment leave one, since the owners' rows are locked while it is decided).

The first owner has no one to make them, so they are made in the database, once, for the account they registered:

```sql
INSERT INTO dashboard_staff (user_id, role)
SELECT id, 'owner' FROM users WHERE username = lower('<your username>')
ON CONFLICT (user_id) DO UPDATE SET role = 'owner', active = TRUE;
```

From then on the owner adds the team on `/staff`.

Days are shop days (UTC+7, `Asia/Ho_Chi_Minh`), so a sale at 01:00 belongs to the day the shop had. Every paid order records how it was paid (`payment_method`) and who handled it (`handled_by`); an order SePay settled has no one behind it and counts as a bank transfer. `Role::permissions` (`access.rs`) is the one table of what a role may do.

These routes are a second door onto the tables the bot sells from (`telegram_products` and its providers). The bot's internal routes keep working as they did; a product made through either is the same product. `insert_product` and `ensure_provider` in `telegram/catalogue.rs` are shared by both.

The client is generated from the published document: `pnpm --dir apps/dashboard api:generate` rewrites `apps/api/openapi.json` and `src/services/api/api.generated.ts`. A test keeps every operation id in the document unique, since a generated client names operations by it.

## Running it against the API

```sh
# The API (see apps/api/README.md). Make your account an owner of the dashboard once,
# in its database (the SQL is under "The API" above), and sign in with it:
pnpm api:dev

# The dashboard, pointed at it:
VITE_API_BASE_URL=http://localhost:8080 pnpm dashboard:dev
```

To have the bot send messages and tell buyers their order is paid, run `apps/telegram` as well and give the API its address and the shared secret (`TELEGRAM_ADAPTER_URL`, and the same `TELEGRAM_SERVICE_TOKEN` as the adapter's). Without them everything else works and a message is reported as not sent.

Create the account first: Register on the dashboard's sign-in screen, on the storefront, or with `POST /auth/register`. They are all the same account. Open `http://localhost:5174`, not `127.0.0.1:5174`: the session cookie is `SameSite=Lax`, which only sends it to the API when both are on the same site. Both local origins are already in the API's CORS list while `COOKIE_SECURE` is off.

## What is not there yet

- What customers pay in: top-ups by card are in `service_top_ups` and `service_ledger` and are not on any dashboard page, and Revenue shows the Telegram shop only. Nor can a wallet be looked at or credited by hand.
- A log of who put a ticket on sale or changed its price (the Telegram stock keeps one in `telegram_stock_changes`).
- Creating an order from the dashboard, if staff are to sell. `telegram_orders` holds one product and a quantity per order, so a cart of several packages would need a new shape.
- The dashboard no longer uploads pictures, but `POST /dashboard/images` and `GET /dashboard/images/{id}` are still in the API, and a package made before keeps its picture.
- A log of announcements, and a rate limit on the dashboard routes.
- The API's messages (a refused save, an unknown username) are in English and shown as they come, inside a Vietnamese page.

## Checks

`pnpm --dir apps/dashboard` runs `typecheck`, `lint`, `check:tailwind`, `format:check`, `test` and `build`; the root scripts run them with the frontend's. Tests sit beside the code they cover and use `src/test/render-page.tsx` to render a page as a given role.
