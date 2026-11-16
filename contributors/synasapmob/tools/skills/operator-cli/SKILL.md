---
name: operator-cli
description: "CLI and tooling conventions — use git for local repository work and gh for GitHub operations such as pull requests, issues and CI runs; choose the right browser tool for verification (agent-browser by default, Playwright when a case requires it, Chrome DevTools for network debugging); use sui for Move packages and Sui networks, with testnet and devnet used freely and mainnet only when the user says so."
---

# Operator CLI conventions

CLI and tooling conventions shared by every agent. Add new tools here as they come up.

## Use Git and GitHub CLI

Use `git` for local repository operations and `gh` for GitHub operations such as
pull requests, issues and CI runs. Read `gh --help` to discover commands, and
use the relevant command's `--help` before using unfamiliar options.


## Choose the browser tool for verification

Use `agent-browser` by default for routine browser verification, including
navigation, interactions and smoke tests, to keep verification cost low.

Use Playwright when at least one of these applies:

- Debugging or fixing a complex UI issue requires it.
- Screenshots or other visual verification artifacts are needed.
- Verification must cover multiple browser engines, such as Chromium, Firefox
  and WebKit.
- Verification must cover multiple device profiles, such as iPad, iPhone and
  laptop.
- The user explicitly requests Playwright verification.

Use Chrome DevTools for network testing and debugging, including inspecting
requests, responses, timings and failed calls.

## Use the Sui CLI for Sui work

Use `sui` for Move packages and Sui networks. Use testnet and devnet freely, and
never touch mainnet, including switching to it, unless the user asks. Read
`sui --help` to discover commands, and use the relevant command's `--help`
before using unfamiliar options. Most jobs fit one of two commands:

- `sui move --help` for work on a package's source, such as creating, building
  and testing it.
- `sui client --help` for anything that talks to a network, such as
  environments, addresses, balances, the faucet, and publishing and calling
  packages.

For any other job, match its keywords against the command descriptions in
`sui --help`.

Keep the keystore, private keys and recovery phrases local. Never print, paste
or upload them.

