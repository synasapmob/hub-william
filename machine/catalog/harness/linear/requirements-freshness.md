# Existing Linear requirements freshness gate

Apply this contract before implementation for
`[delivery-verify-linear-<ISSUE-ID>]`. The gate is read/audit first; it permits
updates only to the exact bound issue and delivery-owned files after authority
is resolved. It never authorizes another Linear issue.

## Establish the current sources

Read the exact issue through Linear MCP, including its description, acceptance
criteria, comments, attachments, linked documents and relationships. Immediately
before auditing code, run a fresh remote fetch with pruning. Resolve
`origin/dev` after that fetch; only when the repository has no `origin/dev`,
resolve its actual remote default branch. Record the chosen remote ref and full
SHA. Never audit a local `dev`, the current checkout, a stale remote-tracking
ref or a SHA remembered from an earlier fetch as though it were latest.

Inspect the code and tests at that freshly fetched base, plus any existing
task-branch diff that would affect the verdict. Also inspect:

- ADRs, PRDs, specifications, plans and repository docs relevant to the scope;
- explicit document status, approval, supersession and deprecation markers;
- current implementation, tests, feature flags and generated/runtime contracts;
- relevant open and merged PRs and commits through `gh` and Git; and
- repository instructions that define which source wins for this domain.

Treat titles, timestamps, issue numbers and document locations as discovery
signals, not automatic authority. Prefer explicit accepted/superseding
decisions, merged behavior and repository-defined ownership. A newer timestamp
alone does not prove that a source is authoritative. Never infer a product
decision from incomplete or contradictory evidence.

## Trace requirements before code

Trace every issue requirement and acceptance criterion in a table with these
fields:

| Requirement / AC | Authoritative source | Current code/doc state | Verdict | Action |
|---|---|---|---|---|

Use only `CURRENT`, `STALE-RECONCILED`, `ALREADY-IMPLEMENTED`, `PARTIAL` or
`BLOCKED-CONFLICT` as row verdicts. Cite an exact file/section, Linear URL,
PR, commit or observed test for each authority and current-state claim. An
uncited assumption is not a passed freshness gate.

Then record one overall verdict:

- Continue with implementation for `CURRENT`, `STALE-RECONCILED` or `PARTIAL`.
- For `ALREADY-IMPLEMENTED`, run the verification needed to prove every
  criterion, update the bound issue with the result when allowed, and do not
  manufacture a diff, commit or empty PR.
- For `BLOCKED-CONFLICT`, comment on the bound issue with the conflicting
  sources, concrete decision required and affected criteria, then stop before
  implementation. Do not resolve the conflict by guessing, quietly following
  the oldest/newest text or creating a follow-up issue.

When accepted current behavior clearly supersedes stale issue/docs, reconcile
the stale material in the same delivery when it is owned by the task. Preserve
meaningful historical decisions: mark supersession or update current-facing
guidance instead of rewriting history deceptively. If the stale artifact is
external or outside authorized scope, report the exact required owner action.

## Durable audit

Create or reuse this append-only task file:

`/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/freshness.md`

Read and follow
`/Users/synasapmob/.hub-william/machine/catalog/templates/requirements-freshness.md`
before writing. Use the normalized uppercase issue ID and the operator's local
timezone. Record the audit before code, then append a new timestamped entry if
later evidence changes the verdict; never overwrite the earlier conclusion.

Every entry includes the exact issue, audit timestamp, base branch and SHA,
source inventory with status, authority rationale, the full traceability table,
overall verdict, reconciliation performed or required, and evidence links.
Do not store secrets, raw hidden reasoning or unsupported conclusions.

Immediately before the final matrix recheck, fetch and prune again and resolve
the same delivery-base rule again. If its SHA advanced, update the task branch
through the repository-supported delivery flow (or the explicit `[rebase]`
contract when present), then rerun applicable verification and the complete
freshness audit against the new base. A changed base, new accepted decision,
updated task or relevant merged PR invalidates the old freshness conclusion;
append a new audit and reconcile again before claiming the PR is ready.
