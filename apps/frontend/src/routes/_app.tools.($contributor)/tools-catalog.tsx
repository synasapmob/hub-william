import { useState, useSyncExternalStore } from "react";
import { useSearchParams } from "react-router";

import catalogService, { type CatalogCollection } from "@/services/catalog";

import ToolsCatalogCollectionCard from "./tools-catalog-collection-card";
import ToolsCatalogCollectionDetail from "./tools-catalog-collection-detail";
import ToolsCatalogToolbar from "./tools-catalog-toolbar";

function subscribeToNothing() {
  return () => {};
}

const NODE_PARAM = "node";

interface ToolsCatalogProps {
  contributor?: string | null;
}

/** Shared and contributed tools keep their existing catalogue workflow. */
export default function ToolsCatalog({
  contributor = null,
}: ToolsCatalogProps) {
  const collections = catalogService.collections(contributor);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const selectedCollection = catalogService.findCollection(
    hydrated ? searchParams.get(NODE_PARAM) : null,
    contributor,
  );
  const visibleCollections = collections.filter((collection) =>
    catalogService.matchesCollectionQuery(collection, searchQuery),
  );

  function selectCollection(collection: CatalogCollection | null) {
    const next = new URLSearchParams(searchParams);

    if (collection) {
      next.set(NODE_PARAM, collection.id);
    } else {
      next.delete(NODE_PARAM);
    }

    setSearchParams(next);
  }

  return (
    <section
      aria-labelledby="catalog-title"
      className="canvas-grid-dots flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-50"
    >
      <h2 id="catalog-title" className="sr-only">
        Tools
      </h2>

      <ToolsCatalogToolbar
        contributor={contributor}
        documentCount={catalogService.documentCount(contributor)}
        collectionCount={collections.length}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6 sm:py-8">
        {visibleCollections.length > 0 ? (
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleCollections.map((collection) => (
              <ToolsCatalogCollectionCard
                key={collection.id}
                collection={collection}
                onSelect={selectCollection}
              />
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-card/80 px-6 py-16 text-center">
            <p className="text-sm font-medium text-zinc-800">
              No tool matches “{searchQuery}”.
            </p>

            <p className="mt-1 text-xs text-muted-foreground">
              Search checks tool names and their documentation.
            </p>
          </div>
        )}
      </div>

      <ToolsCatalogCollectionDetail
        collection={selectedCollection}
        onOpenChange={(open) => {
          if (!open) selectCollection(null);
        }}
      />
    </section>
  );
}
