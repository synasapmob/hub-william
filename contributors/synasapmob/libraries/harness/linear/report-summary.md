# Linear report summary

When a structured `[report]` handoff is active, summarize material Linear reads
and changes under `## LINEAR`. Distinguish a read/verification from an actual
create or update. If Linear was untouched, write `N/A` with the reason.

List every issue created or updated. For updates, state only fields and
relationships that actually changed, including status, estimate, assignee,
labels, project/cycle and blocks, blocked-by, related, parent or child links.
For a created follow-up, state its purpose and whether it blocks or is blocked
by another issue. Mention a materially read source issue when it determined the
delivery scope, but do not repeat unchanged metadata as though it was updated.

Use one top-level Markdown list item per Linear issue. Keep related field
changes under that issue as short nested items such as `Status`, `Ownership`,
`Estimate` and `Relationships`. A separate issue always gets a new top-level
item; never join unrelated issues into one paragraph.

For existing-issue delivery, always include separate `Assignee` and `Estimate`
nested items and say whether each value was set during this turn or read and
preserved. Never describe a preserved value as an update.

Every issue must use the verified lifecycle-bearing clickable label required by
`github/clickable-references.md`. Include backed counts when useful. If any
Linear action ended `FAIL`, `BLOCKED` or `INCOMPLETE`, keep it visible with the
exact blocker; never omit a failed update to make the summary look complete.
When issues were created, state the verified count and explicit authorization
source. Keep suggested follow-ups separate and label them `not created`.
