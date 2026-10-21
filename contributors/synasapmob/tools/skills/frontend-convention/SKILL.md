---
name: frontend-convention
description: "Frontend conventions for React, TypeScript and Tailwind — blank-line blocking in TS and JSX, merging adjacent conditionals on the same value, carrying list indexes instead of searching for them, passing cohesive state objects instead of flat prop lists, adding DOM attributes only when a consumer uses them, composing classes with tailwind-variants, and choosing between space-y, Flex and Center layout primitives."
---

# Frontend conventions

Treat these rules as review criteria. Use the active project's existing
components, domain types and design tokens when applying the examples.

Keep this document standalone. Present its conventions directly, without source
attribution.

## Separate blocks with one blank line

Put one blank line between meaningful responsibilities in TypeScript and
between meaningful sibling regions in multi-line JSX.

- Separate state, derived values, effects, handlers and returned JSX when they
  represent distinct responsibilities.
- Keep a comment directly above the block it explains.
- Separate sibling components and conditional blocks at every nesting level,
  including a title and its optional description or a children slot between
  sections.
- Keep tightly coupled lines together: a derived value and its effect, an icon
  and its label, or the statements of one calculation.
- Never stack two blank lines or space every statement mechanically.

```tsx
const [confirmOpen, setConfirmOpen] = useState(false);

// Close the confirmation when this match stops playing.
const canSettleLeave = session.phase === "playing";
useEffect(() => {
  if (!canSettleLeave) setConfirmOpen(false);
}, [canSettleLeave]);
```

```tsx
<DialogContent>
  <div className="space-y-2">
    <DialogTitle>{title}</DialogTitle>

    {description && <DialogDescription>{description}</DialogDescription>}
  </div>

  {children}

  <Flex className="justify-end gap-2">
    <Button onClick={onConfirm}>Confirm</Button>
  </Flex>
</DialogContent>
```


## Check each condition once

When adjacent sibling blocks branch on the same value, merge them into one
condition. Check the value a second time only when another element sits
between the blocks.

- Complementary checks become one ternary with both branches. Separate blocks
  testing `items.length === 0` and `items.length > 0` are one decision written
  twice.
- The same check with the same outcome becomes one condition around the blocks.
  Add a fragment only when no wrapper element already holds them.
- Different conditions are not duplicates: `a && <A />` and `b && <B />` stay
  separate.
- An element between the blocks justifies a second check, because merging would
  reorder the output. If the layout allows moving that element, move it and
  merge.

```tsx
{items.length > 0 ? <List items={items} /> : <EmptyState />}
```

```tsx
{items.length > 0 && (
  <>
    <ListHeader count={items.length} />

    <List items={items} />
  </>
)}
```

Write a numeric check as a boolean (`items.length > 0`) or a ternary. In
`items.length && <List />` an empty array renders `0`, which crashes in React
Native when it lands outside a text component.

Keep the blank line between siblings inside a merged block.


## Carry the index, do not search for it

Take an item's position from the iteration that produces it. Do not call
`indexOf` or `findIndex` inside a render loop to recover a position that the
loop already had.

- Use the second argument of `map` when rendering the list directly.
- When the list is split, filtered or grouped first, attach the index in the
  first pass and carry it with the item.

```tsx
const entries = items.map((post, index) => ({ post, index }));
const left = entries.filter(({ index }) => index % 2 === 0);

{left.map(({ post, index }) => (
  <CommunityCard index={index} key={post.id} post={post} />
))}
```

Passing `items.indexOf(post)` as `index` rescans the array for every card, so
rendering n items costs O(n²), and it returns the first match when the same item
appears twice.


## Pass cohesive state objects

When a child needs several related values, pass the object that owns them.
Preserve the ownership boundary instead of flattening it into a long props list.

```tsx
interface StageBoardTileProps {
  item: BoardItem;
  sample?: WorkloadSample;
  focused?: boolean;
}

<StageBoardTile item={item} sample={workloads.get(item.gameId)} />;
```

Passing `instanceId` and `gameId` separately would let a caller combine values
from different items. Passing `item` keeps their relationship visible.

Keep a session or controller returned by a hook whole when the child needs its
related state and actions:

```tsx
const session = useAgentAllowanceChain(sessionId);

<AgentAllowanceControls session={session} />;
```

The same applies to an animation controller: its active items, spawn action and
retire action belong together.

Keep the boundary focused:

- The object must represent one clear responsibility. Do not pass a whole
  telemetry or application-state bag just to avoid choosing what the child
  needs.
- Presentational primitives receive the domain values they draw. A board that
  renders `board`, `size` and `lastMove` does not need the session hook that
  supplied them.
- Preserve the meaning of domain values at the prop boundary. Do not transform
  them to compensate for a child rendering them incorrectly.
- Do not pass values the child can derive from an object it already receives.
  Avoid parallel maps or props carrying the same fact.
- Delete props the component does not read. An unused interface member can
  survive ordinary unused-variable checks.


## Type children with `PropsWithChildren`

Use `PropsWithChildren` from `react` when `children` is the only prop a component
takes. When the component takes other props as well, extend `PropsWithChildren`
in the props interface rather than declaring `children` by hand.

```tsx
import type { PropsWithChildren } from "react";

function Panel({ children }: PropsWithChildren) {
  return <div className="rounded-lg border p-3">{children}</div>;
}
```

```tsx
import type { PropsWithChildren } from "react";

interface CardProps extends PropsWithChildren {
  focused?: boolean;
}

function Card({ children, focused }: CardProps) {
  return <div className={card({ focused })}>{children}</div>;
}
```

