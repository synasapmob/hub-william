# Linear tags

## `[linear]`

Permit the Linear write for this turn. Use the configured Linear MCP server
only and discover its current tools and schemas at runtime. Never call Linear's
REST/GraphQL API with curl or another fallback. Re-read the issue after every
write and report its identifier and URL. Before writing, load and obey
`../../../contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md`; `[linear]` is not unlimited permission to create
follow-ups or decompose the owning task.

`[plan] [linear]` means: turn the agreed plan into a Linear issue, attach the
plan artifact when supplied, verify the result, then stop without implementing.
`[delivery-local]` cannot combine with `[linear]`, because local delivery permits
no Linear or GitHub updates. Answer-only modes still suppress all writes.

When the request includes `Path://some/file.md`, resolve it relative to the
repository root. Treat that file as the source of truth, do not edit it, and
attach the actual file through Linear MCP. Put the actionable requirements in
the issue description too, so the attachment is not the only source. Add the
repo-relative path and SHA-256 under References. Do not recursively upload a
directory or attach secrets.

Before creating or updating a delivery issue, read and follow this local
template at runtime:

`/Users/synasapmob/.hub-william/contributors/synasapmob/contributors/default/libraries/templates/linear-issue.md`

The local template is authoritative and contains the required headings. Its
DOPAN-175 link records structural provenance only; never fetch that issue to
copy unrelated metadata. If the local template cannot be read, stop before the
Linear write instead of falling back to the external issue.

At creation, leave acceptance criteria unchecked and distinguish planned
verification from completed verification. During delivery, check only criteria
backed by evidence, cross-link the PR and issue, record the verified SHA and
entry points, and move to the appropriate review state. Opening a PR alone does
not make an issue Done.

## `[linear-<ISSUE-ID>]`

An issue-selector tag such as `[linear-DOPAN-1645]` selects exactly that
existing Linear issue. Match the tag case-insensitively, normalize the issue
identifier to uppercase, and accept only one selector per request. Never guess,
search for a similar identifier or create a replacement when the exact issue is
missing or inaccessible.

The delivery selectors `[delivery-linear-DOPAN-1645]` and
`[delivery-verify-linear-DOPAN-1722]` use the same exact-ID validation but also
select an ETE delivery mode. Accept only one issue ID across standalone and
delivery selector forms. Both load `../../../contributors/synasapmob/contributors/default/libraries/harness/linear/delivery-readiness.md` to fill only
missing assignee/estimate metadata on the selected issue before implementation.
Verified delivery additionally loads `../../../contributors/synasapmob/contributors/default/libraries/harness/linear/requirements-freshness.md` and
may not code until its audit resolves the current authority.

Use the configured Linear MCP server only. Read the exact issue before doing
work, including its description, acceptance criteria, relationships, linked
documents/attachments and relevant comments when available. Reconcile it with
the current repository; if the issue belongs to another repository or the
delivery target is ambiguous, stop and ask rather than editing the wrong code.

`[delivery-linear-DOPAN-1645]` is end-to-end delivery bound to DOPAN-1645. It
must update that issue instead of creating a new one. Use the issue's
requirements as the delivery baseline, then create the worktree, implement,
verify, commit, push, open/update the PR, wait for required CI/CD, cross-link the
PR and issue, and update only the acceptance criteria and delivery state
supported by evidence. Re-read the issue after every write.

`[delivery-verify-linear-DOPAN-1722]` follows the same bound delivery for
DOPAN-1722, with its mandatory issue/ADR/PRD/docs/code/PR freshness audit
before implementation and recheck before handoff.

The selector alone does not authorize a Linear write or imply delivery.
`[plan] [linear-DOPAN-1645]` reads that issue and discusses it without coding or
writes; add the separate `[linear]` tag only when the operator explicitly wants
the plan to update the existing issue. Answer-only modes still suppress every
write.
