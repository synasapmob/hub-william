# Evidence report summary

When backend or frontend evidence was created or updated, include an
`EVIDENCE:` subsection in the final `## Delivery summary`. Separate `Backend`
and `Frontend`; for each applicable entry, link the absolute `manifest.md`,
state its latest honest `PASS`, `FAIL`, `BLOCKED` or `INCOMPLETE` status, the
verified test/check count when known, and the scope covered.

Frontend manifests live under
`/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/FE/evidence/`; backend
manifests live under the sibling `BE/evidence/` directory.

Summarize preserved fail-to-fix-to-pass history with the prior failure count,
short root-cause/fix outcome and final passing result. Do not copy commands,
long logs, stack traces or run-by-run chronology into the response. A missing
required run or unresolved failure stays visible; never convert partial green
checks into an overall `PASS`.

Use separate top-level Markdown list items for `Backend` and `Frontend`. Within
one surface, keep directly related status, test count, failure/fix history,
scope and manifest link together as short nested items when necessary. Never
combine both surfaces or an unrelated benchmark into one prose paragraph.

If no backend/frontend evidence was produced, omit `EVIDENCE:` rather than
inventing it, and state any required-but-unrun verification gap elsewhere in
the handoff.
