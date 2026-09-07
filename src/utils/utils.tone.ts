import { tv } from "tailwind-variants";

import { type CatalogCategory } from "@/services/catalog";

/**
 * The hues a canvas draws with, and the neutral it falls back to.
 *
 * Three hues rather than nine, because colour is keyed to the root card now and
 * a canvas draws two or three of those. `slate` is not a fourth hue competing
 * with the others — it is what a root wears before anybody decided what it
 * should wear, and grey beside indigo reads as "unclassified" rather than as
 * one more thing to tell apart.
 */
type ToneSlot = "indigo" | "teal" | "fuchsia" | "slate";

/** The neutral a root gets until somebody gives it a hue. */
const UNCLAIMED_TONE: ToneSlot = "slate";

/**
 * Which root wears which hue.
 *
 * Keyed by root and nothing below it. A group is a folder a contributor invents
 * by making a directory, so colouring groups meant an open set feeding a closed
 * palette: the nine slots this replaced were already over-subscribed — `tags`
 * and `skills` both drew violet, `linear` and `templates` both drew sky — and
 * every hash collision after that was another pair nobody chose. Roots are the
 * level that grows in years rather than in pull requests, so they are the level
 * a table can honestly hold.
 *
 * Two canvases, so the hues repeat across them. `/library` and `/tools` are
 * never on screen together and no shared surface tints by root, so `installer`
 * taking indigo costs nothing that `harness` needed.
 *
 * `hooks` is absent on purpose: `ROOT_ALIASES` folds it into `harness` before a
 * colour is ever asked for.
 */
const ROOT_TONES: Record<string, ToneSlot> = {
  harness: "indigo",
  skills: "teal",
  templates: "fuchsia",
  installer: "indigo",
  mcp: "teal",
};

/**
 * A colour for any root, including one nobody has seen.
 *
 * A miss is neutral rather than hashed. Hashing gave an unknown folder a real
 * hue instantly, which sounds generous and means the canvas repaints itself
 * around whatever a stranger called their directory — and that a reviewer
 * reading the diff has no say in it. Grey is a working answer, not a rejection:
 * the root draws, groups, opens and reads, and promoting it later is one line
 * in the table above.
 */
export function toneForRoot(root: CatalogCategory): ToneSlot {
  return ROOT_TONES[root] ?? UNCLAIMED_TONE;
}

/**
 * The one place a root becomes a colour.
 *
 * One table rather than two, because every slot below is fed from the same
 * value. A root card, the tab that opens it, the trunk under it, each heading
 * on that trunk, every line below those and the badge on every card are all one
 * tree's colour, so a call site that knows the root knows all of them. Two
 * tables keyed on the same value are two tables that can drift, and nothing
 * would make a caller pass them the same root.
 *
 * Depth is the other axis and it is spelled into the slots rather than into a
 * variant: a slot already knows how deep it sits. The ladder runs pale to
 * saturated on the way out — trunk at 300, branches at 400, nodes and ports at
 * 500 — so a tree reads as one thing with structure rather than as a stack of
 * unrelated lines.
 */
