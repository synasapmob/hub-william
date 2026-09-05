# What Hub William is

Hub William is a private dashboard that answers two questions:

> **How much of my ChatGPT quota have I used, and when does it reset?**

> **What skills, experience levels, and companies are showing the strongest job demand right now?**

It connects one or more ChatGPT accounts and shows their Codex usage limits,
reset times, available limit-reset credits, and token activity on a single page.
It is a **reader**, not a gateway — it never routes model traffic, never proxies
requests, and never sits between a coding tool and OpenAI.

## Who it is for

The owner and a small number of manually approved people. Registration is open,
but new profiles land in `pending` and stay locked out until the owner flips them
to `approved` in Supabase. There is no self-serve access.

Approved profiles carry a role — `admin`, `moderator` or `member` — set the same
way. It governs one thing today: creating and revoking the gateway API keys that
proxy to every connected account, which only an `admin` can do.

## What it shows

| Page                   | Contents                                                                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Overview** (`/`)     | Tokens this week and week-over-week change, all-time tracked volume, connected account count, per-account share, daily token chart                                                             |
| **Agents** (`/agents`) | One row per connected ChatGPT account: plan, quota used, reset countdown, reset credits, last sync, and per-account actions; plus a Project usage card per tracked repository, for every agent |
| **Jobs** (`/jobs`)     | Role/location market demand, Top 10 hiring companies, and rule-based requirement profiles for tracked employers                                                                                |

## Scope boundaries

These are deliberate, and worth knowing before extending the app.

**One connected account, three tracked agents.** ChatGPT is the only vendor the
hub authorizes against, because it is the only one that exposes quota. Claude
Code and Grok Build are tracked through the telemetry they push, which is a
different thing: it reports what was spent, never what remains. Support for
OpenAI Admin keys and Google was removed — this is a usage tracker, not a
multi-vendor aggregator. See [technology-choices.md](./technology-choices.md)
for why Anthropic account-level usage in particular is not coming back.

**Quota is a Codex-only figure.** It comes from polling an authorized ChatGPT
endpoint that publishes windows and reset times. Claude Code and Grok Build push
telemetry instead, and telemetry describes consumption rather than entitlement,
so neither has a quota dial and neither is given an invented one.

**No cost figures except where reported.** A ChatGPT subscription reports no
per-token cost, and Grok Build's telemetry publishes none either — it documents
that you should join its token counts against your own price sheet. Both render
as _"Cost not reported"_ or `—` rather than being estimated from token counts.
Inventing a number would be worse than showing none.

**No model breakdown for Codex.** It reports one account-wide token total per
day, with no per-model split. The UI says so instead of guessing. Claude Code
and Grok Build both report a model per request, which is the only reason their
per-model rows exist.

**Read-only.** Nothing here consumes quota. Every figure comes from endpoints
that report usage; no model request is ever made.

## Honest limitations

**Connecting requires a manual step OpenAI does not expose.** _Enable device code
authorization for Codex_ must be switched on in ChatGPT's security settings.
Nothing in the API reports whether it is on, so the connect dialog can only send
the user there — it cannot verify the toggle. When it is off, approval silently
never registers and the code expires. That is why the expiry message names the
setting directly.

**The upstream endpoints are undocumented.** Quota is read from paths that
OpenAI has not published and has already renamed once. Parsing is deliberately
tolerant, but a breaking upstream change is a matter of when, not if.

## Related documents

- [architecture.md](./architecture.md) — how a connection and a sync actually work
- [technology-choices.md](./technology-choices.md) — what is used and why
- [frontend-conventions.md](./frontend-conventions.md) — code conventions
