# `[mergeable]`

Keep working until exactly one GitHub PR is genuinely ready for the operator to
review and merge, but do not merge it. `[mergeable]` may run as a standalone
repair request against an existing PR or compose with `[delivery-ete]`,
`[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]`. It is opt-in, conflicts with
`[delivery-local]`, `[plan]` and `[draft]`, and may compose with `[dopa-tps]`,
`[playwright]`, `[ignore]` or `[rebase]` when otherwise compatible. `[merge]`
includes this readiness contract and then performs the merge.

Resolve the target from an explicit PR reference first, otherwise from the PR
attached to the current branch, otherwise from one exact PR established by the
active conversation. Confirm the repository, PR number, URL, head branch and
base branch through `gh`. Never guess between multiple PRs. Reuse the worktree
that already owns the head branch; if none exists, create an isolated worktree
under the standard worktree root without altering the operator's unrelated
current tree.

Before changing anything, capture a mergeability baseline through `gh`:

- `state`, `isDraft`, `mergeable`, `mergeStateStatus` and `reviewDecision`.
- `baseRefName`, `baseRefOid`, `headRefName` and `headRefOid`.
- Every required and configured PR check, including its status and URL.
- Merge conflicts, behind-base state, requested changes and required approvals.

If the PR is Draft, read `gh pr ready --help` and mark it ready; an explicitly
requested `[draft]` is a conflict instead. Fetch the actual PR base. If the head
is behind, update it through the repository-supported equivalent of GitHub's
**Update branch** button; when `[rebase]` is present, follow the one-commit
rebase contract instead. Any base update or push invalidates evidence from the
old head SHA, so repeat verification for the new SHA.

For a failed check, inspect the failed job and logs through `gh`, identify the
exact repository command behind it, reproduce it locally when possible, and fix
the root cause. Classify each original blocker using evidence, not intuition:

- introduced by the PR's diff;
- exposed by a base update or shared code;
- already failing on the base branch;
- flaky runner, infrastructure or third-party dependency; or
- external policy such as a required human approval or unavailable permission.

Do not leave a discovered blocker silent. Once the observed failure is backed
by logs or GitHub state, add a PR comment titled `Mergeability blocker` with the
failed check or condition, evidence URL or artifact, observed error, current
ownership classification and next repair step. If root cause is not known yet,
say that investigation is in progress rather than guessing. Update the PR again
when materially new evidence changes the diagnosis.

Attribute a failure to a person only when a specific commit/change and the
check evidence establish that fact; otherwise report the responsible code path
or system, not a guess about a teammate. A contained in-repository fix necessary
for mergeability is in scope, but do not smuggle an unrelated product change
into the PR. Rerun a job only after evidence supports a transient failure or a
root-cause fix; never rerun repeatedly to fish for green.

Continue through every actionable blocker: conflicts, stale base, incomplete PR
content, changes requested, test/lint/type/build failures and CI/CD failures.
Never bypass branch protection, dismiss valid reviews, weaken checks, alter
expected behavior merely to pass, use admin merge or hide a failure. Required
human approval and missing external authority cannot be fabricated; after all
other work is exhausted, report that exact external blocker and required action
instead of claiming success or waiting forever without progress.

The contract is complete only for the final remote head SHA when:

- the PR is open, non-Draft, conflict-free and based on the required current
  base;
- GitHub reports it mergeable with no blocking merge state or review decision;
- every required check passes, every configured check has completed without an
  unexplained failure/cancellation, and legitimate skips are documented;
- the final diff, PR body and verification evidence match the requirements; and
- `gh` re-read proves the head SHA and all readiness fields above.

Add a final PR comment through `gh` titled `Mergeability resolution` containing
the original blockers, evidence-backed ownership classification, root cause,
changes made, every affected file or subsystem, collateral-impact assessment,
before-versus-after behavior, commands/checks rerun, old and final head SHAs,
and why the PR is now ready. Link the earlier blocker comment when present.
Repeat that concise before/after account in the handoff. Do not stop successfully
while an actionable failure remains or the PR is Draft, dirty, behind,
conflicted, blocked, pending or failing.
