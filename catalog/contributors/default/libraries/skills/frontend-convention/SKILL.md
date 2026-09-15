---
name: frontend-convention
description: Discover and apply the active repository's frontend conventions before implementing or reviewing a user-visible frontend change. Use for UI components, routes, styling, interaction, responsive behavior, and frontend accessibility; not for server-only or non-UI work.
---

# Apply the project's frontend conventions

Load this skill before editing a user-visible frontend surface.

Read [references/frontend-conventions.md](references/frontend-conventions.md)
completely before editing. It is the personal baseline for named props
interfaces, forms and validation, Tailwind/class composition, reuse inside a
component, layout, and semantics.

## Find the authoritative rules

1. Resolve the repository root and read its active agent instructions.
2. Search for the project's own frontend convention source, especially files
   named `frontend-convention*`, `frontend-guideline*`, UI architecture docs,
   design-system docs, and contributor guidance linked from the README.
3. Read the relevant source completely before editing. Do not assume rules from
   one repository apply to another.
4. Apply the personal baseline plus the repository's rules. If they conflict,
   follow the most project-specific active instruction and call out the
   conflict. If the project has no frontend convention source, say that
   explicitly and use the personal baseline below.

## Baseline when the project is silent

- Preserve the existing design language and reuse established components,
  tokens, utilities and folder ownership before adding a new pattern.
- Keep behavior responsive at the repository's supported widths and preserve
  keyboard access, accessible names, visible focus and semantic HTML.
- Keep state and remote schemas typed; do not invent fallback fields when a
  contract is unclear.
- Keep route-only code with its route and shared UI in the project's shared
  component location. Match existing naming and import conventions.
- Add focused tests for meaningful behavior. Do not replace interaction tests
  with snapshots that cannot prove the flow.

Before handoff, review every changed frontend file against the rules actually
found. Explicitly check all five personal-baseline headings and mark a heading
not applicable only when the changed surface genuinely does not use that
concern. List the convention sources used. Browser verification is governed by
the active delivery/Playwright tags in the personal harness.
