# Harness quick guide

Tags are case-insensitive. Choose one canonical delivery, plan, answer or
report tag, then add compatible modifiers. The former split delivery syntax is
retired.

## Tag modules

The root harness is only the dispatcher, precedence and shared safety contract.
Full tag rules live under `contributors/default/libraries/harness/tags/`:

- `delivery.md`, `delivery-verify.md`, `answer.md`, `report.md`, `plan.md`,
  `linear.md`
- `worktree.md`, `playwright.md`, `guess.md`,
  `contrib/synasapmob/harness/dopa-tps.md`, `ignore.md`
- `rebase.md`, `draft.md`, `mergeable.md`, `merge.md`

The dispatcher must read every matched tag file and implied dependency
completely before acting. Delivery has exactly four canonical modes; delivery
tags containing an `auto` segment are unsupported and perform no action.

## Supporting modules

- `contributors/default/libraries/harness/github/gh-cli.md` — GitHub operations through `gh`.
- `contributors/default/libraries/harness/github/clickable-references.md` — clickable Linear,
  PR and commit labels with verified lifecycle markers.
- `contributors/default/libraries/harness/github/report-summary.md` — Git/PR final summary.
- `contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md` — default-deny issue
  creation budget and no automatic decomposition/blocking relationships.
- `contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md` — fill missing
  assignee/estimate metadata for delivery from an existing issue.
- `contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md` — pre-code and
  final traceability audit for verified existing-issue delivery.
- `contributors/synasapmob/contributors/default/libraries/harness/linear/freshness-report-summary.md` — compact
  freshness verdict, sources, reconciliation, conflicts and artifact handoff.
- `contributors/synasapmob/contributors/default/libraries/harness/linear/report-summary.md` — Linear final summary.
- `contributors/default/libraries/harness/evidence/test-evidence.md` — backend/frontend test
  logs, history and the compact final handoff.
- `contributors/default/libraries/harness/evidence/approach-history.md` — shared append-only
  per-task implementation approach and before/after flow.
- `contributors/default/libraries/harness/evidence/report-summary.md` — evidence final summary.
- `contributors/synasapmob/contributors/default/libraries/harness/playwright/report-summary.md` — browser flow,
  screenshots, observed/fixed bugs and scoped cleanup summary.
- `contributors/synasapmob/contributors/default/libraries/harness/projects/routing.md` — Git-remote-first GitHub,
  Linear and delivery-base preflight.
- `contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml` — direct per-project GitHub
  URL and Linear workspace/team configuration.
- `contributors/synasapmob/libraries/hooks/supabase-routing.md` — repository-to-MCP routing,
  migrations, deploys and token/CLI restrictions.

These files apply whenever their action occurs, even without a workflow tag.

## Decision authority

No-guess is the default for every chat. Before making a substantive decision,
read the latest applicable, non-superseded ADRs and decision records,
requirements/docs, current code/tests and relevant merged PR decisions. If
those sources already decide the behavior, wire it without asking again. If a
material choice is still missing, ambiguous or conflicting, ask the operator
one focused decision question before the affected mutation.

`[guess]` opts one turn into decision latitude for genuine authority gaps. It
lets the agent choose the best-supported hypothesis, think through downstream
effects and pursue adjacent next decisions needed for a coherent result without
asking first. Material assumptions stay explicit, observable consequences must
be verified, existing authority still wins, and all safety, authorization and
side-effect boundaries remain unchanged. `[plan] [guess]` may speculate only in
the plan; answer-only and report-only modes still perform no actions.

Linear issue creation is default-deny. `[delivery-ete]` may create exactly one
owning issue; `[plan] [linear]` may create exactly one
agreed-plan issue. An existing-issue delivery creates zero new issues. Every
bug, gap, TODO or adjacent improvement discovered while working stays focused
under the owning task or is reported as a `not created` suggestion. Never split
acceptance criteria into surprise child tasks, and never mark the current task
blocked merely because a follow-up could exist.

`[report]` is an opt-in structured execution handoff; it authorizes no side
effects. `[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]` imply it by default. Other execution
turns answer naturally unless `[report]` is explicit, while still exposing
material failures and blockers.

