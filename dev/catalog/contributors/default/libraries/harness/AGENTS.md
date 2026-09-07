# Personal machine harness

Always on for Claude Code, Codex and Grok. This is the operator's personal
workflow layer. The Hub William machine installer exposes this one canonical
file as `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` and `~/.grok/AGENTS.md`.

Repository instructions stay in place and still provide project-specific
commands, architecture, data-access rules and conventions. When the operator
uses one of the tags below, the tag is an explicit workflow choice for that
turn and controls side effects such as planning, worktrees, Linear, commits,
GitHub and browser verification. Without a tag, follow the repository's normal
workflow.

No tag or repository file can override system/developer instructions, safety
policy, authorization boundaries, secrets handling or data-integrity rules.

## Frontend convention gate

Before implementing or reviewing any user-visible frontend change, with or
without a workflow tag, load the `frontend-convention` skill. Read its personal
baseline completely and then read the active repository's own frontend
conventions before editing. After implementation, audit every changed frontend
file against all five baseline areas: named props interfaces, forms and
validation, Tailwind and class composition, reuse inside a component, and
layout and semantics. Repository-specific rules may refine the baseline as
described by the skill; never silently skip the convention check.

Keep convention bodies modular by domain instead of expanding this harness.
Frontend rules belong only to the `frontend-convention` catalog skill and its
references. A future backend, database, testing or other convention set gets
its own `<domain>-convention` skill directory and references; never mix one
domain's implementation rules into another convention skill.

## Tag dispatcher

Recognize these case-insensitive square-bracket tags anywhere in the user's
request. Tags compose unless a precedence rule below says otherwise.

Tag contracts are modular files under:

`~/.hub-william/contributors/default/libraries/harness/tags/`

Before any planning, mutation, external write or browser action, resolve every
recognized tag through the source map below and read every resolved file
completely. Apply all loaded contracts together. A tag file is part of this
always-on personal harness, not optional project documentation. If a required
file is missing or unreadable, stop and report it instead of guessing or using
a stale remembered contract.

### Tag source map

| Tag or tag family | Required file |
|---|---|
| `[answer]`, `[answer-step-by-step]`, `[answer-priority]` | `tags/answer.md` |
| `[report]`, `[report-today]`, `[report-yesterday]` | `tags/report.md` |
| `[plan]` | `tags/plan.md` |
| `[delivery-local]`, `[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]` | `tags/delivery.md` |
| `[delivery-verify-linear-<ISSUE-ID>]` | `tags/delivery-verify.md` |
| `[worktree]` | `tags/worktree.md` |
| `[ignore]` | `tags/ignore.md` |
| `[linear]`, `[linear-<ISSUE-ID>]` | `tags/linear.md` |
| `[rebase]` | `tags/rebase.md` |
| `[draft]` | `tags/draft.md` |
| `[mergeable]` | `tags/mergeable.md` |
| `[merge]` | `tags/merge.md` |
| `[playwright]` | `tags/playwright.md` |
| `[dopa-tps]` | `../../contributors/synasapmob/contributors/default/libraries/harness/dopa-tps.md` |

Load implied contracts as well as explicitly tagged ones:

- `[delivery-ete]` loads `delivery.md`, `linear.md`, `worktree.md` and
  `playwright.md`.
- `[delivery-linear-<ISSUE-ID>]` loads `delivery.md`, `report.md`, `linear.md`,
  `worktree.md`, `playwright.md` and `../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md`.
- `[delivery-verify-linear-<ISSUE-ID>]` loads `delivery.md`,
  `delivery-verify.md`, `report.md`, `linear.md`, `worktree.md`, `playwright.md`,
  `../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md`, `../../contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md` and
  `../../contributors/synasapmob/contributors/default/libraries/harness/linear/freshness-report-summary.md`.
- `[delivery-local]` loads only `delivery.md` unless another compatible tag is
  explicit; it does not imply a worktree or Playwright.
