import { ChevronRight, FileText } from "lucide-react";
import { tv } from "tailwind-variants";

import { AREA_LABELS, type CatalogEntry } from "@/services/catalog";
import { areaTone } from "@/styles/library/library-index";

import { ENTRY_CARD_WIDTH, type CanvasPosition } from "./canvas-geometry";

const cardVariants = tv({
  // z-10 keeps a card above the branch layer, which draws each line's bar and
  // drops behind the row it feeds.
  base: "group absolute top-0 left-0 z-10 flex cursor-pointer flex-col rounded-2xl border bg-card p-4 text-left shadow-xs transition-all duration-150 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden disabled:cursor-default disabled:opacity-30",
  variants: {
    selected: {
      true: "border-indigo-500 shadow-md ring-2 ring-indigo-500/20",
      false: "border-slate-200/90 hover:border-slate-300 hover:shadow-md",
    },
  },
});

interface EntryCardProps {
  entry: CatalogEntry;
  /** Search filtered this card out. It stays drawn, and stops being reachable. */
  isDimmed: boolean;
  isSelected: boolean;
  position: CanvasPosition;
  onSelect: (entry: CatalogEntry) => void;
}

export default function EntryCard({
  entry,
  isDimmed,
  isSelected,
  position,
  onSelect,
}: EntryCardProps) {
  const { badge, portDot, portRing } = areaTone({ area: entry.area });

  return (
    <button
      type="button"
      disabled={isDimmed}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${ENTRY_CARD_WIDTH}px`,
      }}
      className={cardVariants({ selected: isSelected })}
      onClick={() => onSelect(entry)}
    >
      {/* Where the branch from the line above lands. */}
      <div className={portRing()}>
        <div className={portDot()} />
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-1.5 border-b border-slate-100 pb-2">
        <span className={badge()}>{AREA_LABELS[entry.area]}</span>

        <span className="flex items-center gap-1 font-mono text-[11px] text-slate-400">
          <FileText aria-hidden="true" className="size-3" />
          {entry.lineCount} lines
        </span>
      </div>

      <h3 className="text-base font-semibold tracking-tight transition-colors group-hover:text-indigo-600">
        {entry.name}
      </h3>

      <p className="mt-1 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {entry.description}
      </p>

      <div className="mt-auto flex items-center justify-between gap-2 border-t border-slate-100 pt-3 font-mono text-xs text-muted-foreground">
        <span className="truncate">{entry.id}.md</span>

        <span className="flex shrink-0 items-center gap-0.5 font-sans font-medium text-indigo-600 transition-transform group-hover:translate-x-0.5">
          Read
          <ChevronRight aria-hidden="true" className="size-3.5" />
        </span>
      </div>
    </button>
  );
}
