# Linear issue creation policy

Focus on the one owning task. New Linear issue creation is default-deny: finding
a bug, gap, TODO, deferred acceptance criterion, dependency, failing test,
review comment or adjacent opportunity never authorizes another issue.

Read this contract before every Linear write, with or without a workflow tag.
Updating the explicitly selected owning issue does not grant permission to
create siblings, children, blockers or follow-ups.

## Creation authorization and budget

Resolve an exact issue-creation budget before the first write:

- `[delivery-ete]` authorizes at most one new owning issue for the requested
  delivery. It authorizes zero auxiliary issues.
- `[plan] [linear]` authorizes at most one new issue containing the agreed plan.
- A direct operator instruction to create issue(s) authorizes only the explicit
  count and scope stated in that instruction. Singular wording means one.
- `[delivery-linear-<ISSUE-ID>]`,
  `[delivery-verify-linear-<ISSUE-ID>]`, `[linear-<ISSUE-ID>]`, report modes,
  answer modes and `[delivery-local]` authorize zero new issues.
- Every other request has a creation budget of zero.

Before creating, state internally which explicit tag or operator sentence
provides authorization and the remaining count. Search/read enough through
Linear MCP to avoid an obvious duplicate. If an existing issue may already own
the same work, do not create a duplicate; use the explicit selector when one
was provided, otherwise stop and ask whether to bind the existing issue.

After each create call, re-read the returned issue and decrement the budget.
Never exceed it. If a create call returns an uncertain result, search for the
just-attempted issue before retrying so a timeout cannot create duplicates.

## No automatic decomposition

Do not split one task into child issues merely because it has several
acceptance criteria, files, services, bugs or implementation phases. Continue
inside the owning task when the work remains necessary for its stated outcome.
Do not pivot away from that task to implement an adjacent suggestion.

When discovered work is genuinely out of scope, record it as a remaining gap
and suggest a possible follow-up with proposed title, reason, minimal scope,
acceptance criteria and relationship. Suggestion is not authorization. Do not
create it until the operator explicitly asks in a later or current instruction.

## Relationships are not automatic

A new or suggested follow-up does not automatically block the current task.
Do not create or modify `blocks`, `blocked by`, parent/child or related links
merely to make a decomposition look organized. A blocking relationship is
valid only when verified external work makes an acceptance criterion of the
current task impossible to complete, and changing the relationship is within
the operator's explicit Linear-write request.

Optional hardening, cleanup, refactoring, observability, documentation and
future improvements normally do not block delivery. Keep the owning task
moving, report the gap honestly and let the operator decide whether it deserves
a separate issue or relationship.

## Handoff accountability

When a structured report is active, list every issue actually created or
updated under `## LINEAR`, including its action and verified result. When any
issue was created, include the number created and the authorization source. A
count above the resolved budget is a contract failure and must be reported,
never hidden. Suggested-but-uncreated follow-ups belong under `## Risky` and
must be clearly labeled `not created`.