The structured report has exactly six flat headings in order: `## What we
changed`, `## Files touched`, `## Risky`, `## EVIDENCE`, `## GITHUB` and
`## LINEAR`. There is no `Delivery summary`, `Touched:` or `CODE:` wrapper.
Keep every heading and use `N/A` for untouched domains. `Files touched` marks
each task-owned path `(old)`, `(new)`, `(deleted)` or `(renamed)`. `Risky`
states evidence-backed risk, impact, affected cases, out-of-scope reason and
required human review; suggested follow-ups are `not created` and the human
decides whether to create a task. A delivery-invalidating defect is `BLOCKED`,
not deferred.

Tests, lint, type checking, builds, benchmarks, requirements freshness and
browser verification all live under `EVIDENCE`; do not add standalone
`FRESHNESS` or `PLAYWRIGHT` headings. `LINEAR` uses one top-level item per
issue, `GITHUB` one per PR/independent Git action, and `EVIDENCE` separate
Backend, Frontend, Freshness and Browser items when applicable. Keep every
issue, PR and commit clickable through the reference contract.

Clickable reference status uses these canonical UI tokens:

- Review — `#478be6`.
- Merged or verified Done — `#8256d0`.
- Draft, Local or In progress — `#656c76`.

Plain Markdown cannot guarantee the rendered link color, so the status must
also live in the label. The hex value is metadata for a supporting UI, not a
reason to emit unreliable inline HTML/CSS.

## Project routing

Before any GitHub or Linear action, normalize the current checkout/worktree's
Git `origin` to `owner/repository` and require one exact entry in
`projects/registry.yaml`. Directory names and conversation context never select
an external destination. Verify the configured GitHub URL with `gh repo view`;
for Linear, require the configured workspace URL and team key. An unknown
project or GitHub mismatch blocks both systems. Disabled, unconfigured or
mismatched Linear blocks Linear only, although a delivery requiring Linear is
therefore blocked as a whole.

The direct registry currently routes:

- `CommandOSSLabs/dopamint-arena` → its GitHub URL and
  `https://linear.app/commandoss`, team `DOPAN`.
- `Southern-Discoveries/hub-william` → its GitHub URL; Linear disabled.
- `Southern-Discoveries/sonix-study` → its GitHub URL; Linear unconfigured.

Do not cache an ordinary default branch in the registry. For new delivery,
fetch/prune and use fresh `origin/dev` when it exists, otherwise query GitHub's
current `defaultBranchRef`. For an existing PR, use its exact `baseRefName`.
Only an exceptional project may define `delivery_base_override`.

## Delivery

### Full ETE with a new Linear issue

- `[delivery-ete]` — create Linear, use its exact branch, work in a worktree,
  implement, test, verify, commit, push, create a PR and wait for green CI.
- Add `[draft]`, `[mergeable]`, `[merge]`, `[rebase]`, `[dopa-tps]`
  or `[ignore]` when that modifier's contract is wanted.

### Full ETE from an existing Linear issue

- `[delivery-linear-DOPAN-1645]` — deliver exactly that existing issue through
  the same worktree, verification, GitHub and CI flow; `[report]` is implied.
- Add the same compatible modifiers as `[delivery-ete]`.

### Verified ETE from an existing Linear issue

- `[delivery-verify-linear-DOPAN-1722]` — fetch/prune immediately before the
  audit, compare the exact issue against ADR/PRD/docs, code/tests at the latest
  fetched `origin/dev` (remote default only when `origin/dev` is absent) and
  relevant PR decisions, then deliver only after authority is resolved.
- `[report]` is implied for this mode too.
- Trace every requirement/AC to an exact source and current implementation
  state. Save the append-only audit at
  `/Users/synasapmob/orca/histories/<project>/DOPAN-1722/freshness.md`.
- If code already satisfies the current requirement, verify and update the
  issue without duplicate code or an empty PR. If authoritative sources still
  conflict, comment the exact blocker on the bound issue and stop before code.
- This mode creates zero new Linear issues. `[ignore]` cannot skip its
  freshness gate. It supports `[draft]`, `[rebase]`, `[mergeable]`, `[merge]`,
  `[dopa-tps]` and `[playwright]` when otherwise compatible.
