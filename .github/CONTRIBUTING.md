# Contributing to Hub William

Hub William accepts community pull requests for **tool documentation only**.
The Tools catalogue groups documentation by contributor and tool. It does not
have a separate category taxonomy.

## Community pull requests

1. Fork the repository and branch from `dev`.
2. Add or update Markdown files only in
   `contributors/<your-github-login>/tools/<tool-name>/`. Use your GitHub login
   in lowercase, a lowercase hyphenated tool name, and a clear entry document
   such as `README.md` or `<tool-name>.md`.
3. Open a pull request into `dev` using the pull request template. Explain what
   the tool does, how to use it, and how you verified the instructions.

You may include nested Markdown documents in your tool folder. Use ordinary
files, not symbolic links or executable files. Keep instructions specific and
readable; cite official documentation for claims that can change. Do not add
credentials, tokens, private endpoints, customer data, copied material without
permission, promotional links, or unrelated changes. The source documents and
per-tool ZIP are published as part of the Tools catalogue, so review the exact
files you submit.

The automated community policy checks the pull request's author, target branch,
changed paths, file types, and file modes. A community pull request that changes
`contributors/default/`, another contributor's folder, code, tests, APIs,
frontend files, workflows, infrastructure, conventions, or any other path will
fail and may be closed. Splitting an out-of-scope code change across tool docs
does not make it in scope. Maintainers review content and links before merging;
passing automation is not acceptance.

`contributors/*/libraries/` contains internal repository workflow sources, not
public tool contributions. New tools appear automatically in the Tools
contributor selector and at `/tools/<github-login>` after an accepted change is
deployed. There is no category field to set.

## Propose a change outside tool documentation

Open a [change proposal](https://github.com/synasapmob/hub-william/issues/new/choose)
for API, frontend, installer, model, deployment, workflow, convention, or
repository structure changes. Include the problem, expected behavior, and
relevant context. A maintainer will decide whether and how to implement it.
Use the bug report form for reproducible defects. Do not open a public issue
for a suspected vulnerability; follow [SECURITY.md](SECURITY.md) instead.

## Repository owner changes

The repository owner branches from `dev` and opens pull requests into `dev`.
The owner promotes a verified `dev` into `main`; feature pull requests do not
target `main`. The `main` branch is the Railway production source. Owner changes
to the application, installers, tests, or workflow sources follow the
[architecture](../apps/frontend/docs/architecture.md), accepted
[decisions](../docs/decisions/README.md), and, for user-visible frontend work,
[frontend conventions](../apps/frontend/docs/frontend-conventions.md).

Run the checks relevant to the change before opening a pull request. Full CI
runs for repository-owner pull requests; community PRs run the trusted scope
check without executing their changed files. Full CI runs:

```sh
pnpm format:check
pnpm lint
pnpm check:tailwind
pnpm typecheck
pnpm test
pnpm build
node --test .github/scripts/contribution-policy.test.mjs
python3 -m unittest discover -s tests -p 'test_*.py' # in apps/frontend/scripts/installers
```

Preserve regression coverage for supported behavior and state any verification
gaps. The installer suite uses temporary directories rather than real agent
configuration.
