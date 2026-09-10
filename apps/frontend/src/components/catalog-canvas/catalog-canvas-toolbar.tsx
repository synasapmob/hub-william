import type { ReactNode } from "react";
import { GitPullRequest, Search, X } from "lucide-react";

import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { GITHUB_REPOSITORY_URL } from "@/services/catalog";

interface CatalogCanvasToolbarProps {
  searchPlaceholder: string;
  menu?: ReactNode;
  documentCount: number;
  collectionCount: number;
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
}

/** Search and catalogue-wide actions, without duplicating collection nodes. */
export default function CatalogCanvasToolbar({
  menu,
  searchPlaceholder,
  documentCount,
  collectionCount,
  searchQuery,
  onSearchQueryChange,
}: CatalogCanvasToolbarProps) {
  return (
    <header className="border-b border-slate-200/80 bg-card/95 px-5 py-4 backdrop-blur-md">
      <Flex className="w-full flex-col items-stretch gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="lg:max-w-120 w-full space-y-3">
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
              className="h-10 w-full rounded-xl bg-slate-50 pr-8 pl-9 text-sm cancelbut"
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

          <p className="font-mono text-xs text-muted-foreground">
            <strong className="text-zinc-800">{documentCount}</strong> documents
            {" · "}
            <strong className="text-zinc-800">{collectionCount}</strong>{" "}
            collections
          </p>
        </div>

        <Flex className="items-center gap-2 flex-wrap">
          {menu}

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
      </Flex>
    </header>
  );
}
