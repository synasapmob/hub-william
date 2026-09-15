# `[rebase]`

Update exactly one current PR branch onto its latest real base and collapse all
commits belonging only to that branch into one commit. `[rebase]` is opt-in;
without it, delivery may legitimately produce one or multiple commits. It may
run as a standalone request or compose with `[delivery-ete]`,
`[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]`. It conflicts with `[delivery-local]` and
`[plan]`, and it may compose with `[draft]` or `[merge]`.

Resolve the target from an explicit PR reference first, otherwise from the PR
attached to the current branch, otherwise from one exact PR established by the
active conversation. Confirm the repository, PR number, head branch and base
branch through `gh` before rewriting anything. Never guess between multiple PRs
or mutate a similarly named branch. If the target is missing or ambiguous, ask.

For an existing PR, its actual `baseRefName` is authoritative; do not substitute
`dev` or the repository default branch. When `[rebase]` is part of delivery
before a PR exists, use that delivery worktree's recorded base: latest
`origin/dev`, falling back to the remote default branch only when `dev` does not
exist. Fetch and prune the remote, use the remote-tracking base directly, and do
not use a blind `git pull` to decide the base.

Require a clean worktree before standalone history rewriting. Record the old
head SHA, rebase the branch onto the fetched base, resolve conflicts without
discarding either side's required behavior, then squash the branch-only range
into one meaningful non-merge commit. Preserve the post-rebase tree exactly
during the squash. Verify all of the following before pushing:

- The fetched PR base is an ancestor of the rewritten head.
- `git rev-list --count <remote-base>..HEAD` is exactly `1`.
- The final diff still satisfies every requirement and contains no lost change.
- Required tests and browser verification pass again for the rewritten SHA.

When the remote head already exists, push only with `--force-with-lease`, never
plain `--force`, and fail safely if the lease changed or branch protection
rejects the rewrite. Re-read the PR through `gh`, verify its new head SHA, and
wait for required checks for that SHA. `[rebase]` alone does not create or merge
a PR; `[merge]` may continue only after this rewritten head is fully verified.