- Fetch again before final handoff. If the base SHA advanced, update the task
  branch, rerun verification and repeat the freshness audit; never treat local
  `dev` or an earlier remote-tracking SHA as latest.

For every ETE issue, Linear's returned `gitBranchName` is the exact local,
remote and PR branch. Never add the Git username, blocker ID or worktree slug.

For `[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]`, read the existing issue before
implementation. If unassigned, resolve the operator's
authenticated Linear identity, assign it and verify by member ID. If estimate
is unset, resolve the team's configured point scale, estimate the remaining
scope/risk/verification burden, set it and verify. Preserve populated assignee
and estimate fields. Never guess identity/scale or create a replacement issue;
an unresolved metadata write is an explicit completion blocker.

### Local only

- `[delivery-local]` — implement and test in the current checkout; no worktree,
  Linear, commit, push or PR. Leave changes uncommitted for review.
- `[worktree] [delivery-local]` or `[delivery-local] [worktree]` — same local
  restrictions, but use an isolated worktree.
- Add `[playwright]`, `[dopa-tps]` or `[ignore]` when needed.
- Add `[guess]` only when the agent should decide unresolved behavior without
  waiting for operator confirmation.

Choose exactly one delivery tag. `[delivery-local]` cannot combine with
`[linear]`, `[rebase]`, `[draft]`, `[mergeable]` or `[merge]`. `[draft]` cannot
combine with `[mergeable]` or `[merge]`.

## `[plan]`

Discuss, investigate read-only, suggest options and produce a plan. Do not
implement, commit, push, create a PR or deploy.

- `[plan]` — plan only; no external writes.
- `[worktree] [plan]` — create a worktree first, then plan without coding.
- `[plan] [linear]` — create a new Linear issue from the agreed plan, attach the
  supplied plan file and stop.
- `[plan] [linear-DOPAN-1645]` — read the existing issue as planning context;
  do not update it.
- `[plan] [linear-DOPAN-1645] [linear]` — update that existing issue with the
  agreed plan and stop.

`[plan]` cannot be combined with a delivery tag, `[draft]`,
`[mergeable]` or `[merge]`.

## Answer

- `[answer]` — answer the question only. No plan, code, worktree, tests,
  browser, Linear, GitHub or deployment writes; no forced format.
- `[answer-step-by-step]` — answer only as `Chuẩn bị`, numbered execution steps
  beginning with `Bước 1 - Khởi tạo` and `Bước 2 - Xử lý cốt lõi`, then
  `Kiểm tra kết quả`.
- `[answer-priority]` — answer only as `Ưu tiên 1 (Critical)`, `Ưu tiên 2
  (High)` and lower levels only when useful; include rationale, action and
  expected outcome.

Every answer tag wins over action tags. A styled answer wins over plain
`[answer]`; do not combine both styled formats. No answer mode emits the six
structured `[report]` headings or a legacy delivery-summary block.

## Work report

- `[report-today]` — read-only report from local `00:00` today through the
  invocation time.
- `[report-yesterday]` — read-only report from local `00:00` yesterday up to,
  but not including, local `00:00` today.

These are calendar days in the machine timezone, not a rolling 24-hour window.
The report correlates verified Linear, GitHub and Git activity into deduplicated
`DONE`, `TEAM OVERLAP`, `REMAINING / GAPS`, `SUGGESTED FOLLOW-UPS` and
`SOURCE COVERAGE` sections. It checks exact same-file overlap separately from
nearby same-subsystem work, and suggests follow-up Linear tasks only when a
concrete gap is evidenced.

Both tags are report-only: no code, worktree, tests, browser, commit, comment,
issue/PR update or task creation, and no appended structured execution report.
Answer modes win over them; they suppress action tags and `[report]`. If both
calendar report tags appear, choose one before collecting the report.

## `[worktree]`

- `[worktree] [plan]` — create a worktree, then plan inside it.
- `[delivery-ete]`, `[delivery-linear-DOPAN-1645]` and
  `[delivery-verify-linear-DOPAN-1722]` already use a worktree.
- `[delivery-local]` uses one only when `[worktree]` is explicitly present.

Worktrees always live at:

```text
/Users/synasapmob/orca/workspaces/<project>/<task-slug>/
```

