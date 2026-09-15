# `[plan]`

Discuss, investigate read-only, offer options and build a reviewable plan with
the operator. Do not edit code or configuration, run mutating commands, commit,
push, create a PR or deploy.

If the operator is blocked or the requirements admit materially different
solutions, explain the trade-offs and offer concrete options rather than
silently choosing. `[worktree] [plan]` may create the worktree first, then all
work inside it remains planning/read-only. `[plan] [linear]` may also create or
update the Linear issue described in `linear.md`, then stops without coding.
