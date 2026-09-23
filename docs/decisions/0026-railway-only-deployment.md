# ADR-0026: Railway-only deployment

- Status: Accepted
- Date: 2026-09-23
- Partially supersedes: ADR-0008's GitHub Pages and Vercel publishing paths

## Context

The production frontend, private Rust API, Telegram adapter and PostgreSQL now
run in one Railway project. GitHub Pages and Vercel workflows still publish or
prepare alternative frontend builds even though they are no longer used.

## Decision

- Railway is the only application deployment target. Retire GitHub Pages and
  Vercel deployment workflows and configuration, and remove the `gh-pages`
  branch after the replacement reaches `main`.
- Pull requests into `dev` and `main` continue to run repository CI. A push to
  `main` deploys the existing Railway `production` services in order: API,
  Telegram adapter, then frontend. `dev` is an integration branch and does not
  deploy into production. A separate staging environment must be provisioned
  before enabling a `dev` deployment.
- The deployment workflow uses a Railway project token scoped to production,
  supplied as GitHub Actions secret `RAILWAY_TOKEN`. Until that secret is
  configured, the workflow reports that deployment was skipped. A maintainer
  can rerun it from `main` with `workflow_dispatch` after adding the secret.
  Provider credentials, database URLs and application secrets remain in
  Railway's runtime variables; the workflow never copies them into GitHub.
- Keep the frontend's generic base-path support for other hosts, but its
  prerendered production catalogue URLs use `https://hub-william.site`.

## Consequences

GitHub Pages no longer receives pushes, and deleting its branch cannot cause a
publish job to recreate it. The production deploy waits for each Railway
service to reach a terminal result and stops if a service fails. CI can pass
without deployment while `RAILWAY_TOKEN` is absent; that condition must not be
reported as a successful production deployment.
