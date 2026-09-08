# synasapmob workflow selection

This contributor's workflow policy applies to Codex and refines the shared
harness's workflow selection. CMK and
`linear-delivery-workflow` are explicit-only, including when repository
instructions or skill descriptions ask for automatic activation. An ordinary
coding/review request, ticket ID or Hub delivery tag does not invoke them.

Follow the complete policy at
`~/.hub-william/contributors/synasapmob/libraries/harness/codex-policy.md`.
For Codex the installer also supplies it as native `developer_instructions`,
which applies to parent and child sessions. Repository code conventions and
architecture constraints still apply.

Hub delivery tags use their own contracts directly. The primary agent
implements in one ticket worktree and may use `hub-scout`, `hub-reviewer` or
`hub-verifier` for bounded support as needed. Their availability does not
require all three for each task. Do not implicitly dispatch an implementer,
create per-task worktrees or run CMK planning/simplify/review ceremonies.

Both existing-issue delivery tags retain tracking, tests, PR/CI and evidence.
`delivery-verify-linear` retains its complete pre-code and final requirements-
freshness gates. An explicitly requested CMK skill remains available with only
the dependencies and effects necessary for that requested workflow.