export const rootTone = tv({
  slots: {
    // z-20 puts a root above the branch layer: its own trunk leaves from under
    // it, and a line drawn through a card reads as a line drawn over it.
    card: "group absolute top-0 left-0 z-20 flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card p-5 text-left shadow-xs transition-all duration-200 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
    iconChip: "rounded-xl border p-2.5 shadow-xs",
    tab: "",
    // The trunk carries the root's hue now. It used to be grey to keep one more
    // colour out of a picture whose groups were each a different one; there is
    // no such hue to avoid when the whole tree is the root's, and the line that
    // leaves the card is the most literal statement of which tree this is.
    trunk: "",
    // The heading is opaque and sits above the trunk, so the pale trunk reads
    // as a line running into the group rather than past it.
    heading:
      "pointer-events-none absolute z-20 flex items-center justify-between gap-3 rounded-xl border-2 bg-card px-4 shadow-xs select-none",
    headingLabel: "font-mono text-sm font-bold tracking-wider uppercase",
    headingCount:
      "rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold",
    branch: "",
    node: "",
    badge:
      "flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold",
    portDot: "size-1.5 rounded-full",
    portRing:
      "pointer-events-none absolute -top-2 left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full border-2 bg-card shadow-xs transition-transform group-hover:scale-110",
  },
  variants: {
    tone: {
      indigo: {
        iconChip: "border-indigo-200 bg-indigo-50 text-indigo-600",
        tab: "bg-indigo-600 hover:bg-indigo-700",
        trunk: "stroke-indigo-300",
        heading: "border-indigo-300",
        headingLabel: "text-indigo-700",
        headingCount: "border-indigo-200 bg-indigo-50 text-indigo-700",
        branch: "stroke-indigo-400",
        node: "fill-indigo-500",
        badge: "border-indigo-200 bg-indigo-50 text-indigo-700",
        portDot: "bg-indigo-500",
        portRing: "border-indigo-500",
      },
      teal: {
        iconChip: "border-teal-200 bg-teal-50 text-teal-600",
        tab: "bg-teal-600 hover:bg-teal-700",
        trunk: "stroke-teal-300",
        heading: "border-teal-300",
        headingLabel: "text-teal-700",
        headingCount: "border-teal-200 bg-teal-50 text-teal-700",
        branch: "stroke-teal-400",
        node: "fill-teal-500",
        badge: "border-teal-200 bg-teal-50 text-teal-700",
        portDot: "bg-teal-500",
        portRing: "border-teal-500",
      },
      fuchsia: {
        iconChip: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-600",
        tab: "bg-fuchsia-600 hover:bg-fuchsia-700",
        trunk: "stroke-fuchsia-300",
        heading: "border-fuchsia-300",
        headingLabel: "text-fuchsia-700",
        headingCount: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        branch: "stroke-fuchsia-400",
        node: "fill-fuchsia-500",
        badge: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        portDot: "bg-fuchsia-500",
        portRing: "border-fuchsia-500",
      },
      slate: {
        iconChip: "border-slate-200 bg-slate-50 text-slate-600",
        tab: "bg-slate-600 hover:bg-slate-700",
        trunk: "stroke-slate-300",
        heading: "border-slate-300",
        headingLabel: "text-slate-700",
        headingCount: "border-slate-200 bg-slate-50 text-slate-700",
        branch: "stroke-slate-400",
        node: "fill-slate-500",
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        portDot: "bg-slate-500",
        portRing: "border-slate-500",
      },
    },
    expanded: {
      false: {
        card: "border-slate-200/90 hover:border-slate-300 hover:shadow-md",
      },
      true: {},
    },
    // The other roots read as spent while one tree is out, but they stay
    // clickable: switching trees is the common move, and making it cost an undo
    // first is a step nobody wants to take twice.
    dimmed: { true: { card: "opacity-45 shadow-none" } },
  },
  compoundVariants: [
    {
      tone: "indigo",
      expanded: true,
      class: {
        card: "border-indigo-500 shadow-lg ring-4 shadow-indigo-500/5 ring-indigo-500/10",
      },
    },
    {
      tone: "teal",
      expanded: true,
      class: {
        card: "border-teal-500 shadow-lg ring-4 shadow-teal-500/5 ring-teal-500/10",
      },
    },
    {
      tone: "fuchsia",
      expanded: true,
      class: {
        card: "border-fuchsia-500 shadow-lg ring-4 shadow-fuchsia-500/5 ring-fuchsia-500/10",
      },
    },
    {
      tone: "slate",
      expanded: true,
      class: {
        card: "border-slate-500 shadow-lg ring-4 shadow-slate-500/5 ring-slate-500/10",
      },
    },
  ],
});

interface RootSlotsState {
  /** Another root's tree is out, so this one is not the one being read. */
  dimmed?: boolean;
  expanded?: boolean;
}

/** Every slot for one tree, resolved through its root's colour. */
export function rootSlots(root: CatalogCategory, state: RootSlotsState = {}) {
  return rootTone({ tone: toneForRoot(root), ...state });
}
