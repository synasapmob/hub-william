# Contributing to Hub William

Thanks for helping make agent workflows easier to read, review, and reuse.
Contributions can add or improve catalogue documents, the web app, or the
machine installer.

## Add a catalogue document

Start with the [catalogue contribution guide](../README.md#how-to-contribute).
In short:

1. Fork the repository and create a branch from `main`.
2. Add the Markdown file under `contributors/<your-github-login>/` when it is
   specific to your own workspace, accounts, or infrastructure. Change a file
   under `contributors/default/` only when the rule should be shared by every
   user.
3. Keep the existing folder shape. The path determines where the document
   appears on the library or tools canvas.
4. Open a pull request into `main` and explain why the document belongs in its
   chosen shared or contributor-owned location.

Do not include credentials, tokens, private endpoints, customer data, or other
secrets in a catalogue document. Everything in `contributors/` is published.

## Change the app or installer

Install dependencies and start the app:

```sh
pnpm install
pnpm dev
```

Read [the frontend conventions](../frontend/docs/frontend-conventions.md) before a
user-visible change. The [architecture guide](../frontend/docs/architecture.md) explains
the static catalogue and the boundaries between the site and installer.

Before opening a pull request, run the same checks as CI:

```sh
pnpm format:check
pnpm lint
pnpm check:tailwind
pnpm typecheck
pnpm test
pnpm build
bash frontend/scripts/machine/tests/run.sh
```

Keep a pull request focused on one outcome, add regression coverage for changed
behavior, and call out verification gaps honestly. A maintainer may ask for a
change before merging even when CI is green.

## Report a security issue

Do not open a public issue for a suspected vulnerability. Follow the private
reporting instructions in the [security policy](SECURITY.md).
