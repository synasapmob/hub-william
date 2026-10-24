# ADR-0052: Deploy each branch to its own Railway environment

- Status: Accepted
- Date: 2026-10-24
- Authority: operator asked that a merge deploys to the environment of the branch it lands on, and updated the Railway token of both environments.
- Partially supersedes: [ADR-0026](0026-railway-only-deployment.md), which kept `dev` from deploying until a staging environment existed.

## Context

ADR-0026 deployed only `main`, to production, and said a separate staging
environment must exist before `dev` could deploy. The Railway project now has a
`staging` environment, and the GitHub repository has a `staging` environment
beside `production`, each with its own `RAILWAY_TOKEN`. A merge into `dev`
deployed nothing, so staging only changed when someone deployed it by hand.

## Decision

One workflow, `railway-deploy.yml`, deploys the branch that was pushed:

- A push to `main` deploys `production`: API, Telegram adapter, then frontend.
- A push to `dev` deploys `staging`: API, then frontend. Staging has no Telegram
  adapter deployment, so the workflow does not create one.
- The branch picks the Railway environment, the GitHub environment, and so the
  `RAILWAY_TOKEN` secret that the job reads, and the list of services.
- Each environment has its own concurrency group. Runs for one environment queue
  behind each other; a staging deploy never waits for production.
- A manual run from `dev` or `main` deploys that branch's environment. A run from
  any other branch is skipped.
- A missing token fails the run and names the environment that was not deployed.

## Consequences

- Staging receives every merge into `dev`, including tool documentation that
  community pull requests add after a maintainer reviews it. Production still
  receives only an owner promotion from `dev` to `main`.
- A failed staging deploy shows as a failed run on `dev`. It does not block a
  merge, because the workflow runs after the push.
- A token that is empty or missing in one GitHub environment fails only that
  environment's runs.
- Adding the Telegram adapter to staging means adding it to `DEPLOY_SERVICES` in
  the workflow, after the service exists in Railway's `staging` environment.
