# GitHub operations

Use `git` for local Git operations. For creating, viewing, editing, commenting
on or checking a GitHub PR, use `gh` only. Before the first GitHub operation in
a session, read `gh --help`; before using each verb for the first time, read
`gh <verb> --help`. Never curl `api.github.com`; `gh api` is allowed only when
no porcelain command fits. Authentication is out of band—do not run
`gh auth login`.

Every `[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]` or
`[delivery-verify-linear-<ISSUE-ID>]` PR must read and follow this local
template at runtime:

`/Users/synasapmob/.hub-william/contributors/synasapmob/contributors/default/libraries/templates/github-pull-request.md`

Preserve and accurately fill its sections: Context, What's included, Design
and implementation, Risks, concerns, and gaps, and Testing. Remove placeholder
comments, use repo-relative paths, link the Linear issue and include concrete
test/browser/CI evidence. If the template cannot be read, stop before creating
the PR. Do not fall back to a project-external absolute path or network copy.
