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
  rootLabel,
  type CatalogCategory,
  type CatalogSection,
} from "@/services/catalog";
import { rootSlots } from "@/utils/utils.tone";

import CatalogCanvasDownload from "./catalog-canvas-download";

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
const categoryTab = tv({
  base: "flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono text-sm font-medium shadow-xs transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    expanded: {
      false:
        "border border-slate-200/80 bg-slate-100 text-slate-700 hover:bg-slate-200",
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
  /**
   * Which catalogue the header is describing.
   *
   * Taking the catalogue away is not a slot like `menu` is: it means the same
   * thing on both canvases, so the toolbar renders it and only needs to be told
   * which one it is looking at.
   */
  section: CatalogSection;
  contributor: string | null;
  documentCount: number;
  /** How many folders the catalogue on screen spans. */
  groupCount: number;
  expandedCategory: CatalogCategory | null;
  /** The root cards this canvas draws, in order. */
  roots: CatalogCategory[];
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSelectCategory: (category: CatalogCategory) => void;
}

export default function CatalogCanvasToolbar({
  menu,
  section,
  contributor,
  searchPlaceholder,
  documentCount,
  groupCount,
  expandedCategory,
  roots,
  searchQuery,
  onSearchQueryChange,
  onSelectCategory,
}: CatalogCanvasToolbarProps) {
  // `data-canvas-overlay` is read by the canvas's own mousedown handler, which
  // must not start a pan when the pointer went down on the toolbar.
  return (
    <div
      data-canvas-overlay
      className="pointer-events-none absolute inset-x-5 top-5 z-30"
    >
      <div className="pointer-events-auto flex w-full flex-col gap-4 rounded-2xl border border-slate-200/90 bg-card/95 px-4 py-3.5 shadow-sm backdrop-blur-md lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3">
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            />

            <Input
              type="search"
              value={searchQuery}
              aria-label="Search the catalogue"
              placeholder={searchPlaceholder}
              onChange={(event) => onSearchQueryChange(event.target.value)}
              className="h-10 w-full rounded-xl bg-slate-50 pr-8 pl-9 text-sm lg:w-120"
            />

            {searchQuery ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => onSearchQueryChange("")}
                className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-0.5 text-slate-400 transition-colors hover:text-slate-600 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
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
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          {/* Counted from the catalogue this page was built from, so it cannot
              disagree with what is drawn. Anything about repository activity —
              contributors, open pull requests — is not catalogue content and
              would need a GitHub API call and a CSP entry to be true, so no
              number here claims it. */}
          <p className="font-mono text-xs text-muted-foreground">
            <strong className="text-zinc-800">{documentCount}</strong> documents
            {" · "}
            <strong className="text-zinc-800">{groupCount}</strong> groups
          </p>

          <Flex className="items-center gap-2 flex-wrap">
            <CatalogCanvasDownload
              section={section}
              contributor={contributor}
            />

            {menu}

            {/* Contribution is a pull request, so the control is a link to the
                repository rather than an upload the app would have to store. */}
            <a
              href={GITHUB_REPOSITORY_URL}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1.5 rounded-xl bg-zinc-900 px-3 py-2 font-mono text-sm font-medium text-white shadow-xs transition-colors hover:bg-zinc-800 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
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