The agent fetches the remote first and starts from the latest `origin/dev`, or
the remote default branch when `dev` does not exist. Worktrees are never cleaned
up automatically.

## `[playwright]`

- `[delivery-local] [playwright]` — explicitly add browser verification to
  local delivery.
- `[delivery-ete]` — Playwright is already included when the work has a
  browser surface.
- `[delivery-linear-DOPAN-1645]` — Playwright is already included when
  applicable.
- `[delivery-verify-linear-DOPAN-1722]` — Playwright is already included when
  applicable, after the freshness gate permits delivery.

Screenshots and `manifest.md` always live outside the worktree at:

```text
/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/FE/screenshots/
```

For example: `.../dopamint-arena/DOPAN-1482/FE/screenshots/`. Use only the
uppercase Linear issue ID—no title, task slug or timestamp. Without a Linear
issue, use one short task slug. Repeat runs stay in the same task folder.

Use Playwright MCP only. Exercise the real flow—not just page rendering—and
report `Playwright: N/A` with a concrete reason when there is no browser surface.
After saving evidence, close only the page/context/browser created by this task,
including after failures. Never use `pkill`, `killall`, global quit or close-all;
leave uncertain shared sessions alone and report the cleanup limitation.

## Test evidence

Every backend/frontend test, check, verification build or benchmark keeps its
history outside the worktree at:

```text
/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/FE/evidence/
/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/BE/evidence/
```

Use only the folders actually tested; a full-stack run records both. Keep a
chronological `manifest.md`, numbered raw logs and native coverage/JUnit/
benchmark artifacts directly in `evidence/`; do not create another `runs/`
directory. Never replace a failure with the later pass. Preserve the full
fail → root cause/fix → pass chain. “Better than before” requires comparable
baseline and candidate runs under the same conditions. Playwright screenshots
remain in the sibling `FE/screenshots/` directory.

The final response stays short: link each applicable backend/frontend
`manifest.md`, show its latest `PASS`/`FAIL`/`BLOCKED`/`INCOMPLETE` status, then
give at most one summary sentence. Commands, full logs and detailed history stay
inside the evidence files.

## Approach history

Every task that implements or changes code keeps one shared file at:

```text
/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/approach.md
```

Do not split it into FE/BE files. Group by one `## YYYY-MM-DD` per local date,
then append meaningful entries such as `### 13:30 ICT — Wallet connection`.
Reuse the date heading, keep prior entries unchanged and add a timestamped
correction instead of rewriting history.

Usually write one entry for the completed implementation. Add another only
when architecture, API/data/user flow, evidence or a significant failure forces
a real approach change. Never add entries for individual commands, test reruns,
screenshots, formatting or small no-decision refactors. Each entry identifies
`Scope: FE | BE | Integration` and summarizes before, decision/reason, affected
flow, approach-changing failure/fix, after, evidence links and remaining gaps.

## `[dopa-tps]`

- `[dopa-tps]` — boot and health-check dopamint-arena's real local stack.
- `[dopa-tps] [playwright]` — run a browser flow against that stack.
- `[delivery-local] [dopa-tps]` — local code plus real-stack verification.
- `[delivery-ete] [dopa-tps]` — ETE delivery verified on the real stack.
- `[delivery-linear-DOPAN-1645] [dopa-tps]` — bound ETE delivery verified
  on the real stack.
- `[delivery-verify-linear-DOPAN-1722] [dopa-tps]` — freshness-gated bound
  ETE delivery verified on the real stack.

This tag works only in dopamint-arena. It runs `./scripts/init-worktree-dev.sh`,
then `./infra/local-llm/stack start` and `status`; that stack owns Docker infra,
local Sui, backend services and the worktree's frontends. Use its printed URLs,
not fixed ports. For a browser flow, `[dopa-tps]` implies `[playwright]`.

On failure: inspect status/logs → scoped `reclaim --dry-run`/`reclaim` →
`stop`/`start` for stale services → this-worktree `stack reset` only for contract
drift or proven corrupt state. After reset, rerun init and start.

Never automatically use `tps-fresh clear --all`: it can wipe every worktree
stack and every Docker image. Use it only after an explicit request and report
the exact impact first. The persistent local-llm stack may stay running for
review; report its status and URLs.

