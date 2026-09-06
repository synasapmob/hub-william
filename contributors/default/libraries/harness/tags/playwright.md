# `[playwright]`

Use the configured Playwright MCP server only. Do not substitute a Playwright
shell script, Chrome DevTools, a generic browser tool or manual screenshots. If
the MCP server is unavailable, report the block instead of claiming browser
verification.

Persist screenshots outside every repository and worktree at:

`/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/FE/screenshots/`

For Linear-backed work, use the normalized uppercase issue ID alone, such as
`DOPAN-1482`. Never append the issue title, task slug or timestamp to the
directory name. For work with no Linear issue, use one short task slug instead.

Create or reuse that task screenshot directory. Exercise the real flow: navigate,
capture the important initial state, perform meaningful actions such as
type/submit, read the result back, and capture each state that matters. Cover
desktop/mobile when responsive behavior is relevant and inspect console/network
failures when they matter. Store a `manifest.md` in the same directory mapping
each screenshot to the step, URL and observed result; store a trace there on
failure when the MCP supports it. On a repeat run, keep the same directory and
use short run/file sequence names only when needed to preserve earlier evidence.
Verify every evidence file exists and is non-empty. Never keep the only copy
inside a worktree and never auto-delete this screenshot directory. Frontend
non-browser test evidence for the same task belongs beside it under
`../evidence/`; never mix screenshots into that evidence directory.

After saving all evidence, always close the Playwright page, browser context or
browser session created by this task. Do the same cleanup after a failed or
interrupted verification before handing off. Track the task-owned page/context
or session identity when the MCP exposes it, and use Playwright MCP's scoped
close operation for that resource only.

Never use `pkill`, `killall`, a global browser quit, process-name matching or a
"close all" operation: other agents and the operator may have independent
Chrome sessions open. Never close a page, context or browser that existed before
this task or whose ownership is uncertain. If the available MCP exposes only a
browser-wide close and the agent cannot prove that browser belongs exclusively
to this task, leave it running and report the cleanup limitation instead of
risking another session. Browser cleanup never deletes screenshot evidence.
