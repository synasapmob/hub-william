# Project routing preflight

Before the first GitHub or Linear read or write, resolve the active project and
read the complete direct registry at:

`/Users/synasapmob/.hub-william/contributors/synasapmob/contributors/default/libraries/harness/projects/registry.yaml`

The registry is the only personal mapping from a Git repository to its GitHub
repository and Linear destination. Never route an external action solely from
the current directory name, parent folder, issue prefix, conversation context
or a similarly named repository.

## Resolve repository identity

1. Use Git to resolve the actual repository root and common Git directory.
   Worktrees under `/Users/synasapmob/orca/workspaces/` are normal and must map
   to the same project as their owning repository.
2. Read `remote.origin.url`. Normalize HTTPS and SSH forms to the canonical
   case-sensitive `owner/repository` identity and strip only a terminal `.git`.
   Never print credentials embedded in a malformed remote URL.
3. Require exactly one matching top-level key under `projects` in
   `registry.yaml`. A directory name is only diagnostic context, never a
   fallback identity.
4. If `origin` is absent, the remote cannot be normalized, no registry entry
   matches or more than one match is possible, stop before every GitHub/Linear
   write and report `BLOCKED` with the non-secret mismatch. Do not guess or add
   a registry entry during an unrelated delivery.

## GitHub routing

Read `github/gh-cli.md`, then use `gh repo view <owner/repository> --json
nameWithOwner,url,defaultBranchRef` to verify the registry's exact
`github_url`. `gh --help` describes commands; it does not resolve a repository
or its default branch. Do not let the CLI infer another repository from a
different checkout.

All PR reads, creates, edits, comments, checks, branch updates and merges must
target that verified repository explicitly or run inside its verified
worktree. Re-resolve the route before a write when the working directory or
worktree changes.

## Linear routing

Use only Linear MCP after the Git repository has resolved to one registry
entry:

- `status: enabled` permits the active tag's authorized Linear actions only in
  the exact `workspace_url` and `team_key` stored directly on that project.
- `status: disabled` means the project intentionally has no Linear destination;
  stop any requested Linear write.
- `status: unconfigured` means ownership is unknown; stop and request an
  explicit registry update rather than borrowing another project's team.

For `[delivery-ete]`, create the single authorized owning issue in the
configured team. For `[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]`, parse the complete issue identifier,
read that exact issue through Linear MCP, use the exact URL returned by MCP,
and verify its workspace and team match the active project's registry entry.
This supports another project in the same CommandOSS workspace using an issue
such as `TEAMNEW-1234`; the project must explicitly name `TEAMNEW` as its own
`team_key`. A workspace URL alone never authorizes a team.

An issue or workspace mismatch is `BLOCKED`: do not update it, create a
replacement, switch repositories or continue GitHub delivery. Re-read the
route and exact issue after a worktree switch and before the first Linear write.

## Delivery base resolution

Do not store an ordinary default branch in the registry. Resolve it from fresh
remote state:

- For new delivery work, fetch and prune `origin`. Use the freshly fetched
  `origin/dev` when it exists; otherwise query the verified GitHub repository's
  `defaultBranchRef` and use that freshly fetched remote-tracking ref.
- For an existing PR, its verified `baseRefName` is authoritative even when it
  differs from `dev` or the repository default.
- Immediately before final readiness or merge, fetch again and compare the
  selected base's full SHA. If it advanced, update the task branch through the
  repository-supported flow and invalidate/rerun verification for the new SHA.

Only an exceptional project that intentionally delivers to neither `dev` nor
the GitHub default may add `delivery_base_override` to its direct registry
entry. No configured project currently needs one. Never write a
`default_branch` field merely to cache information GitHub owns.

## Preflight record

Before an external write, retain a concise preflight in the task evidence or
handoff: canonical project key, resolved worktree/root, verified GitHub URL,
Linear status/workspace/team when applicable, exact issue when selected, and
delivery base ref plus full SHA. Do not include tokens or remote credentials.
