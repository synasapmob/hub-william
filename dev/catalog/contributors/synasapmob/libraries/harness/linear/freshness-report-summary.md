# Requirements freshness report summary

For `[delivery-verify-linear-<ISSUE-ID>]`, include a compact `Freshness` item
under `## EVIDENCE`. Do not emit a standalone `FRESHNESS` heading. Use nested
Markdown list items for:

- `Verdict` — the final overall freshness verdict and whether delivery
  continued, required no implementation, or stopped before code.
- `Sources` — the authoritative ADR/PRD/docs/code/PR sources that determined
  the outcome; link or name exact sections without dumping the full matrix.
- `Reconciliation` — stale issue/docs/code corrected in this turn, or `None`.
- `Conflicts` — unresolved authority conflict and required owner decision, or
  `None`.
- `Artifact` — a clickable local link to the task's `freshness.md`.

Do not collapse these independent facts into one paragraph. Do not claim a
freshness pass when any acceptance criterion lacks a cited authority/current
state or when the final base/source set differs from the audited one.
