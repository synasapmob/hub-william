# `[draft]`

Keep the request's GitHub PR in Draft state. This tag changes the PR publication
state only; it does not choose a delivery mode, weaken implementation or
verification, skip required CI/CD, or authorize a GitHub write by itself.

For a new PR, read `gh pr create --help` and create it with `--draft`. For an
existing PR, read `gh pr ready --help` and use `gh pr ready --undo` when it is
not already Draft. Re-read the PR through `gh` and require `isDraft: true`
before handoff. Do not mark it ready for review later in the same request.

With delivery, `[draft]` is valid only with `[delivery-ete]`,
`[delivery-linear-<ISSUE-ID>]` or
`[delivery-verify-linear-<ISSUE-ID>]`. Complete the normal implementation, tests,
browser verification, commit, push, PR content and CI/CD evidence, but report
the PR as intentionally Draft rather than ready to merge. It conflicts with
`[delivery-local]`, which forbids GitHub writes, and with `[mergeable]` and
`[merge]`, because a Draft PR cannot satisfy either ready-to-merge contract.
Ask which intent to keep before changing anything when conflicting tags appear.
