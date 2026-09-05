import { tv } from "tailwind-variants";

/**
 * The one place an integration area becomes a colour.
 *
 * An area shows up as a card badge, as the port its branch lands on, as the
 * heading naming its group, and as every line under it — four files, one fact. Slots rather than
 * three tables because every one of them is fed from the same `entry.area`, and
 * a table that drifted would colour a card's badge indigo while its line said
 * amber.
 *
 * Nine integrations need nine hues that stay apart on white. Workflow keeps
 * indigo because it is the workspace's own accent; GitHub takes slate because
 * it is the one that shows up in every other group and should not shout. The
 * rest are spaced around the wheel rather than chosen for meaning.
 */
export const areaTone = tv({
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
    area: {
      workflow: {
        badge: "border-indigo-200 bg-indigo-50 text-indigo-700",
        heading: "border-indigo-300",
        headingLabel: "text-indigo-700",
        headingCount: "border-indigo-200 bg-indigo-50 text-indigo-700",
        branch: "stroke-indigo-400",
        node: "fill-indigo-500",
        portDot: "bg-indigo-500",
        portRing: "border-indigo-500",
      },
      delivery: {
        badge: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        heading: "border-fuchsia-300",
        headingLabel: "text-fuchsia-700",
        headingCount: "border-fuchsia-200 bg-fuchsia-50 text-fuchsia-700",
        branch: "stroke-fuchsia-400",
        node: "fill-fuchsia-500",
        portDot: "bg-fuchsia-500",
        portRing: "border-fuchsia-500",
      },
      frontend: {
        badge: "border-violet-200 bg-violet-50 text-violet-700",
        heading: "border-violet-300",
        headingLabel: "text-violet-700",
        headingCount: "border-violet-200 bg-violet-50 text-violet-700",
        branch: "stroke-violet-400",
        node: "fill-violet-500",
        portDot: "bg-violet-500",
        portRing: "border-violet-500",
      },
      github: {
        badge: "border-slate-200 bg-slate-50 text-slate-700",
        heading: "border-slate-300",
        headingLabel: "text-slate-700",
        headingCount: "border-slate-200 bg-slate-50 text-slate-700",
        branch: "stroke-slate-400",
        node: "fill-slate-500",
        portDot: "bg-slate-500",
        portRing: "border-slate-500",
      },
      linear: {
        badge: "border-sky-200 bg-sky-50 text-sky-700",
        heading: "border-sky-300",
        headingLabel: "text-sky-700",
        headingCount: "border-sky-200 bg-sky-50 text-sky-700",
        branch: "stroke-sky-400",
        node: "fill-sky-500",
        portDot: "bg-sky-500",
        portRing: "border-sky-500",
      },
      supabase: {
        badge: "border-emerald-200 bg-emerald-50 text-emerald-700",
        heading: "border-emerald-300",
        headingLabel: "text-emerald-700",
        headingCount: "border-emerald-200 bg-emerald-50 text-emerald-700",
        branch: "stroke-emerald-400",
        node: "fill-emerald-500",
        portDot: "bg-emerald-500",
        portRing: "border-emerald-500",
      },
      playwright: {
        badge: "border-teal-200 bg-teal-50 text-teal-700",
        heading: "border-teal-300",
        headingLabel: "text-teal-700",
        headingCount: "border-teal-200 bg-teal-50 text-teal-700",
        branch: "stroke-teal-400",
        node: "fill-teal-500",
        portDot: "bg-teal-500",
        portRing: "border-teal-500",
      },
      evidence: {
        badge: "border-amber-200 bg-amber-50 text-amber-700",
        heading: "border-amber-300",
        headingLabel: "text-amber-700",
        headingCount: "border-amber-200 bg-amber-50 text-amber-700",
        branch: "stroke-amber-400",
        node: "fill-amber-500",
        portDot: "bg-amber-500",
        portRing: "border-amber-500",
      },
      projects: {
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

/**
 * The four root cards.
 *
 * The chip and the open card's border are the same fact — which category this
 * is — so they are slots of one table, and the border also has to know whether
 * the tree is out, which is what the compound rows below are for.
 */
export const categoryTone = tv({
  slots: {
    // z-20 puts a root above the branch layer: its own trunk leaves from under
    // it, and a line drawn through a card reads as a line drawn over it.
    card: "group absolute top-0 left-0 z-20 cursor-pointer rounded-2xl border bg-card p-5 text-left shadow-xs transition-all duration-200 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
    iconChip: "rounded-xl border p-2.5 shadow-xs",
  },
  variants: {
    category: {
      HARNESSES: { iconChip: "border-indigo-200 bg-indigo-50 text-indigo-600" },
      SKILLS: { iconChip: "border-violet-200 bg-violet-50 text-violet-600" },
      HOOKS: { iconChip: "border-amber-200 bg-amber-50 text-amber-600" },
      TEMPLATES: { iconChip: "border-sky-200 bg-sky-50 text-sky-600" },
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
      category: "HARNESSES",
      expanded: true,
      class: {
        card: "border-indigo-500 shadow-lg ring-4 shadow-indigo-500/5 ring-indigo-500/10",
      },
    },
    {
      category: "SKILLS",
      expanded: true,
      class: {
        card: "border-violet-500 shadow-lg ring-4 shadow-violet-500/5 ring-violet-500/10",
      },
    },
    {
      category: "HOOKS",
      expanded: true,
      class: {
        card: "border-amber-500 shadow-lg ring-4 shadow-amber-500/5 ring-amber-500/10",
      },
    },
    {
      category: "TEMPLATES",
      expanded: true,
      class: {
        card: "border-sky-500 shadow-lg ring-4 shadow-sky-500/5 ring-sky-500/10",
      },
    },
  ],
});
