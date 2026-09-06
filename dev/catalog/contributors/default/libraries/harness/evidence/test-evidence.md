# Backend and frontend test evidence

Whenever an execution mode that permits writes adds or changes backend or
frontend tests, or runs tests, checks, lint, type checking, verification builds
or benchmarks, preserve the resulting evidence outside every repository and
worktree under one per-project, per-task history root:

```text
/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/
├── FE/
│   ├── screenshots/
│   └── evidence/
└── BE/
    └── evidence/
```

For Linear-backed work, use the normalized uppercase issue ID alone. For work
without a Linear issue, replace `<ISSUE-ID>` with one short task slug. Store
frontend test evidence in `FE/evidence/` and backend test evidence in
`BE/evidence/`; when a full-stack command verifies both, record evidence under
both. Store Playwright screenshots only in `FE/screenshots/`.

Before the first evidence write, read and follow:

`/Users/synasapmob/.hub-william/contributors/default/libraries/templates/test-evidence.md`

Keep a chronological `manifest.md` and numbered artifacts such as
`001-fail.log` and `002-pass.log` directly inside the applicable `evidence/`
directory. Do not create an extra `runs/` directory. For every command record
its exact command and working directory, start/finish time and duration, exit
status, tested Git SHA and base SHA, relevant tool/runtime versions, verified
scope and artifact paths. Capture complete stdout/stderr without changing the
command's real exit status. Mark canceled or incomplete commands honestly.

Never erase or overwrite a failed run after fixing it. Append the later passing
run and connect failure, root cause, change and final result in the manifest, so
the fail-to-fix-to-pass history remains reviewable. Preserve native JUnit,
coverage, profiling and benchmark outputs when the tool produces them. Redact
secrets, tokens, credentials and sensitive environment values before they reach
an evidence file; never dump the whole environment.

A comparison or “better than before” claim requires a recorded baseline and
candidate run under the same command, machine/runtime, configuration, data,
warm-up and sample-count conditions. Keep the raw results, summarize absolute
and percentage deltas, and distinguish signal from expected variance. Never
claim an improvement from one run, incomparable conditions or a fabricated
baseline. A green test proves only the behavior it exercised; state remaining
coverage gaps instead of treating logs as proof of everything.

## Compact handoff

When evidence was created or updated, include a compact `EVIDENCE:` subsection
inside the final `## Delivery summary` and follow
`evidence/report-summary.md`. Include only the applicable backend/frontend
entries. Each entry links the absolute `manifest.md` path and states the latest
honest status (`PASS`, `FAIL`, `BLOCKED` or `INCOMPLETE`) plus a short
description of what was verified. Add at most one brief overall summary
sentence describing what changed and what the evidence proves.

Do not repeat commands, long logs, stack traces, run-by-run history or detailed
diagnosis in the final response; those belong in the linked manifest and run
artifacts. Do not claim `PASS` when any required applicable run is still failing
or incomplete. If no backend/frontend evidence was produced, do not invent an
`EVIDENCE:` subsection; state any required-but-unrun verification gap normally.
