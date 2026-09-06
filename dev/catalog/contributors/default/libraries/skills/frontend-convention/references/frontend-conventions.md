# Frontend convention baseline

These five sections are the personal baseline. Repository-specific
frontend instructions may refine them for the active project.

## Declare props as a named interface

Always declare component props as a named interface, even when the component
takes one prop. Never put an inline object type in a parameter.

```tsx
interface SnippetProps {
  children: ReactNode;
  value: string;
}

function Snippet({ children, value }: SnippetProps) { … }
```

Do not write `function Snippet({ value }: { value: string })`.

The same rule applies to hooks, helpers, and callback types: an options bag is
an options bag whoever receives it. Name the interface after the function plus
what the parameter is called, so the two read together at the call site:

| Parameter          | Interface                       |
| ------------------ | ------------------------------- |
| component props    | `<ComponentName>Props`          |
| `opts` / `options` | `<FunctionName>Options`         |
| `args`             | `<FunctionName>Args`            |
| anything else      | `<FunctionName><ParameterName>` |

Export the interface only when something outside the file needs it. Use
interfaces for object-shaped domain models; reserve type aliases for unions,
literal unions, tuples, and utility compositions.

## Forms and validation

- Use one React Hook Form instance for one user workflow, including multi-step
  flows whose values must survive between steps. Keep field values, validation
  errors, root submission errors, and `isSubmitting` in that form instead of
  duplicating them in local React state.
- Define the Zod schema immediately before `useForm` so the resolver and form
  contract are easy to read together. A small schema may be recreated during
  render; do not wrap it in `useMemo` without a measured performance reason.
- When validation depends on the current mode or step, use one schema with
  `superRefine`. Resolve translated validation messages at schema creation
  time.
- Keep local state only for UI or independent asynchronous actions that React
  Hook Form does not own, such as password visibility, OAuth redirection, or a
  separate resend-code button.

## Tailwind and class composition

Treat `tailwindcss(suggestCanonicalClasses)` as required. Fix diagnostics
instead of suppressing them.

```sh
pnpm run check:tailwind
```

Prefer Tailwind v4 canonical forms:

```tsx
<Icon className="size-4" />
<div className="bg-linear-to-r from-indigo-600 to-indigo-400" />
<div className="bg-zinc-900/5" />
<div className="inset-x-5" />
```

`check:tailwind` rewrites **every quoted string in `app/` that has spaces in
it**, treating it as a list of utility classes and collapsing repeats. A CSS
string is not a class list, so it comes back broken and silently valid-looking:

```txt
drop-shadow(0 0 7px #34d399d9)   →  0 7px #34d399d9)
rgb(0 0 0 / 0.55)                →  rgb(0 0 / 0.55)
radial-gradient(ellipse 50% 50% at 50% 50%, …)  →  ellipse 50% at 50% 50%
```

It skips any string containing `${`, so CSS written in a component is built
from interpolated constants rather than inlined. This has cost three separate
bugs — a dropped shadow, a dropped ring, and a gradient the browser refused —
each of which looked like a styling mistake rather than a tooling one.

`tailwind-variants` is the only class composition API. Do not add `cn`,
`clsx`, or `tailwind-merge`. Define a module-level `tv()` contract when it is
reused; call `tv()` inline for one-off conditional classes.

A `tv()` contract shared by a component _and_ something that is not that
component lives in `app/utils/`, not in the component file — a component file
may only export components. `app/utils/utils.button.ts` is the example:
`ui/button.tsx` renders it, and link-shaped actions apply it directly.

When several elements of one component vary along the **same** axis, they are
`slots` of a single `tv()` contract, not separate contracts repeating the same
variant keys. Two contracts keyed on the same axis can drift apart, because
nothing makes a call site pass them the same value.

The test is the **value**, not the key name. Slots apply when one call site
feeds every slot from one value — a marker and a title both reading the same
`isCompleted`. They do not apply merely because two contracts happen to spell
their variant `active`: three independent pickers whose buttons each carry
their own `active` share a name and nothing else, and no call site could ever
consume both slots from one call. The reverse also holds — a line and the words
inside it are one row even when their variants are named differently, and the
tell is a contract reaching into a sibling's state to pick its own class.

```ts
const card = tv({
  slots: {
    container: "rounded-xl border-[1.5px] p-3",
    chip: "grid size-8 place-items-center rounded-lg",
  },
  variants: {
    tier: {
      beginner: { container: "border-blue-300/60", chip: "bg-blue-100" },
      advanced: { container: "border-orange-300/50", chip: "bg-orange-100" },
    },
  },
});

const { container, chip } = card({ tier });
```

