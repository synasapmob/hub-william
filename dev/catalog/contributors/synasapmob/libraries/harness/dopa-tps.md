# `[dopa-tps]`

Boot and verify dopamint-arena's production-shaped, worktree-scoped local stack
so backend services, Docker infrastructure, local Sui and the real frontends
are available for end-to-end verification. `[dopa-tps]` is a tag, not a shell
command. Use only the current dopamint-arena worktree's repository-owned
scripts. If the repository root is not dopamint-arena or the required scripts
are absent, stop without starting or cleaning anything.

At runtime, read the current worktree's `docs/rules/common/local-dev.md`,
`docs/guide/local-dopa-llm-topology.md`,
`docs/guide/local-chain-harnesses.md`, and `./infra/local-llm/stack --help`.
Those project docs and scripts are authoritative when their commands evolve.
Never copy environment files or stack state from another worktree.

Use this normal startup sequence from the target worktree:

1. Confirm Docker is reachable with `docker info`; report a block rather than
   installing, reconfiguring or restarting Docker without authorization.
2. Run `./scripts/init-worktree-dev.sh` first. It owns worktree identity,
   dependencies, environment files, port offsets and service configuration.
3. Run `./infra/local-llm/stack start`. This starts the worktree's Docker
   infrastructure, selected local Sui stack, backend services and frontends.
4. Run `./infra/local-llm/stack status` and require the stack's own health
   gates to pass. Use the URLs printed by the stack or its worktree environment;
   never assume a fixed port.
5. For millionTPS localnet flows, run
   `./scripts/dev/milliontps-network.sh --network localnet --check` before the
   browser proof. Verify the requested backend/API health and then exercise the
   real UI flow through Playwright MCP, saving screenshots under the normal
   `[playwright]` evidence root.

For a user-visible flow, `[dopa-tps]` implies `[playwright]`. It may run alone
to prepare/verify the stack or compose with `[delivery-local]`,
`[delivery-ete]`, `[delivery-linear-<ISSUE-ID>]`,
`[delivery-verify-linear-<ISSUE-ID>]`, `[ignore]`, `[draft]`, `[rebase]` or
`[merge]` when those tags are otherwise compatible.
It conflicts with `[plan]` because starting a stack mutates local state.

Diagnose before cleaning. Inspect `stack status` and scoped `stack logs
[service]`, and preserve the failure evidence. Use this recovery order:

1. For attributable leftovers, run `./infra/local-llm/stack reclaim --dry-run`,
   review its exact scope, then `./infra/local-llm/stack reclaim` if warranted.
2. When a running service is stale after a Rust or service change, use
   `./infra/local-llm/stack stop` followed by `start`; `start` intentionally
   reuses an already-live runtime and does not restart a stale relay.
3. Use `./infra/local-llm/stack reset` only for this worktree when contract
   source drift requires republishing or scoped stack state is proven corrupt.
   State that it discards this worktree's chain and local volumes, then rerun
   `./scripts/init-worktree-dev.sh` and `stack start`.

Never automatically run `tps-fresh clear`, `tps-fresh clear --all`, a global
Docker prune, blanket process kill, or delete `.local/devstack`. In particular,
`clear --all` can wipe every dopamint-arena worktree stack and every Docker
image on the machine. It requires an explicit operator request after reporting
the resolved targets and impact; it is not ordinary bug recovery.

The `infra/local-llm` stack is deliberately persistent and may remain running
for review; report its status and URLs at handoff. Stop every ad-hoc service the
task started outside that persistent stack. If the real flow cannot complete,
report the observed status/log/browser failure rather than claiming that a
rendered page proves the services work.
