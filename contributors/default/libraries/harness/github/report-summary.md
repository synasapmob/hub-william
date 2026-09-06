# GitHub report summary

When Git or GitHub was materially read or changed during an execution turn,
include a compact `GITHUB:` subsection in the final `## Delivery summary`.
Distinguish read/verified actions from created, updated, commented, pushed,
rebased, merged or otherwise mutated actions.

Report every affected PR and commit, the PR's verified Draft/review/merged and
mergeability state, required-CI result, comments added and their purpose,
branch updates, rebases, and conflicts encountered and fixed. Include counts
only when tool output or preserved evidence supports them. State the material
before/after result of a fix without copying the chronological log.

Use one top-level Markdown list item per PR or independent Git action. When one
PR has several related facts, keep them readable as short nested items labeled
`State`, `CI`, `Comments`, `Branch/conflicts` and `Result` as applicable. Do not
compress all of those facts into one prose paragraph.

Every PR and commit must use its verified lifecycle-bearing clickable label
from `github/clickable-references.md`. If the action ended `FAIL`, `BLOCKED` or
`INCOMPLETE`, retain the subsection and state the exact blocker. Never claim a
PR is ready to merge merely because code was pushed or local tests passed.
