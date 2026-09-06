# Playwright report summary

When Playwright or another approved real-browser verifier was used, include a
`PLAYWRIGHT:` subsection in the final `## Delivery summary`. State the final
`PASS`, `FAIL`, `BLOCKED` or `INCOMPLETE` result and name the real user flow
that was exercised—not merely the page that rendered.

Report the screenshot count and link the absolute
`/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/FE/screenshots/` folder.
Summarize how many bugs were visibly observed, how many were fixed and
reverified, and how many remain, but use counts only when the browser run and
artifacts support them. Confirm that the task-owned browser page/context was
closed without implying that other agents' browser sessions were touched.

Render the subsection as Markdown list items with these independent fact
groups whenever applicable:

- `Result` — final status and what that status covers.
- `Flow` — the meaningful user actions and observed end state.
- `Screenshots` — verified count and clickable folder.
- `Defects` — observed, fixed/reverified and remaining counts plus tracked
  follow-ups; keep an explicit out-of-scope reason here when relevant.
- `Cleanup` — scoped page/context close result and whether any ownership
  limitation remained.

Use this compact shape:

```md
**PLAYWRIGHT:**
- **Result:** PASS/FAIL/BLOCKED/INCOMPLETE — verified scope.
- **Flow:** Actions exercised and observed outcome.
- **Screenshots:** Count and folder link.
- **Defects:** Observed; fixed/reverified; remaining/tracked.
- **Cleanup:** Scoped close result.
```

Use nested bullets only to split multiple directly related flows or defects.
Never combine result, flow, screenshots, defects and browser cleanup into one
paragraph. Never omit an unsuccessful step, missing screenshot or browser
blocker. Keep the detailed before/action/result trail in screenshot evidence
and make this subsection quick to scan.
