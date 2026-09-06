# Existing Linear delivery readiness

Apply this contract to `[delivery-linear-<ISSUE-ID>]` and
`[delivery-verify-linear-<ISSUE-ID>]`. It applies only to the exact selected
existing issue and never authorizes creation of another issue.

Immediately after reading and validating the issue, inspect its assignee and
estimate before implementation. Missing means the Linear MCP response reports
the field as unset/null; do not treat a legitimate configured value as missing.

## Assignee

When the issue is unassigned, resolve the operator's own Linear member identity
from the authenticated MCP account/viewer. If that field is unavailable, match
against another verified operator identity such as an authenticated email; a
similar display name alone is not sufficient. Assign the issue to that exact
member and re-read it to verify the member ID.

When an assignee already exists, preserve it even when it is another person.
Do not silently steal ownership. Report the existing owner in the final Linear
summary; the operator may explicitly request reassignment separately.

## Estimate

When the estimate is unset, read the issue's full scope and the team's current
estimation configuration through Linear MCP. Use only a value allowed by that
team's configured scale. Follow documented team semantics when available;
otherwise calibrate against a small set of comparable current team issues and
estimate the selected issue's remaining delivery scope, complexity, integration
risk and verification burden. Do not inflate points because the work was hard
to diagnose, and do not minimize them to make throughput look better.

Set one estimate on the owning issue and re-read it to verify the stored value.
Do not create separate issues or estimates for individual acceptance criteria.
When an estimate already exists, preserve it; never overwrite it merely because
the agent would have chosen a different number.

## Completion and reporting

Assignee and estimate readiness are required metadata gates for an existing-
issue delivery. If either missing field cannot be resolved or updated because
the MCP lacks identity/settings data, the value is invalid, or permission is
denied, report the exact external blocker and do not claim the delivery
contract complete. Never guess a member, invent a point scale or create a
replacement issue as a workaround.

In the final `LINEAR:` summary, use separate nested list items:

- `Assignee` — `assigned to operator` or `preserved existing <name>`.
- `Estimate` — `set to <points>` with the scale/basis, or
  `preserved existing <points>`.

Distinguish a field that was changed from one that was only read and preserved.
Re-read after every write and report only the verified final values.
