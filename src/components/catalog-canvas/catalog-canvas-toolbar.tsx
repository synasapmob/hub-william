import type { ReactNode } from "react";
import {
  Boxes,
  FileCode2,
  Plug,
  Terminal,
  type LucideIcon,
  GitPullRequest,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import {
  GITHUB_REPOSITORY_URL,
  groupLabel,
  rootLabel,
  type CatalogCategory,
  type CatalogGroup,
} from "@/services/catalog";
import { rootSlots } from "@/utils/utils.tone";

/** A glyph where one is known, and a shape where it is not. */
const rootIcons: Record<string, LucideIcon> = {
  harness: Boxes,
  skills: Sparkles,
  templates: FileCode2,
  installer: Terminal,
  mcp: Plug,
};

/** The tab reads its own root and its own state; the colour comes from the same
 *  table the root card uses, so a tab and its card cannot disagree. */
const groupFilterChip = tv({
  base: "rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "border-transparent bg-primary text-primary-foreground shadow-xs",
      false:
        "border-border bg-muted text-muted-foreground hover:bg-accent hover:text-foreground",
    },
  },
});

const categoryTab = tv({
  base: "flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono text-sm font-medium shadow-xs transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    expanded: {
      false:
        "border border-border bg-muted text-muted-foreground hover:bg-accent",
      true: "text-white",
    },
  },
});

interface CategoryTabProps {
  category: CatalogCategory;
  isExpanded: boolean;
  onSelect: () => void;
}

function CategoryTab({ category, isExpanded, onSelect }: CategoryTabProps) {
  const CategoryIcon = rootIcons[category] ?? Boxes;

  // The tab is a tab: its fill is the only thing that says which one is open,
  // so `aria-pressed` carries what nothing on screen states in words.
  return (
    <button
      type="button"
      aria-pressed={isExpanded}
      className={categoryTab({
        expanded: isExpanded,
        class: isExpanded ? rootSlots(category).tab() : undefined,
      })}
      onClick={onSelect}
    >
      <CategoryIcon aria-hidden="true" className="size-4" />
      {rootLabel(category)}
    </button>
  );
}

interface CatalogCanvasToolbarProps {
  /** What the search box says it searches, which differs per canvas. */
  searchPlaceholder: string;
  /**
   * Whatever this canvas puts beside "Contribute".
   *
   * A slot rather than a component, because the contributor switcher belongs to
   * the library and means nothing on a canvas of install guides.
   */
  menu?: ReactNode;
  documentCount: number;
  /** How many folders the catalogue on screen spans. */
  groupCount: number;
  expandedCategory: CatalogCategory | null;
  /** Folders of the open tree, in the order the tree draws them. */
  groups: CatalogGroup[];
  /** Which folder the open tree is filtered to, or null for every folder. */
  selectedGroup: CatalogGroup | null;
  /** The root cards this canvas draws, in order. */
  roots: CatalogCategory[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSelectCategory: (category: CatalogCategory) => void;
  onSelectGroup: (group: CatalogGroup | null) => void;
}

export default function CatalogCanvasToolbar({
  menu,
  searchPlaceholder,
  documentCount,
  groupCount,
  expandedCategory,
  groups,
  selectedGroup,
  roots,
  searchQuery,
  onSearchQueryChange,
  onSelectCategory,
  onSelectGroup,
}: CatalogCanvasToolbarProps) {
  // `data-canvas-overlay` is read by the canvas's own mousedown handler, which
  // must not start a pan when the pointer went down on the toolbar.
  return (
    <div
      data-canvas-overlay
      className="pointer-events-none absolute inset-x-5 top-5 z-30"
    >
      <div className="pointer-events-auto flex w-full flex-col gap-4 rounded-2xl border border-border bg-card/95 px-4 py-3.5 shadow-sm backdrop-blur-md lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />

            <Input
              type="search"
              value={searchQuery}
              aria-label="Search the catalogue"
              placeholder={searchPlaceholder}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              className="h-10 w-full rounded-xl bg-muted pr-8 pl-9 text-sm lg:w-120 [&::-webkit-search-cancel-button]:hidden"
            />

            {searchQuery ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onSearchQueryChange("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            ) : null}
          </div>

          <Flex className="items-center gap-2 flex-wrap">
            {roots.map((category: CatalogCategory) => (
              <CategoryTab
                key={category}
                category={category}
                isExpanded={expandedCategory === category}
                onSelect={() => onSelectCategory(category)}
              />
            ))}
          </Flex>

          {expandedCategory && groups.length > 0 ? (
            <Flex className="items-center gap-1.5 flex-wrap">
              <button
                type="button"
                aria-pressed={selectedGroup === null}
                className={groupFilterChip({ active: selectedGroup === null })}
                onClick={() => onSelectGroup(null)}
              >
                All
              </button>

              {groups.map((group) => (
                <button
                  type="button"
                  key={group}
                  aria-pressed={selectedGroup === group}
                  className={groupFilterChip({
                    active: selectedGroup === group,
                  })}
                  onClick={() => onSelectGroup(group)}
                >
                  {groupLabel(group)}
                </button>
              ))}
            </Flex>
          ) : null}
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          {/* Counted from the catalogue this page was built from, so it cannot
              disagree with what is drawn. Anything about repository activity —
              contributors, open pull requests — is not catalogue content and
              would need a GitHub API call and a CSP entry to be true, so no
              number here claims it. */}
          <p className="font-mono text-xs text-muted-foreground">
            <strong className="text-foreground">{documentCount}</strong>{" "}
            documents
            {" · "}
            <strong className="text-foreground">{groupCount}</strong> groups
          </p>

          <Flex className="items-center gap-2 flex-wrap">
            {menu}

            {/* Contribution is a pull request, so the control is a link to the
                repository rather than an upload the app would have to store. */}
            <a
              href={GITHUB_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-xl bg-primary px-3 py-2 font-mono text-sm font-medium text-primary-foreground shadow-xs transition-colors hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
            >
              <GitPullRequest aria-hidden="true" className="size-4" />
              Contribute
            </a>
          </Flex>
        </div>
      </div>
    </div>
  );
}