Do not declare `children?: ReactNode`, and do not import `ReactNode` only to type
`children`. Keep an explicit `children` property only when the component narrows
its type, such as accepting a `string` rather than any renderable node.


## Add attributes only when they work

Prefer native semantic elements and existing primitives. Add `type`, `aria-*`,
`id`, `role`, `title` or `data-*` only when it serves a concrete behavior,
relationship, test, tooltip or accessibility consumer that the element does not
already provide.

An icon-only control needs an accessible name. Use visible or visually hidden
text when appropriate:

```tsx
<button onClick={onZoom}>
  <Maximize2 className="size-3.5" />
  <span className="sr-only">Zoom board</span>
</button>
```

A control with visible text already has a name. Avoid adding metadata that
merely repeats that name or the element's native semantics. Preserve attributes
that communicate an otherwise missing interaction state or relationship.

**`type` controls behavior.** Add `type="button"` when a button belongs to a
form and must not submit it. Outside a form, add it only for a concrete reason.
Keep meaningful input types: they select browser controls, keyboards and
validation behavior.

**`data-*` needs a reader.** Keep an attribute when a selector, test or DOM
consumer uses it. An attribute copied from generated scaffolding is not useful
merely because it was there before.

Before removing an attribute, search outside the component for consumers such
as `querySelector`, attribute selectors, `getByTitle` and direct DOM reads.
Migrate the consumer in the same change or keep the attribute. Do not remove
working accessibility metadata mechanically: `aria-hidden="true"` on a
decorative SVG has a purpose even without a code reference.


## Express styling with `tailwind-variants`

Use `tv` from `tailwind-variants` as the class composition API. Do not introduce
`cn`, `clsx`, `class-variance-authority` or a separate `tailwind-merge` helper.
Pass caller classes through the contract so its merge step resolves conflicting
utilities.

Use `tv` when:

1. A variant switches the class set.
2. A component merges a caller's `className` with its base classes.
3. A class set composes with a variable, such as a category's fill token.

For static, single-use classes, write the literal inline:

```tsx
<div className="space-y-2.5 p-2.5">{children}</div>
```

Define needed contracts once at module scope:

```tsx
import type { PropsWithChildren } from "react";
import { tv } from "tailwind-variants";

const panel = tv({
  base: "rounded-lg border p-3",
  variants: {
    focused: {
      true: "ring-2 ring-primary",
      false: "ring-0",
    },
  },
});

interface PanelProps extends PropsWithChildren {
  focused?: boolean;
  className?: string;
}

function Panel({ children, focused, className }: PanelProps) {
  return <div className={panel({ focused, className })}>{children}</div>;
}
```

Use variants for conditional classes and the `className` argument for variable
classes. Import `VariantProps` from `tailwind-variants` when extracting variant
types.

| Intent | Expression |
| --- | --- |
| Merge caller classes | `panel({ className })` |
| Switch a state | `panel({ focused })` |
| Compose a variable class | `dot({ className: category.fill })` |
| Combine static classes | One inline literal |

Do not concatenate a `tv()` result with a template literal or manually compose
conditional class strings. Doing so bypasses the merge over the complete class
set. Shared class tokens may remain plain strings when passed into `base` or
through `className` for merging.

**Use slots for parts that share state.** When one value drives several
elements, keep their styles in one contract:

```ts
const seat = tv({
  slots: {
    card: "rounded-lg border p-3",
    pip: "size-2.5 rounded-full",
  },
  variants: {
    waiting: {
      true: { card: "ring-2 ring-primary", pip: "animate-pulse bg-primary" },
      false: { pip: "bg-surface-2" },
    },
  },
});
```

Resolve shared state together with `seat({ waiting })`. Slot functions can also
take variants at their call sites when an axis varies per item.

Judge slots by the state value and how the parts are consumed. Two independent
controls both naming a variant `active` do not share state. Static parts stay
inline; parts with independent variants keep separate contracts. Parts always
consumed together, such as a positioner and its popup, may form one slot contract.
An independently reusable primitive keeps its own contract.

When replacing existing class expressions, preserve the meaning of every state.
Resolve and compare every old and new variant combination, and compare emitted
CSS when the change is intended to preserve styling.


## Reach for the layout primitives

Use `space-y-*` or `space-x-*` for a plain stack whose children only need spacing.

```tsx
<header className="space-y-1">
  <h1>{title}</h1>

  <p>{description}</p>
</header>
```

Use the project's shared `Flex` primitive when the layout requires flex behavior:
`justify-between`, `items-baseline`, `flex-1`, a child's `ml-auto`, or wrapping.
Sibling margins cannot replace those behaviors.

```tsx
<Flex className="items-baseline justify-between gap-2">
  <h2>{title}</h2>

  <p>{total}</p>
</Flex>
```

Use `Center` for both-axis centering. A row with vertically aligned content and
an `ml-auto` item is a `Flex`; adding horizontal centering would conflict with
that layout. Use the project's equivalent primitives when they have different
names, and inspect their defaults before substituting them.

Keep semantic elements such as `header`, `nav`, `main` and `aside` when they
describe the region. Semantic elements may carry layout utilities directly.
Prefer parent spacing and gap utilities over separate margins on every child.

Spell out complete Tailwind class names instead of assembling them at runtime.
Use the project's theme tokens for palette, typography and radius values; do
not introduce component-local hex colors or palette branches.
