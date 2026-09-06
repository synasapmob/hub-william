# Approach history

For every execution turn that implements or changes code, create or reuse one
shared append-only file at:

`/Users/synasapmob/orca/histories/<project>/<ISSUE-ID>/approach.md`

Use the normalized uppercase Linear issue ID when one exists. Otherwise replace
`<ISSUE-ID>` with the same short task slug used by that task's FE/BE history.
The file is shared across frontend, backend and integration work; do not create
separate `FE/approach.md` or `BE/approach.md` files.

Before the first write, read and follow:

`/Users/synasapmob/.hub-william/contributors/default/libraries/templates/approach-history.md`

## Append-only date grouping

Use the operator machine's local timezone. Group entries by local calendar date
and keep them chronological:

```md
## 2026-09-04

### 13:30 ICT — Wallet connection

### 14:30 ICT — Wallet connection revised

## 2026-10-05
```

Create a `## YYYY-MM-DD` heading only when that date is not already present.
For another meaningful entry on the same day, append only a new
`### HH:MM TZ — <short title>` under the existing date heading. Include the
numeric UTC offset in the entry body so timezone abbreviations never make the
instant ambiguous. If an identical time heading already exists, include
seconds rather than overwriting or inventing a suffix.

Never edit, reorder or delete an earlier entry. When an earlier statement is
wrong, append a new `Correction — <short title>` entry at the current local
time, link the superseded heading and explain the correction. Do not rewrite
history to make the approach look cleaner than it was.

## What earns an entry

Append one compact entry when at least one of these occurs:

- a meaningful implementation phase is completed;
- the chosen architecture, data flow, API contract or user flow changes;
- evidence forces a materially different approach;
- a significant failure changes the implementation or risk assessment;
- work is handed off with a stable before/after result.

Do not append an entry for each command, test rerun, screenshot, formatting
change, small refactor with no decision change, status check or commentary
update. Consolidate closely related work into one entry. Test attempts and
screenshots already have their own manifests; link them instead of duplicating
their chronology. Ordinarily one completed task needs one entry, while a real
mid-task approach revision justifies another.

## Entry content

Record concise, reviewable engineering decisions rather than private chain of
thought. Each entry includes:

- exact local timestamp with numeric UTC offset and actor identity;
- `Scope: FE`, `Scope: BE` or `Scope: Integration`;
- goal and observable behavior before the change;
- chosen approach and the short evidence-backed reason;
- materially considered alternative and trade-off only when it affected the
  decision;
- affected files/subsystems and FE-to-BE flow when applicable;
- failures that changed the approach and the resulting fix;
- observable behavior after the change;
- clickable Linear/PR/commit references plus links to FE/BE evidence and
  screenshots;
- remaining gaps and suggested follow-ups.

Never dump raw hidden reasoning, secrets, full logs or repetitive execution
narration. Report uncertainty honestly. Use `N/A` for a genuinely inapplicable
field rather than inventing content.

## Handoff and concurrency

Verify the appended heading is unique and every linked artifact exists. In the
final `CODE:` subsection of `## Delivery summary`, link `approach.md` and name
the entry or entries appended in this turn as their own Markdown list item.
Report `Approach history: N/A` only when no code was implemented or changed.

Before writing, re-read the current file because another agent may have
appended to the same task. Preserve its bytes and append against the newest
content. If safe append cannot be guaranteed because of concurrent writes,
stop the history write and report the exact collision instead of overwriting
another agent's entry.
