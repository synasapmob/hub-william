# `[worktree]`

Create all worktrees under:

`/Users/synasapmob/orca/workspaces/<project>/<task-slug>/`

Before creating one, resolve the repository root and project name, fetch and
prune the remote, and base the new branch on the latest `origin/dev`. If that
repository has no `origin/dev`, use its remote default branch and state the
fallback. Record the base branch and SHA. A worktree does not fetch the latest
remote state by itself.

Use a unique task slug for the directory and check existing worktrees first.
The directory slug is not the Git branch name; Linear-tracked ETE work uses the
exact canonical `gitBranchName` contract in `delivery.md`. Never alter or clean
the operator's current tree. Do not auto-delete the worktree or branch; cleanup
requires an explicit request.
