import { tv } from "tailwind-variants";

import { type CatalogGroup } from "@/services/catalog";

/**
 * The nine hues a group can be drawn in.
 *
 * Keyed by colour rather than by meaning, because a group is a folder name now
 * and folder names are not a closed set. Nine that stay apart on white is the
 * constraint; the specific hues are spaced around the wheel rather than chosen
 * for what they signify.
 */
const TONE_SLOTS = [
  "indigo",
  "fuchsia",
  "violet",
  "slate",
  "sky",
  "emerald",
  "teal",
  "amber",
  "rose",
] as const;

type ToneSlot = (typeof TONE_SLOTS)[number];

/**
 * The colours the catalogue's current folders already wear.
 *
 * These are pinned so the canvas does not repaint itself every time an unrelated
 * folder is added, and so the eight that can share one open tree stay distinct:
 * everything under `harness/` is here, and no two of them collide. `emerald` is
 * deliberately unclaimed, so the first new folder gets a hue nothing else in
 * that tree is using.
 */
const PINNED_TONES: Record<string, ToneSlot> = {
  harness: "indigo",
  hooks: "fuchsia",
  tags: "violet",
  github: "slate",
  linear: "sky",
  playwright: "teal",
  evidence: "amber",
  projects: "rose",
  skills: "violet",
  templates: "sky",
  installer: "emerald",
};

/**
 * A colour for any folder name, including one nobody has seen.
 *
 * Hashed rather than assigned in order, so a group keeps its colour when
 * another is added beside it — an index-based palette would reshuffle the whole
 * tree the moment somebody's pull request landed alphabetically first.
 */
export function toneForGroup(group: CatalogGroup): ToneSlot {
  const pinned = PINNED_TONES[group];

  if (pinned) return pinned;

  let hash = 0;

  for (let index = 0; index < group.length; index += 1) {
    hash = (hash * 31 + group.charCodeAt(index)) % 2_147_483_647;
  }

  return TONE_SLOTS[hash % TONE_SLOTS.length];
}

/**
 * The one place a group becomes a colour.
 *
 * A group shows up as a card badge, as the port its branch lands on, as the
 * heading naming it, and as every line under it — four files, one fact. Slots
 * rather than four tables because every one of them is fed from the same
 * `entry.group`, and a table that drifted would colour a card's badge indigo
 * while its line said amber.
 */
export const groupTone = tv({
  slots: {
    badge:
      "flex items-center gap-1 rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold",
    // The heading is opaque and sits above the trunk, so the grey spine reads
    // as a line running into the group rather than past it.
    heading:
      "pointer-events-none absolute z-20 flex items-center justify-between gap-3 rounded-xl border-2 bg-card px-4 shadow-xs select-none",
    headingLabel: "font-mono text-sm font-bold tracking-wider uppercase",
    headingCount:
      "rounded-full border px-2 py-0.5 font-mono text-[11px] font-bold",
    branch: "",
    node: "",
    portDot: "size-1.5 rounded-full",
    portRing:
      "pointer-events-none absolute -top-2 left-1/2 grid size-4 -translate-x-1/2 place-items-center rounded-full border-2 bg-card shadow-xs transition-transform group-hover:scale-110",
  },
  variants: {
    tone: {
      indigo: {
        badge: "border-indigo-200 bg-indigo-50 text-indigo-700",
        heading: "border-indigo-300",
        headingLabel: "text-indigo-700",
        headingCount: "border-indigo-200 bg-indigo-50 text-indigo-700",
        branch: "stroke-indigo-400",
        node: "fill-indigo-500",
        portDot: "bg-indigo-500",
        portRing: "border-indigo-500",
      },
      fuchsia: {
        badge: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        heading: "border-fuchsia-300",
        headingLabel: "text-fuchsia-700",
        headingCount: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        branch: "stroke-fuchsia-400",
        node: "fill-fuchsia-500",
        portDot: "bg-fuchsia-500",
        portRing: "border-fuchsia-500",
      },
      violet: {
        badge: "border-violet-200 bg-violet-50 text-violet-700",
        heading: "border-violet-300",
        headingLabel: "text-violet-700",
        headingCount: "border-violet-200 bg-violet-50 text-violet-700",
        branch: "stroke-violet-400",
        node: "fill-violet-500",
        portDot: "bg-violet-500",
        portRing: "border-violet-500",
      },
      slate: {
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        heading: "border-slate-300",
        headingLabel: "text-slate-700",
        headingCount: "border-slate-200 bg-slate-50 text-slate-700",
        branch: "stroke-slate-400",
        node: "fill-slate-500",
        portDot: "bg-slate-500",
        portRing: "border-slate-500",
      },
      sky: {
        badge: "border-sky-200 bg-sky-50 text-sky-700",
        heading: "border-sky-300",
        headingLabel: "text-sky-700",
        headingCount: "border-sky-200 bg-sky-50 text-sky-700",
        branch: "stroke-sky-400",
        node: "fill-sky-500",
        portDot: "bg-sky-500",
        portRing: "border-sky-500",
      },
      emerald: {
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
        heading: "border-emerald-300",
        headingLabel: "text-emerald-700",
        headingCount: "border-emerald-200 bg-emerald-50 text-emerald-700",
        branch: "stroke-emerald-400",
        node: "fill-emerald-500",
        portDot: "bg-emerald-500",
        portRing: "border-emerald-500",
      },
      teal: {
        badge: "border-teal-200 bg-teal-50 text-teal-700",
        heading: "border-teal-300",
        headingLabel: "text-teal-700",
        headingCount: "border-teal-200 bg-teal-50 text-teal-700",
        branch: "stroke-teal-400",
        node: "fill-teal-500",
        portDot: "bg-teal-500",
        portRing: "border-teal-500",
      },
      amber: {
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        heading: "border-amber-300",
        headingLabel: "text-amber-700",
        headingCount: "border-amber-200 bg-amber-50 text-amber-700",
        branch: "stroke-amber-400",
        node: "fill-amber-500",
        portDot: "bg-amber-500",
        portRing: "border-amber-500",
      },
      rose: {
        badge: "border-rose-200 bg-rose-50 text-rose-700",
        heading: "border-rose-300",
        headingLabel: "text-rose-700",
        headingCount: "border-rose-200 bg-rose-50 text-rose-700",
        branch: "stroke-rose-400",
        node: "fill-rose-500",
        portDot: "bg-rose-500",
        portRing: "border-rose-500",
      },
    },
  },
});

