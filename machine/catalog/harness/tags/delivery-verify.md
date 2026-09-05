# Verified existing-issue delivery tag

## `[delivery-verify-linear-<ISSUE-ID>]`

Deliver exactly one existing Linear issue end to end, but do not implement
until its requirements have passed the freshness gate in
`linear/requirements-freshness.md`. For example,
`[delivery-verify-linear-DOPAN-1722]` binds only DOPAN-1722.

This mode inherits the complete `[delivery-linear-<ISSUE-ID>]` contract:
Linear MCP and existing-issue metadata readiness, the issue's exact
`gitBranchName`, an isolated worktree from the latest delivery base,
implementation, applicable tests and Playwright verification, commit, push,
PR creation/update and final-SHA CI/CD readiness. It authorizes zero new Linear
issues and never turns a discovered gap into an auxiliary task.

Before editing code or delivery-owned documentation, freshly fetch the remote
and audit the latest fetched `origin/dev`, falling back to the actual remote
default branch only when `origin/dev` does not exist. Establish whether the
issue, ADRs, PRDs, repository docs, current implementation, tests and relevant
recent PR decisions still agree. Trace every requirement and acceptance
criterion to its current source and current implementation state. Do not use a
local/stale `dev`, an old issue description, behavior already present, or a
stale document as the delivery baseline.

Proceed only when the audit reaches one of these evidence-backed outcomes:

- `CURRENT` — the selected requirements remain authoritative and code is
  behind them; implement the missing behavior.
- `STALE-RECONCILED` — a stale issue or document can be reconciled against an
  unambiguous accepted source; record and make the necessary scoped update,
  then deliver the current requirement.
- `ALREADY-IMPLEMENTED` — current code already satisfies the requirement;
  verify it and update the bound issue with evidence, but do not create
  duplicate code or an empty PR.
- `PARTIAL` — identify the exact satisfied and missing criteria, then implement
  only the missing current behavior.
- `BLOCKED-CONFLICT` — authoritative sources materially disagree or ownership
  cannot be resolved; record the conflict on the bound issue and stop before
  code rather than choosing a product decision.

`[ignore]` may skip optional project workflow gates but never this freshness
gate, source traceability or conflict stop. Compatible PR modifiers are
`[draft]`, `[rebase]`, `[mergeable]` and `[merge]`; `[dopa-tps]` and an
explicit `[playwright]` also compose normally. This delivery mode conflicts
with `[delivery-local]`, `[delivery-ete]`, any other existing-issue delivery,
`[plan]`, every answer mode and every report-only mode.