Slots are for that case only. A contract that styles one element keeps `base`
and `variants`, and unrelated elements that happen to sit in the same file stay
separate contracts — folding them together buys indirection and nothing else.
`StudyZones.tsx` is the example: `card` and `progressStyle` are slot contracts
keyed on `tier`, while `board` stays a single-element contract keyed on
`divided`.

## Reuse inside a component

Never park JSX in a local `const` so two branches can share it:

```tsx
const face = <>…</>; // don't

return locked ? <div>{face}</div> : <Link to={to}>{face}</Link>;
```

It reads as reuse, but it is a branch wearing a disguise. The two parents are
different element types, so when the condition flips React unmounts the whole
subtree and mounts a fresh one — losing element state, focus, scroll position,
and any in-flight CSS transition. The `const` is the tell: markup only needs
lifting out when the tree around it forks.

The `const` is not the cause, which matters when fixing one. Inlining the same
JSX into both branches remounts identically, and so does moving it into a
module-level component — the parent's element type still changes. Only removing
the fork removes the remount.

Collapse the fork instead. One element whose attributes vary has nothing to
remount:

```tsx
return (
  <Link to={to ?? "#"} tabIndex={locked ? -1 : undefined}>
    …
    {locked && <Overlay />}
  </Link>
);
```

When markup is genuinely shared by two _callers_, extract a component at
**module level** and call it in each place. Never declare a component inside
another component's body — the inner function is a new identity on every
render, so React reads it as a new element type and remounts its subtree on
every parent render, not merely when a condition changes. That is the same
failure, fired far more often.

## Layout and semantics

- Use the shared `Flex` component for ordinary `div` flex containers. Semantic
  elements such as `nav`, `aside`, and links may carry flex utilities directly.
- Prefer parent `space-*` and `gap-*` utilities over manual margins on every
  child.
- Put one blank line between meaningful sibling JSX components or section
  blocks in every multi-line parent, at any nesting level. This includes route
  sections, composed panels, fragments, and distinct layout regions. Keep
  tightly coupled inline fragments such as an icon and its label together; do
  not add whitespace mechanically inside every compact control.
- Never use `<span>` as a standalone text block. Use a heading or `<p>` for
  block text, and reserve `<span>` only for inline styling inside that text:

  ```tsx
  <p>
    Hello <span className="text-red-500">world</span>
  </p>
  ```

- Use `Center` for both-axis flex centering and `ImageFallBack` instead of raw
  `<img>` elements outside that primitive.
- Preserve semantic `nav`, `header`, `main`, `article`, `aside`, and `button`
  elements. Use visible or `sr-only` text for icon-only controls.
- Do not add manual `aria-*` or `id` attributes during the current prototype
  stage. Prefer semantic elements and existing text content; add explicit
  accessibility metadata later when those interaction contracts are defined.
- Use named interfaces for component props and object-shaped domain models.
  Use type aliases for unions and utility compositions.
- Prefer a default export for a module's primary component or hook.
- Keep utility modules in `app/utils/` and name them with the
  `{Owner}.{Function}.ts` pattern, such as `utils.navigations.ts`,
  `utils.navigations.ts`, and `utils.home.ts`. Default-export the module's
  primary value or function; supporting helpers and types may use named
  exports.
- Prefer an installed focused utility such as date-fns over a one-function
  wrapper module when its behavior already matches the requirement.
- Prefix feature-owned components with their owner, such as
  `HomeDailyQuests`. Group related variants under one owner folder, such as
  `Nav/NavDesktop.tsx` and `Nav/NavMobile.tsx`. When ownership moves, the name
  and the folder move with it: the add-subject drawer became
  `Header/HeaderSubjectSwitcherDrawer.tsx` once the header took over switching.
- Preserve the complete ownership chain for nested feature components at every
  depth by concatenating `{Parent}{Child}`. Supporting props and state types use
  the same full prefix. For example, a panel owned by
  `HeaderSubjectSwitcher` is `HeaderSubjectSwitcherPanel`. Do not repeat a
  suffix already expressed by the parent name.
- Keep simple route-owned components flat beside their route. The Home command
  center remains `routes/_index/Home*.tsx`; do not create a folder and
  `index.tsx` for every small component.
- Introduce a named folder with `index.tsx` only when a feature section has
  enough state, child components, or ownership boundaries to benefit from a
  public entry point. The Profile header keeps its own folder, while its two
  standalone learning visualizations remain flat beside the route.
