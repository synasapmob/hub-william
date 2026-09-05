# Tracked projects: confirm stop collecting, and filter cards

Two client-side changes on the Agents page **Tracked projects** list. Collection,
telemetry, and the `tracked_projects` table stay as they are.

## Current behavior

`TrackedFoldersCard` (`src/routes/_app.agents/tracked-folders-card.tsx`) lists
opted-in folder names as outline badges. Each badge has an X whose
`aria-label` is `Stop collecting {folder}`. Clicking X calls `untrackFolder`
immediately — no confirm.

Clicking the folder name does nothing.

Project usage cards live as siblings in `AgentsRoute`
(`src/routes/_app.agents/route.tsx`). They always render the full `projects`
array from `workspaceUsageQueryOptions`. Matching is implicit today: a project's
`name` is the folder's last path segment, the same string stored as
`folderName`.

A confirm dialog already exists for a different action: **Stop tracking** on a
project card (`project-actions.tsx`) deletes recorded history for that project.
Stop collecting is not that — it only removes the folder from the collection
list so new telemetry for it is discarded.

## Goals

1. X must not untrack until the user confirms in a dialog.
2. Clicking a tracked folder item toggles it as a filter. Several folders can
   be on at once. Clicking an active item again turns that filter off. The
   project card grid shows only cards that match the active set.

## Non-goals

- No API, RPC, or `tracked_projects` change.
- No URL or query-param persistence of the filter.
- No exclusive (single-select) filter.
- Do not reuse the Stop tracking copy or mutation. Stop collecting still calls
  `untrackFolder`. Stop tracking still calls `untrackProject`.

## 1. Confirm before Stop collecting

Mirror the dialog pattern in `project-actions.tsx`: one `Dialog`, local state
for which folder is pending, mutation only on confirm.

- X opens the dialog. It does not call `untrackFolder`.
- X click does not toggle the filter (`stopPropagation` on the X button).
- Title: `Stop collecting {folder}?`
- Description stays about collection, not history: new telemetry for that
  folder will be discarded on arrival. Local files are unaffected. Existing
  project cards are not deleted by this action.
- Confirm runs the existing `removeMutation` and success toast
  (`{folder} is no longer collected.`). Cancel, overlay click, and Esc close
  with no request.
- While the mutation is pending, disable the confirm button and show
  `Removing…`, same as Stop tracking.
- One shared dialog, keyed by the pending folder name. Do not mount a dialog
  per badge.

If the pending folder is also in the active filter set, drop it from the set
on successful untrack so the filter cannot point at a folder that is gone.

## 2. Badge click = multi-toggle filter

The filter is the set of selected folder names. Empty set means no filter.

| Interaction                     | Result                                           |
| ------------------------------- | ------------------------------------------------ |
| Nothing selected                | All project cards, same as today                 |
| Click a badge name              | That folder is added; only matching cards render |
| Click another badge             | Both stay selected (union, not replace)          |
| Click an already-selected badge | That folder is removed from the set              |
| Last selected badge clicked off | Back to all cards                                |

### Match

A card matches when `project.name === folderName` for any selected folder.

The same folder can produce more than one card (Codex and Claude Code / Grok
Build). All of them show.

### Active look

Selected badges must read as on. Switch the selected badge from `outline` to
the filled/default variant, and set `aria-pressed="true"` on the toggle
control. Unselected badges stay outline with `aria-pressed="false"`.

The name is the toggle. The X stays a separate control.

### Empty states

Keep the existing dashed empty state for `projects.length === 0` (nothing has
ever been recorded).

When a filter is active and no remaining card matches, do not reuse that copy.
Show a filter-empty message: no usage for the selected folders. The tracked
list and add-folder form stay visible.

### Click target

The badge is currently a `span` wrapping text plus the X. Make the folder name
a `button` (or `Badge asChild` onto a button) so it is a real toggle. Do not
make the whole badge including X a single button — that would mix confirm and
filter on one control.

## State ownership

Lift the selected folder names into `AgentsRoute` (or a thin wrapper around
Tracked folders + the card grid). `TrackedFoldersCard` does not own the filter.

```
AgentsRoute
  selectedFolderNames: string[]
  → TrackedFoldersCard (selected, onToggle, existing add/remove)
  → filtered projects → ProjectUsageCard[]
```

Declare props as a named interface (`TrackedFoldersCardProps`). Keep the
selected names in one `string[]` (or `Set` converted at the boundary) — it is
one piece of state that changes together.

Local React state is enough. Do not put it on the URL and do not put it in
React Query.

When rendering, if `selectedFolderNames.length === 0`, pass `projects`
through unchanged. Otherwise filter with
`selectedFolderNames.includes(project.name)`.

## Files

| File                                                   | Change                                                                                             |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/routes/_app.agents/route.tsx`                     | Own selected folder names; pass them into the card; filter `projects` before the grid              |
| `src/routes/_app.agents/tracked-folders-card.tsx`      | Confirm dialog on X; badge name is a pressed toggle; accept selected + onToggle                    |
| `src/routes/_app.agents/tracked-folders-card.test.tsx` | Confirm + filter cases below                                                                       |
| `src/routes/_app.agents/route` tests, if none exist    | Cover filter → cards at the route, or keep that coverage on the card plus a small extracted helper |

Do not change `project-actions.tsx`, `project-usage-card.tsx`, or
`usageService.untrackFolder`.

Extract a tiny `projectMatchesFolders(project, selected)` helper only if the
route test would otherwise re-implement the predicate. Do not invent a filter
module for one `includes` check.

## Tests

Existing `TrackedFoldersCard` tests stay: empty copy, collected copy, add
folder, refuse empty submit.

Add:

- X opens `Stop collecting {folder}?` and does **not** call `untrackFolder`
  until the confirm button is pressed.
- Cancel / dismiss leaves the folder in the list and does not call the
  service.
- Confirm calls `untrackFolder` with that folder name.
- Clicking a folder name does not call `untrackFolder`.
- Toggle: first click reports the folder as selected (`aria-pressed="true"`);
  second click reports it unselected.
- Multi: two names can be selected at once.
- X click does not change the selected set.

Filter → cards is owned by the route. Cover it where the filter is applied:

- No selection → every project card.
- One folder → only cards whose `name` matches, including multiple products
  for that name.
- Two folders → union of both.
- Selection with no matching cards → filter-empty copy, not
  `No project usage yet`.

## Accessibility and conventions

Follow [frontend-conventions.md](./frontend-conventions.md):

- The toggle owns `aria-pressed`. The X keeps `aria-label="Stop collecting {folder}"`.
- Visible focus and a practical touch target on both controls, including at
  320px.
- Named interface for the card's new props. No inline object type.
- Badge selected/unselected classes go through `tv` or the existing `variant`
  prop — no template-literal class strings, no bare ternary className.
- The confirm dialog uses the shared `Dialog` primitives already used by
  Stop tracking.

## Out of scope follow-ups

These are easy to want and not part of this change:

- Persist the filter in the URL so a refresh keeps it.
- Clear-all control when several folders are selected.
- Selecting a folder that has never produced a card still filters to empty;
  do not auto-skip empty folders.