## `[rebase]`

- `[rebase]` — rebase the one unambiguous current PR from the conversation or
  checked-out branch, then squash its branch-only commits into one.
- `[delivery-ete] [rebase]` — ETE delivery ending with one rebased commit.
- `[delivery-linear-DOPAN-1645] [rebase]` — bound ETE delivery ending with one
  rebased commit.
- `[delivery-verify-linear-DOPAN-1722] [rebase]` — freshness-gated bound ETE
  delivery ending with one rebased commit.
- Add `[draft]` to keep the rewritten PR Draft, or `[merge]` to merge it after
  the rewritten SHA passes verification.

For an existing PR, always use its actual GitHub `baseRefName`—not an assumed
`dev` or default branch. Before the PR exists, use the delivery base: latest
`origin/dev`, falling back to the remote default branch when needed.

Fetch first, rebase, preserve the final diff, require exactly one commit above
the base, rerun verification and push rewritten history only with
`--force-with-lease`. `[rebase]` is never automatic; without this tag, delivery
may contain one or multiple commits.

`[rebase]` conflicts with `[delivery-local]` and `[plan]`. If the repository,
PR or branch is ambiguous, stop instead of guessing.

## `[draft]`

- `[delivery-ete] [draft]` — create or keep the PR as Draft.
- `[delivery-linear-DOPAN-1645] [draft]` — bound delivery with a Draft PR.
- `[delivery-verify-linear-DOPAN-1722] [draft]` — freshness-gated bound
  delivery with a Draft PR.

New PRs use `gh pr create --draft`; existing PRs use `gh pr ready --undo` when
needed. Verify `isDraft: true` before stopping. `[draft]` conflicts with
`[delivery-local]`, `[mergeable]` and `[merge]`.

## `[mergeable]`

- `[mergeable]` — diagnose and repair the one current PR from explicit/current
  conversation context until it is ready to merge.
- `[delivery-ete] [mergeable]` — ETE delivery with mandatory ready-to-merge
  completion.
- `[delivery-linear-DOPAN-1645] [mergeable]` — bound delivery with mandatory
  ready-to-merge completion.
- `[delivery-verify-linear-DOPAN-1722] [mergeable]` — freshness-gated bound
  delivery with mandatory ready-to-merge completion.
- Add `[rebase]` when the final branch must also contain exactly one commit.

Capture the initial blockers, inspect failed logs, classify whether each came
from the PR diff, shared/base code, base branch, infrastructure/flakiness or an
external policy, then fix every actionable root cause. Update a behind branch
and repeat verification for the final SHA. Never rerun blindly or bypass a
check just to get green.

As soon as a blocker is evidenced, add a `Mergeability blocker` PR comment with
the error/check, evidence, current cause classification and next repair step.
Never fail silently. When fixed, add `Mergeability resolution` with root cause,
fix, affected files/subsystems, collateral impact, before/after behavior and the
final verification.

Before stopping, require a non-Draft, current, conflict-free PR with no blocking
review and successful required/configured checks. Add a `Mergeability
resolution` PR comment explaining what blocked it before, evidence-backed
ownership, what changed and why it is ready now. `[mergeable]` does not merge;
`[merge]` does.

`[mergeable]` conflicts with `[delivery-local]`, `[plan]`, every answer mode and
`[draft]`. A
required human approval or missing external permission is reported as an exact
external blocker because the agent cannot fabricate it.

## `[merge]`

- `[delivery-ete] [merge]` — full delivery with a new Linear issue, then merge
  the PR.
- `[delivery-linear-DOPAN-1645] [merge]` — deliver the existing issue, then
  merge the PR.
- `[delivery-verify-linear-DOPAN-1722] [merge]` — freshness-gate and deliver
  the existing issue, then merge the PR.

The agent must update a behind branch, re-run verification for the final SHA,
wait for all required checks, merge through `gh` and verify GitHub reports
`MERGED`. `[merge]` includes the full `[mergeable]` diagnosis and before/after
PR comments. It keeps fixing every actionable error and cannot stop successfully
while the PR is still open, queued, pending or failing. Only an exact external
authority blocker may stop it, and that blocker must also be commented on the
PR with the required human action.

