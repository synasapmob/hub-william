# `[guess]`

Opt this turn into decision latitude after the agent has inspected the latest
applicable ADRs, decision records, requirements, documentation, code, tests and
relevant merged PR decisions available within the authorized scope. Existing,
non-superseded authority still wins; `[guess]` is for genuine gaps, not a reason
to ignore a decision that already exists.

When authority leaves a substantive choice unresolved, make and act on the
best-supported hypothesis without pausing for operator confirmation. The agent
may explore beyond the narrow implementation detail, reason through downstream
effects and choose adjacent next product, architecture or workflow decisions
needed for one coherent result. Prefer reversible choices and verify their
observable consequences.

Keep conjecture honest. In the handoff, name material assumptions, the evidence
that supports them, confidence, meaningful alternatives and anything that
would reverse the choice. Never fabricate an observed fact, source, quote,
requirement or verification result, and never silently describe a guess as an
existing decision.

`[guess]` changes decision latitude only. It does not override an explicit
operator instruction, system/developer policy, safety, authorization, secrets,
data integrity, destructive-action safeguards, test honesty or another tag's
side-effect boundary. With an answer-only or report-only mode it still performs
no actions; with `[plan]` it may speculate in the plan but still cannot
implement; with delivery it may act on unresolved decisions only inside that
delivery's authorized writes.
