# Delivery tags

## `[delivery-local]`

Deliver the requested code locally for review. By default work in the current
checkout; do not create a worktree. Inspect its status first, preserve unrelated
operator changes and stop if overlapping changes make the edit unsafe. Code,
tests and local verification are allowed. Do not create/update Linear, commit,
push, create/comment on a PR, deploy or merge. Leave the changes uncommitted for
the operator to inspect. Do not use Playwright unless `[playwright]` is present.

When `[worktree]` is also present in either order, load `worktree.md` and use
its isolated-worktree contract while keeping every other local-only restriction
unchanged.

For a user-visible frontend change, load and follow the `frontend-convention`
skill before editing. If it is unavailable, say so and stop rather than
pretending to have applied it.

## `[delivery-ete]` and `[delivery-linear-<ISSUE-ID>]`

`[delivery-ete]` delivers end to end in a worktree and creates a new Linear
issue. `[delivery-linear-DOPAN-1645]` performs the same delivery from exactly
that existing issue instead of creating one. Implement, test, verify, commit,
push and open/update the GitHub PR. Wait for every required CI/CD check to finish
and be green. Address failures at the root cause and leave the PR ready to
merge, but do not merge unless the operator explicitly asks.

`[delivery-ete]` authorizes exactly one owning Linear issue and no auxiliary
issues. `[delivery-linear-<ISSUE-ID>]` authorizes zero new issues and stays
focused on the selected issue. Bugs, gaps or future work discovered during
either mode are reported as uncreated suggestions unless the operator
explicitly authorizes another issue.

For `[delivery-linear-<ISSUE-ID>]`, load `../../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md`
immediately after validating the selected issue. Before implementation, assign
an unassigned issue to the verified operator and set an unset estimate using the
verified team scale. Preserve either field when already populated; both final
values must be re-read and verified.

Once the owning Linear issue exists, read it back through Linear MCP and treat
its `gitBranchName` as the canonical Git branch name. This applies both after
creating a new issue for `[delivery-ete]` and when binding an existing issue
through `[delivery-linear-<ISSUE-ID>]`. Use that value exactly, including its
case, separators and slug, for the local branch, pushed branch and PR head.

Do not prepend the Git username, abbreviate the slug, append blocker/dependency
IDs or numeric suffixes, or derive the branch from the worktree directory name.
`git user.name` identifies commit authors; it is not a branch namespace.

The worktree directory slug is only a filesystem label and may be shorter than
the branch. If the canonical branch already exists for the same issue, reuse
that branch safely. If `gitBranchName` is missing or the name collides with
unrelated work, stop and report the conflict instead of inventing another name.

For a user-visible frontend change, load and follow the `frontend-convention`
skill before editing and run the Playwright flow in `playwright.md`. For work
with no browser surface, record `Playwright: N/A` with the concrete reason;
never invent a meaningless browser check just to claim the tag ran.

Before handoff, compare the final diff and behavior against every requirement,
acceptance criterion and affected boundary. Report the exact commands, results,
browser evidence, required checks and remaining risks. "Ready to merge" means
the remote PR head SHA is the verified SHA and all required checks are green.

`[delivery-verify-linear-<ISSUE-ID>]` loads this complete existing-issue
delivery contract, then adds the mandatory pre-code and final freshness checks
from `delivery-verify.md` and `../../../contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md`.
