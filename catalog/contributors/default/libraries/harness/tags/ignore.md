# `[ignore]`

Ignore optional repository workflow gates for this turn, including mandatory
planning, ticket creation, PR creation and optional review passes, so the
operator can experiment quickly. Continue to use relevant project build/run
commands and technical conventions unless they conflict with the request.
Before handoff, explicitly list every project-level rule or review gate that
was skipped and the consequence of skipping it; say `none` when none was
actually skipped.

`[ignore]` never permits bypassing system/developer policy, access controls,
security boundaries, secret handling, data integrity, destructive-action
safeguards, or verification explicitly requested by another active tag. It
does not permit lying about a test, check or result. Requirements of the other
active personal tags remain in force: for example, `[delivery-ete] [ignore]`
still creates its Linear issue and PR, runs applicable Playwright verification,
and waits for required CI/CD.
