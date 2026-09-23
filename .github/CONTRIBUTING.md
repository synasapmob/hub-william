# Contributing to Hub William

Contributions can improve Home, Tools, Agents, the model Playground, the Rust API,
standalone tool installers or repository development workflows.

## Branching

Branch from `dev` and open pull requests into `dev`. A maintainer promotes a
verified `dev` to `main`; do not open feature pull requests against `main`.
`main` deploys to Railway production once the deployment token is configured.

## Tool documentation and workflow sources

Create your own `contributors/<github-login>/tools/<tool-name>/` folder and add
Markdown documentation, or update tools inside your own contributor folder.
`contributors/default/` belongs to the system and is read-only for contributors:
do not edit, rename or delete its files. System updates are maintained separately.
A new Markdown tool is discovered automatically
in the Tools contributor selector and at `/tools/<github-login>`; its original
files and a per-tool ZIP are published at build time. Keep documentation in sync
with any installer behavior change. Gateway, OpenCode and OMP retain their
existing setup UI; other tools use their contributed documentation.

`contributors/*/libraries/` holds repository development harnesses, skills,
hooks and templates. These remain available to the development workflow, but
are not published as app pages or bundled into tool downloads.

Do not commit credentials, tokens, private endpoints or customer data. Source
files in this repository remain visible to anyone with repository access.

## Change the app or installer

```sh
pnpm install
pnpm dev
```

Read [frontend conventions](../apps/frontend/docs/frontend-conventions.md)
before a user-visible change and [architecture](../apps/frontend/docs/architecture.md)
for application and deployment boundaries.

Run the checks relevant to the change before opening a pull request. CI runs:

```sh
pnpm format:check
pnpm lint
pnpm check:tailwind
pnpm typecheck
pnpm test
pnpm build
bash apps/frontend/scripts/installers/tests/run.sh
```

Preserve regression coverage for supported behavior and state verification gaps.
The standalone installer tests use temporary directories and do not change real
agent configuration.

## Report a security issue

Follow the private reporting instructions in [SECURITY.md](SECURITY.md).
