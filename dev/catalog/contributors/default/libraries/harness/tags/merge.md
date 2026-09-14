# `[merge]`

Finish the PR-producing delivery and merge its PR before reporting successful
completion. Use `[merge]` only with `[delivery-ete]`,
`[delivery-linear-<ISSUE-ID>]` or
`[delivery-verify-linear-<ISSUE-ID>]`; it does not choose a delivery mode by itself.
If it is combined with `[delivery-local]` or `[draft]`, stop and ask which
conflicting intent to keep because local delivery forbids the GitHub writes
that merging requires and a Draft PR cannot be merged.

`[merge]` includes the full `[mergeable]` diagnosis, repair, final-SHA
verification and before/after reporting contract. Read `mergeable.md`
completely as well. Only after that contract is complete does it proceed to
merge. Every failure therefore receives the blocker and resolution PR comments
defined there; `[merge]` may not silently wait, rerun or hand off an error.

After implementation and verification, push the verified commit and inspect
the PR through `gh`. The PR must be ready for review, have no unresolved merge
conflict or blocking review state, and contain the required Linear, test,
browser and risk evidence. Fetch the remote base and confirm the PR branch is
current. When GitHub reports it behind, read `gh pr update-branch --help`, run
the `gh pr update-branch` equivalent of the PR's **Update branch** button, then
record the new head SHA and repeat verification/check monitoring for that SHA.

Wait until every required CI/CD check and every configured PR check for the
current head SHA has completed successfully. A new push or base update
invalidates older evidence. Fix failures at the root cause, push the fix and
restart the wait; never use admin merge, bypass flags, weakened checks, hidden
failures or a misleading skip. Do not merely enable auto-merge and hand off
while the PR is still open.

Continue through every actionable conflict, test failure, CI/CD failure and
behind-base update until the PR can actually merge. Before merging, require the
resolution comment to state why it failed, how it was fixed, which files or
subsystems were affected, whether adjacent behavior changed, and the verified
before/after difference.

Merge with `gh` using a merge method allowed by the repository, then re-read
the PR and require GitHub to report `MERGED`. Record the merge commit SHA and
URL. For Linear-backed delivery, update the bound or newly created issue with
the merged PR, verified head SHA, merge SHA and evidence, and move it only to a
state justified by its completed acceptance criteria. Re-read the issue after
the write.

Do not report success or stop normal execution while the PR is still open,
queued, pending or failing. If an external requirement cannot be satisfied with
the available authority, such as a required human approval or missing merge
permission, report the exact blocked state and required external action; never
claim the `[merge]` contract completed.
