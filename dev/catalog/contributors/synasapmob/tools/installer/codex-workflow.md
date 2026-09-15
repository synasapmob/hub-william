# Codex workflow on synasapmob's devices

This is a personal contribution. The shared `default` catalog neither selects
CMK policy nor installs these three roles.

Select this contribution with the installed machine command:

```sh
~/.hub-william/scripts/machine/install.sh sync --agent codex --contributor synasapmob --no-shared --no-plugins
```

The profile remembers the contributor for later syncs. Preview with `--dry-run`;
open a new Codex session after applying it. Turning the Codex harness off or
selecting `--contributor default` removes its managed native policy and owned
roles while preserving unrelated user config and foreign agents.

The installer appends the contributor's `AGENTS.md` to the shared harness,
composes `codex-policy.md` into native `developer_instructions`, and installs
`hub-scout`, `hub-reviewer` and `hub-verifier`. It backs up changed config and
preserves existing developer instructions. The names avoid colliding with
repository-owned `cmk-delivery-*` roles. No implementer is installed.

CMK skills remain in their owning repositories and remain callable explicitly.
The policy controls invocation without editing or duplicating those repositories.
Per-skill `allow_implicit_invocation: false` only affects the copy containing that
metadata; changing a Hub copy would not affect another repository's copy. The
native developer policy applies to repository-triggered workflow requests too.
This is an instruction boundary, not a filesystem sandbox or a claim that an
LLM can never err. Check observable behavior after installing it.

Hub delivery remains responsible for tracking, current ADR/requirement
traceability, tests, acceptance, browser evidence and CI. The primary agent
implements in one ticket worktree; supporting agents answer scoped questions.
Explicit CMK invocation selects that skill and its necessary dependencies.

The opt-in live verifier uses real Codex model calls and a local fixture that
deliberately requests automatic CMK. It checks ordinary implementation,
explicit invocation, actual supporting-agent tool calls and a freshness gate
that must stay blocked without authoritative issue data:

```sh
python3 scripts/machine/verify-codex-workflow.py --candidate --output-dir /absolute/evidence/candidate
python3 scripts/machine/verify-codex-workflow.py --output-dir /absolute/evidence/installed
```

Candidate mode supplies catalog policy/role overrides. Installed mode supplies
none, exercising the device's actual Codex configuration. Both preserve event
logs, independent test output, timings and per-case results. They authorize no
external writes and do not prove that real Linear/GitHub/browser delivery has
run. The supporting-role probe keeps a normal local Codex session so it can
retain actual parent/child tool calls when the CLI's JSON stream omits spawn
events; reasoning is excluded from the exported evidence. Live probes use the account's configured model and therefore consume its
normal usage allowance.