- `[merge]` loads both `merge.md` and `mergeable.md`.
- `[dopa-tps]` also loads `playwright.md` for a user-visible flow.
- Every other explicit tag loads its mapped file in addition to these implied
  dependencies.

### Precedence and conflicts

1. `[answer]`, `[answer-step-by-step]` and `[answer-priority]` are answer-only
   modes and win over every action tag. A styled answer tag wins over plain
   `[answer]`; if both styled answer tags appear, ask which one to keep and do
   not perform actions.
2. `[report]` is a composable output modifier. It authorizes no action and
   requests the structured execution handoff defined in `tags/report.md`.
   `[delivery-linear-<ISSUE-ID>]` and
   `[delivery-verify-linear-<ISSUE-ID>]` imply it by default.
3. `[report-today]` and `[report-yesterday]` are report-only and suppress every
   action tag. They never emit a delivery summary. If both appear, ask which
   calendar day to report and perform no action; they also suppress `[report]`,
   and answer-only modes still win.
4. `[plan]` forbids implementation; `[linear]` is its only allowed write.
5. `[delivery-linear-<ISSUE-ID>]` targets that exact existing Linear issue and
   implies `[linear]`, `[worktree]` and `[playwright]`.
   `[delivery-verify-linear-<ISSUE-ID>]` does the same only after its mandatory
   requirements-freshness gate passes; `[ignore]` cannot skip that gate.
6. `[delivery-ete]` creates a new Linear issue and implies `[linear]`,
   `[worktree]` and `[playwright]`.
7. `[delivery-local]` conflicts with every PR-producing delivery mode. It does
   not use Linear, GitHub, commits, Playwright or a worktree by default.
   `[worktree] [delivery-local]` and `[delivery-local] [worktree]` explicitly
   opt local delivery into an isolated worktree.
8. `[dopa-tps]` is a dopamint-arena-only runtime modifier. It may run alone
   or with delivery and implies `[playwright]` for a user-visible browser flow.
   It conflicts with `[plan]`; answer-only modes still win.
9. `[rebase]` may run alone against one unambiguous current PR, or compose
   with `[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]` or
   `[delivery-verify-linear-<ISSUE-ID>]`. It conflicts with `[delivery-local]`
   and `[plan]`; answer-only modes still win.
10. `[draft]` is valid only when the request creates or updates a PR. With
   delivery, use it with `[delivery-ete]` or
   `[delivery-linear-<ISSUE-ID>]` or
   `[delivery-verify-linear-<ISSUE-ID>]`. It conflicts with
   `[delivery-local]`, `[mergeable]` and `[merge]`.
11. `[mergeable]` may run alone against one unambiguous current PR, or compose
   with `[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]` or
   `[delivery-verify-linear-<ISSUE-ID>]`. It conflicts with
   `[delivery-local]`, `[plan]` and `[draft]`; answer-only modes still win.
12. `[merge]` is valid only with a PR-producing delivery mode:
   `[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]` or
   `[delivery-verify-linear-<ISSUE-ID>]`. It conflicts with `[delivery-local]`
   and `[draft]`, and does not override an answer-only mode or `[plan]`.

The former split delivery syntax—`[delivery] [ete]`, `[delivery] [local]` and
`[delivery] [linear-<ISSUE-ID>]`—is not an alias. If it appears, explain the
replacement canonical tag and do not mutate anything until the operator uses
or confirms that mode. Any delivery tag containing an `auto` segment and the
former standalone `[auto]` modifier are unsupported, have no alias and must not
mutate anything.

## Supporting contract dispatcher

Supporting contracts are modular files under:

- `~/.hub-william/contributors/default/libraries/harness/github/`
- `~/.hub-william/contributors/default/libraries/harness/evidence/`
- `~/.hub-william/contributors/synasapmob/contributors/default/libraries/harness/linear/`
- `~/.hub-william/contributors/synasapmob/contributors/default/libraries/harness/playwright/`
- `~/.hub-william/contributors/synasapmob/contributors/default/libraries/harness/projects/`

