# Frontend

React Router frontend for the Hub William catalogue. It remains a prerendered
SPA and reads the repository-owned catalogue from `../../contributors/` at build
time.

From the repository root:

```bash
pnpm install
pnpm dev
```

The root scripts delegate frontend commands to this workspace so existing
developer and CI commands remain stable after the monorepo migration.
