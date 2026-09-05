import {
  Boxes,
  ArrowLeft,
  FileCode2,
  GitFork,
  GitPullRequest,
  Search,
  Sparkles,
  X,
} from "lucide-react";
import { Link } from "react-router";
import { tv } from "tailwind-variants";

import Flex from "@/components/flex";
import { Input } from "@/components/ui/input";
import {
  CATEGORY_ORDER,
  GITHUB_REPOSITORY_URL,
  type CatalogCategory,
} from "@/services/catalog";

/** The tab reads its own category and its own state; one table, no slots needed. */
const categoryTab = tv({
  base: "flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono text-sm font-medium shadow-xs transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    category: {
      HARNESSES: "",
      SKILLS: "",
      HOOKS: "",
      TEMPLATES: "",
    },
    expanded: {
      false:
        "border border-slate-200/80 bg-slate-100 text-slate-700 hover:bg-slate-200",
      true: "text-white",
    },
  },
  compoundVariants: [
    {
      category: "HARNESSES",
      expanded: true,
      class: "bg-indigo-600 hover:bg-indigo-700",
    },
    {
      category: "SKILLS",
      expanded: true,
      class: "bg-violet-600 hover:bg-violet-700",
    },
    {
      category: "HOOKS",
      expanded: true,
      class: "bg-amber-600 hover:bg-amber-700",
    },
    {
      category: "TEMPLATES",
      expanded: true,
      class: "bg-sky-600 hover:bg-sky-700",
    },
  ],
});

const categoryIcons = {
  HARNESSES: Boxes,
  SKILLS: Sparkles,
  HOOKS: GitFork,
  TEMPLATES: FileCode2,
} as const;

const categoryLabels = {
  HARNESSES: "Harnesses",
  SKILLS: "Skills",
  HOOKS: "Hooks",
  TEMPLATES: "Templates",
} as const;

interface CategoryTabProps {
  category: CatalogCategory;
  isExpanded: boolean;
  onSelect: () => void;
}

function CategoryTab({ category, isExpanded, onSelect }: CategoryTabProps) {
  const CategoryIcon = categoryIcons[category];

  // The tab is a tab: its fill is the only thing that says which one is open,
  // so `aria-pressed` carries what nothing on screen states in words.
  return (
    <button
      type="button"
      aria-pressed={isExpanded}
      className={categoryTab({ category, expanded: isExpanded })}
      onClick={onSelect}
    >
      <CategoryIcon aria-hidden="true" className="size-4" />
      {categoryLabels[category]}
    </button>
  );
}

interface CanvasToolbarProps {
  areaCount: number;
  /** Whose catalogue is on screen, or null for the shared one. */
  contributor: string | null;
  documentCount: number;
  expandedCategory: CatalogCategory | null;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  onSelectCategory: (category: CatalogCategory) => void;
}

export default function CanvasToolbar({
  areaCount,
  contributor,
  documentCount,
  expandedCategory,
  searchQuery,
  onSearchQueryChange,
  onSelectCategory,
}: CanvasToolbarProps) {
  // `data-canvas-overlay` is read by the canvas's own mousedown handler, which
  // must not start a pan when the pointer went down on the toolbar.
  return (
    <div
      data-canvas-overlay
      className="pointer-events-none absolute inset-x-5 top-5 z-30"
    >
      <div className="pointer-events-auto flex w-full flex-col gap-4 rounded-2xl border border-slate-200/90 bg-card/95 px-4 py-3.5 shadow-sm backdrop-blur-md lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-col gap-3">
          {/* A contributor's catalogue says whose it is and offers the way back;
              the shared one needs neither, so it shows neither. */}
          {contributor ? (
            <Flex gap="sm" wrap>
              <Link
                to="/library"
                className="flex items-center gap-1.5 rounded-lg border border-border bg-slate-50 px-2.5 py-1 font-mono text-[11px] text-zinc-700 transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              >
                <ArrowLeft aria-hidden="true" className="size-3.5" />
                Shared catalogue
              </Link>

              <p className="font-mono text-sm font-semibold">
                <span className="text-muted-foreground">@</span>
                {contributor}
              </p>
            </Flex>
          ) : null}

          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400"
            />

            <Input
              type="search"
              value={searchQuery}
              aria-label="Search the catalogue"
              placeholder={
                contributor
                  ? `Search @${contributor}'s workspace...`
                  : "Search harnesses, skills, hooks and templates..."
              }
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

          <Flex gap="sm" wrap>
            {CATEGORY_ORDER.map((category) => (
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
            <strong className="text-zinc-800">{areaCount}</strong> integrations
          </p>

          <Flex gap="sm" wrap>
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
