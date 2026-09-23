# ADR-0024: Tools, Agents and demo Playground

- Status: Accepted; demo-only Playground scope superseded by ADR-0025
- Date: 2026-09-22
- Partially supersedes: ADR-0008's inclusion of the Documents machine installer

## Context

The operator removed Libraries and Activities from the app and requested removal
of unused Documents installer code. Home remains a white paper; Tools preserves
contribution through repository updates, including new tools. Playground remains
an accessible demo page without model integration.

## Decision

- The four app pages are Home (`/`), Tools, Agents and Playground. Home remains
  the white paper about tool sharing/contributions and agent pools for teammates;
  remove its "03. How to use" section. Home does not redirect to Tools.
- Tools retains shared Gateway, OpenCode and OMP instructions and downloads,
  automatic discovery of new contributed tools, the contributor selector and
  its existing `/tools/<contributor>` view. Contributions remain pull requests
  updating each contributor's own `contributors/<github-login>/tools/<tool-name>/`
  folder. `contributors/default/` is system-owned and read-only for contributors.
- Remove Libraries and its contributor routes, Activities fixtures,
  Documents/MCP installation UI and the legacy `install.py` / `install.sh`
  machine runtime.
- Preserve `gateway.py`, `opencode.py`, `omp.py` and their existing regression
  tests; relocate those tests with the gateway proxy test into
  `apps/frontend/scripts/installers/tests/` and keep them in CI.
- Preserve repository workflow source under `contributors/*/libraries/` as
  development infrastructure, outside the public frontend bundle and catalogue.
- Playground displays the specified demo copy and makes no model request.

## Consequences

Removing a retired surface also removes its dedicated runtime code, tests and
publication paths. Tests for supported tools continue to protect their behavior.
The backend, gateway, account data and provider credential lifecycle are
unchanged. Frontend and standalone installer source remain owned by
`apps/frontend/` as established in ADR-0008.