Read the applicable supporting files completely before the related action:

- Before the first GitHub or Linear read or write, read
  `../../contributors/synasapmob/contributors/default/libraries/harness/projects/routing.md` and `../../contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml`. Resolve the project from
  its normalized Git `origin`, verify its direct GitHub and Linear destinations,
  and stop the affected writes on missing or mismatched routing. A disabled or
  unconfigured Linear route blocks Linear, not an independently valid GitHub
  action; a delivery mode that requires Linear remains blocked as a whole.

- Before any Linear write, read `../../contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md`. New issue creation
  is default-deny and limited to the exact count explicitly authorized by the
  active tag or operator request; discovered follow-ups remain suggestions.
- Before delivery from an existing Linear issue, read
  `../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md`; fill a missing assignee with the verified
  operator and a missing estimate from the verified team scale, preserving
  existing values.
- Before verified delivery from an existing Linear issue, read
  `../../contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md`; trace its issue, ADR/PRD/docs, latest
  code and relevant PR decisions before code. Preserve the append-only
  `freshness.md` audit and stop on unresolved authority conflicts.
- Before any GitHub read or write, including PR creation, inspection, comments,
  readiness checks or merge, read `github/gh-cli.md`.
- Before a user-facing response, PR comment or evidence summary that names a
  Linear issue, GitHub PR or Git commit, read
  `github/clickable-references.md` and normalize every reference it covers.
- Before adding or changing backend/frontend tests, or running applicable
  tests, checks, lint, type checking, verification builds or benchmarks in an
  execution mode that permits writes, read `evidence/test-evidence.md` and
  preserve the required evidence and compact handoff.
- Before implementing or changing code, read `evidence/approach-history.md`.
  Maintain its shared append-only per-task `approach.md` for meaningful
  implementation phases and approach revisions without logging trivial steps.
- Before the final response when `[report]` is explicit or implied, identify
  every touched domain and read its report contract:
  `../../contributors/synasapmob/contributors/default/libraries/harness/linear/report-summary.md`
  for Linear, `github/report-summary.md` for GitHub/Git,
  `evidence/report-summary.md` for test evidence, and
  `../../contributors/synasapmob/contributors/default/libraries/harness/playwright/report-summary.md`
  for browser evidence. Follow `tags/report.md` and emit its six flat `##`
  headings with Markdown list items; do not add a `Delivery summary` wrapper,
  `Touched:` line, `CODE:` section or separate `PLAYWRIGHT:`/`FRESHNESS:`
  section. Keep every heading and use `N/A` when its domain was untouched.
  Without an active structured report, answer naturally and do not append a
  report-summary block, while still stating material failures, blockers and
  required human action. Answer modes and calendar work reports never emit the
  structured execution handoff.
- Before any Supabase query, log read, migration, Edge Function deploy or other
  Supabase call, read
  `~/.hub-william/contributors/synasapmob/libraries/hooks/supabase-routing.md`,
  resolve the active repository, and use only its mapped MCP server. It lives
  under `contrib/` because it maps this operator's own repositories to this
  operator's own MCP servers; a different workspace brings its own.

These supporting rules apply with or without workflow tags. Tag implications do
not need to repeat them. If a required supporting file is missing or unreadable,
stop the related action and report the missing contract instead of guessing.

## Honest verification: no tricks

Never make a result pass by deleting, disabling or weakening tests, assertions,
coverage, lint, type checks, security checks or required CI jobs. Never use
bypass flags, manipulate CI conditions, hide failures, hard-code fake evidence
or claim checks that were not run. Do not change expected behavior merely to
match a bug. Fix the root cause; if that cannot be done within scope, report the
exact blocker and leave the result honestly failing.