## `[ignore]`

- `[delivery-local] [ignore]` — fastest local experiment.
- `[delivery-ete] [ignore]` — ETE delivery without optional project workflow
  gates.
- `[delivery-linear-DOPAN-1645] [ignore]` — bound delivery without optional
  project workflow gates.
- `[delivery-verify-linear-DOPAN-1722] [ignore]` — skip optional project gates,
  but still run the mandatory freshness audit and conflict stop.

`[ignore]` skips optional repository setup/workflow rules and must report the
exact rules or review gates that were skipped. It never bypasses safety,
authorization, security, secrets, data integrity, explicitly requested
verification, required CI/CD or honest failure reporting.

## Important paths and tools

- Canonical harness: `~/.hub-william/contributors/default/libraries/harness/AGENTS.md`
- PR template: `~/.hub-william/contributors/synasapmob/contributors/default/libraries/templates/github-pull-request.md`
- Linear template: `~/.hub-william/contributors/synasapmob/contributors/default/libraries/templates/linear-issue.md`
- Test evidence template: `~/.hub-william/contributors/default/libraries/templates/test-evidence.md`
- Approach history template: `~/.hub-william/contributors/default/libraries/templates/approach-history.md`
- Requirements freshness template: `~/.hub-william/contributors/default/libraries/templates/requirements-freshness.md`
- Project registry: `~/.hub-william/contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml`
- GitHub PR operations: `gh` only.
- Linear operations: Linear MCP only.
- Browser verification: Playwright MCP only.
- Frontend work: always load `frontend-convention` before editing and audit
  named props interfaces, forms/validation, Tailwind/class composition,
  component reuse, and layout/semantics before handoff.

## Convention modules

Keep each convention in its own catalog skill. Frontend lives under
`contributors/default/libraries/skills/frontend-convention/`; future backend rules belong in
`contributors/default/libraries/skills/backend-convention/`, with the same separate-skill
pattern for other domains. The global harness only dispatches these skills; do
not combine their full rule bodies in `AGENTS.md` or mix domains together.

## Clickable references

- Linear task: `[DOPAN-1625 · REVIEW](verified Linear URL)`.
- GitHub pull request: `[PR #1336 · REVIEW](verified GitHub URL)`.
- Review commit: `[COMMIT-REVIEW-6aaab0e](verified full-SHA URL)`.
- Merged commit: `[COMMIT-MERGED-6aaab0e](verified full-SHA URL)`.
- Draft commit: `[COMMIT-DRAFT-6aaab0e](verified full-SHA URL)`.
- Local-only commit: `COMMIT-LOCAL-6aaab0e` (plain text, no URL).

Use a unique short SHA of at least seven characters. Determine local versus
pushed by checking whether the exact commit is reachable from a verified remote
ref, not from the branch name alone.

Use Linear MCP and `gh` to get exact URLs. Apply this to commentary, final
answers, PR comments and evidence summaries. Before sending, scan the complete
output for every explicit reference, bare number under an established
Linear/PR context, and SHA-shaped token under an established Git context.
Resolve and replace every occurrence; expand groups so every identifier gets
its own link. Scan once more and never knowingly send a bare task number, bare
PR number or raw commit SHA. This includes copied prose and earlier
conversation; literal logs/code keep their bytes but need a linked summary
immediately after them.

Never guess whether a truly context-free bare number is Linear or GitHub, and
never guess the repository: use the surrounding paragraph, active task/PR,
current repo and recent conversation, then ask when it remains ambiguous. A
failed lookup gets a normalized `UNVERIFIED` label, never the original bare
token. An unpushed commit stays plain text as `COMMIT-LOCAL-<short-sha>` because
it has no GitHub URL yet.
Choose `COMMIT-IN-PROGRESS-*`, `COMMIT-DRAFT-*`, `COMMIT-REVIEW-*` or
`COMMIT-MERGED-*` only after verifying the actual remote lifecycle.

After changing the canonical harness, regenerate Claude, Codex and Grok with:

```sh
~/.hub-william/apps/frontend/scripts/machine/install.sh update --yes
```

Never pass work by weakening tests or checks, hiding failures, fabricating
evidence or using bypass/admin tricks.
