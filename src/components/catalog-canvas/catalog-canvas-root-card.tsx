import {
  Boxes,
  FileCode2,
  Plug,
  Sparkles,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import {
  groupLabel,
  rootLabel,
  rootSummary,
  type CatalogCategory,
  type CatalogGroup,
} from "@/services/catalog";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { rootSlots } from "@/utils/utils.tone";

import {
  CATEGORY_CARD_HEIGHT,
  CATEGORY_CARD_WIDTH,
  type CanvasPosition,
} from "./catalog-canvas-geometry";

/**
 * A glyph for the roots that have one, and a shape for the ones that do not.
 *
 * Falling back rather than requiring an entry is what lets a new folder appear
 * on the canvas without touching this file.
 */
const rootIcons: Record<string, LucideIcon> = {
  harness: Boxes,
  skills: Sparkles,
  templates: FileCode2,
  installer: Terminal,
  mcp: Plug,
};

interface CatalogCanvasRootCardProps {
  category: CatalogCategory;
  entryCount: number;
  /** The folders this category holds, in the order its tree draws them. */
  groups: CatalogGroup[];
  /** Another category's tree is out, so this root is not the one being read. */
  isDimmed: boolean;
  isExpanded: boolean;
  position: CanvasPosition;
  onSelect: () => void;
}

export default function CatalogCanvasRootCard({
  category,
  entryCount,
  groups,
  isDimmed,
  isExpanded,
  position,
  onSelect,
}: CatalogCanvasRootCardProps) {
  const CategoryIcon = rootIcons[category] ?? Boxes;
  const { card, iconChip } = rootSlots(category, {
    dimmed: isDimmed,
    expanded: isExpanded,
  });

  return (
    <button
      type="button"
      aria-pressed={isExpanded}
      style={{
        transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        width: `${CATEGORY_CARD_WIDTH}px`,
        // Every root is the same height whatever it holds, and the trunk
        // leaves from exactly this many units below the card's top.
        height: `${CATEGORY_CARD_HEIGHT}px`,
      }}
      className={card()}
      onClick={onSelect}
    >
      <Flex className="items-center gap-3">
        <Center className={iconChip()}>
          <CategoryIcon aria-hidden="true" className="size-6" />
        </Center>

        <h2 className="text-lg font-bold tracking-tight">
          {rootLabel(category)} ({entryCount})
        </h2>
      </Flex>

      <p className="mt-3 line-clamp-3 text-muted-foreground text-sm/relaxed">
        {rootSummary(category)}
      </p>

      {/* The same folders the tree headings name, so a closed root already says
          what opening it will show.

          Grey, and static: this is a list of names, and a card carrying four
          coloured chips would be four colours arguing with the icon that
          already says which root this is. The tree below is where this root's
          hue does its work. */}
      <Flex className="mt-auto items-stretch gap-1.5 flex-wrap">
        {groups.map((group) => (
          <span
            key={group}
            className="flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-0.5 font-mono text-[11px] font-semibold text-slate-600"
          >
            {groupLabel(group)}
          </span>
        ))}
      </Flex>
    </button>
  );
}
