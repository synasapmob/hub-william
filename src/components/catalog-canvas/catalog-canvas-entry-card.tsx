import { FileText } from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { groupLabel, type CatalogEntry } from "@/services/catalog";
import { rootSlots } from "@/utils/utils.tone";

import {
  ENTRY_CARD_HEIGHT,
  ENTRY_CARD_WIDTH,
  type CanvasPosition,
} from "./catalog-canvas-geometry";

const cardVariants = tv({
  // z-10 keeps a card above the branch layer, which draws each line's bar and
  // drops behind the row it feeds.
  base: "group absolute top-0 left-0 z-10 flex cursor-pointer flex-col rounded-2xl border bg-card p-4 text-left shadow-xs transition-all duration-150 select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden disabled:cursor-default disabled:opacity-30",
  variants: {
    selected: {
      true: "border-indigo-500 shadow-md ring-2 ring-indigo-500/20",
      false: "border-border hover:border-zinc-600 hover:shadow-md",
    },
  },
});

interface CatalogCanvasEntryCardProps {
  entry: CatalogEntry;
  /** Search filtered this card out. It stays drawn, and stops being reachable. */
  isDimmed: boolean;
  isSelected: boolean;
  position: CanvasPosition;
  onSelect: (entry: CatalogEntry) => void;
}

export default function CatalogCanvasEntryCard({
  entry,
  isDimmed,
  isSelected,
  position,
  onSelect,
}: CatalogCanvasEntryCardProps) {
  // The card's colour comes from the tree it hangs in, not from its own folder.
  // The badge still names the folder — that is the label's job, and the label
  // is the part that has to keep working when a contributor invents a folder
  // nothing has a colour for.
  const { badge, portDot, portRing } = rootSlots(entry.category);

  return (
    <button
      type="button"
      disabled={isDimmed}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${ENTRY_CARD_WIDTH}px`,
        // Pinned, not measured: the geometry already spaces rows by this
        // number, so letting the element pick its own height is what made one
        // row of cards ragged against the next.
        height: `${ENTRY_CARD_HEIGHT}px`,
      }}
      className={cardVariants({ selected: isSelected })}
      onClick={() => onSelect(entry)}
    >
      {/* Where the branch from the line above lands. */}
      <div className={portRing()}>
        <div className={portDot()} />
      </div>

      <Flex className="items-center justify-between gap-1.5 flex-wrap mb-2 border-b border-border pb-2">
        <span className={badge()}>{groupLabel(entry.group)}</span>

        <span className="flex items-center gap-1 font-mono text-[11px] text-muted-foreground">
          <FileText aria-hidden="true" className="size-3" />
          {entry.lineCount} lines
        </span>
      </Flex>

      <h3 className="line-clamp-2 text-base font-semibold tracking-tight transition-colors group-hover:text-indigo-400">
        {entry.name}
      </h3>

      <p className="mt-1 line-clamp-3 text-muted-foreground text-sm/relaxed">
        {entry.description}
      </p>

      {/* `mt-auto` rather than a margin: the card is a fixed height now, so the
          path sits on the bottom edge whether the description ran to one line
          or three. `truncate` because a long id set to `break-all` was the
          other thing that changed a card's height. */}
      <div className="mt-auto border-t border-border pt-3 font-mono text-xs text-muted-foreground">
        <span className="block truncate">{entry.id}.md</span>
      </div>
    </button>
  );
}
