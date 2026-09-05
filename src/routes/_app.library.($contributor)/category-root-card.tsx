import { Boxes, FileCode2, GitFork, Layers, Sparkles } from "lucide-react";

import {
  AREA_LABELS,
  CATEGORY_SUMMARIES,
  type CatalogArea,
  type CatalogCategory,
} from "@/services/catalog";
import { areaTone, categoryTone } from "@/styles/library/library-index";

import { CATEGORY_CARD_WIDTH, type CanvasPosition } from "./canvas-geometry";

const categoryIcons = {
  HARNESSES: Boxes,
  SKILLS: Sparkles,
  HOOKS: GitFork,
  TEMPLATES: FileCode2,
} as const;

interface CategoryRootCardProps {
  /** The integrations this category covers, in the order its tree draws them. */
  areas: CatalogArea[];
  category: CatalogCategory;
  entryCount: number;
  /** Another category's tree is out, so this root is not the one being read. */
  isDimmed: boolean;
  isExpanded: boolean;
  position: CanvasPosition;
  onSelect: () => void;
}

export default function CategoryRootCard({
  areas,
  category,
  entryCount,
  isDimmed,
  isExpanded,
  position,
  onSelect,
}: CategoryRootCardProps) {
  const CategoryIcon = categoryIcons[category];
  const { card, iconChip } = categoryTone({
    category,
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
      }}
      className={card()}
      onClick={onSelect}
    >
      <div className="flex items-center gap-3">
        <div className={iconChip()}>
          <CategoryIcon aria-hidden="true" className="size-6" />
        </div>

        <h2 className="text-lg font-bold tracking-tight">{category}</h2>
      </div>

      <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
        {CATEGORY_SUMMARIES[category]}
      </p>

      {/* The same integrations the tree headings name, so a closed root already
          says what opening it will show. */}
      <div className="mt-3.5 flex flex-wrap gap-1.5">
        {areas.map((area) => (
          <span key={area} className={areaTone({ area }).badge()}>
            {AREA_LABELS[area]}
          </span>
        ))}
      </div>

      <p className="mt-4 flex items-center gap-2 border-t border-slate-100 pt-4 font-mono text-sm text-muted-foreground">
        <Layers aria-hidden="true" className="size-4 text-slate-400" />
        <strong className="text-slate-800">{entryCount}</strong> documents
      </p>
    </button>
  );
}