/** Every slot for one group, resolved through its pinned or hashed colour. */
export function groupSlots(group: CatalogGroup) {
  return groupTone({ tone: toneForGroup(group) });
}

/**
 * The root cards, and the tab that opens each one.
 *
 * Keyed by colour rather than by name, for the same reason the group table is:
 * `/tools` invents a root by gaining a directory, so a table listing which
 * roots exist would be a list of what is allowed to exist.
 */
export const rootTone = tv({
  slots: {
    // z-20 puts a root above the branch layer: its own trunk leaves from under
    // it, and a line drawn through a card reads as a line drawn over it.
    card: "group absolute top-0 left-0 z-20 flex cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card p-5 text-left shadow-xs transition-all duration-200 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
    iconChip: "rounded-xl border p-2.5 shadow-xs",
    tab: "",
  },
  variants: {
    tone: {
      indigo: {
        iconChip: "border-indigo-200 bg-indigo-50 text-indigo-600",
        tab: "bg-indigo-600 hover:bg-indigo-700",
      },
      fuchsia: {
        iconChip: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-600",
        tab: "bg-fuchsia-600 hover:bg-fuchsia-700",
      },
      violet: {
        iconChip: "border-violet-200 bg-violet-50 text-violet-600",
        tab: "bg-violet-600 hover:bg-violet-700",
      },
      slate: {
        iconChip: "border-slate-200 bg-slate-50 text-slate-600",
        tab: "bg-slate-600 hover:bg-slate-700",
      },
      sky: {
        iconChip: "border-sky-200 bg-sky-50 text-sky-600",
        tab: "bg-sky-600 hover:bg-sky-700",
      },
      emerald: {
        iconChip: "border-emerald-200 bg-emerald-50 text-emerald-600",
        tab: "bg-emerald-600 hover:bg-emerald-700",
      },
      teal: {
        iconChip: "border-teal-200 bg-teal-50 text-teal-600",
        tab: "bg-teal-600 hover:bg-teal-700",
      },
      amber: {
        iconChip: "border-amber-200 bg-amber-50 text-amber-600",
        tab: "bg-amber-600 hover:bg-amber-700",
      },
      rose: {
        iconChip: "border-rose-200 bg-rose-50 text-rose-600",
        tab: "bg-rose-600 hover:bg-rose-700",
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
      tone: "fuchsia",
      expanded: true,
      class: {
        card: "border-fuchsia-500 shadow-lg ring-4 shadow-fuchsia-500/5 ring-fuchsia-500/10",
      },
    },
    {
      tone: "violet",
      expanded: true,
      class: {
        card: "border-violet-500 shadow-lg ring-4 shadow-violet-500/5 ring-violet-500/10",
      },
    },
    {
      tone: "slate",
      expanded: true,
      class: {
        card: "border-slate-500 shadow-lg ring-4 shadow-slate-500/5 ring-slate-500/10",
      },
    },
    {
      tone: "sky",
      expanded: true,
      class: {
        card: "border-sky-500 shadow-lg ring-4 shadow-sky-500/5 ring-sky-500/10",
      },
    },
    {
      tone: "emerald",
      expanded: true,
      class: {
        card: "border-emerald-500 shadow-lg ring-4 shadow-emerald-500/5 ring-emerald-500/10",
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
      tone: "amber",
      expanded: true,
      class: {
        card: "border-amber-500 shadow-lg ring-4 shadow-amber-500/5 ring-amber-500/10",
      },
    },
    {
      tone: "rose",
      expanded: true,
      class: {
        card: "border-rose-500 shadow-lg ring-4 shadow-rose-500/5 ring-rose-500/10",
      },
    },
  ],
});

/** Every root slot, resolved through its pinned or hashed colour. */
export function rootSlots(
  root: CatalogGroup,
  state: { expanded?: boolean; dimmed?: boolean } = {},
) {
  return rootTone({ tone: toneForGroup(root), ...state });
}
