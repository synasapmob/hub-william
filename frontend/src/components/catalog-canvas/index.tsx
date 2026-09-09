import { useState, useSyncExternalStore, type ReactNode } from "react";
import { useSearchParams } from "react-router";

import catalogService, {
  type CatalogCollection,
  type CatalogSection,
} from "@/services/catalog";

import CatalogCanvasCollectionCard from "./catalog-canvas-collection-card";
import CatalogCanvasCollectionDetail from "./catalog-canvas-collection-detail";
import CatalogCanvasToolbar from "./catalog-canvas-toolbar";

function subscribeToNothing() {
  return () => {};
}

const NODE_PARAM = "node";

interface CatalogCanvasProps {
  section: CatalogSection;
  contributor?: string | null;
  searchPlaceholder: string;
  menu?: ReactNode;
}

/** A flat collection catalogue: one node per functional domain, with no graph. */
export default function CatalogCanvas({
  section,
  contributor = null,
  searchPlaceholder,
  menu,
}: CatalogCanvasProps) {
  const collections = catalogService.collectionsInSection(section, contributor);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const selectedCollection = catalogService.findCollection(
    hydrated ? searchParams.get(NODE_PARAM) : null,
    section,
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
        Agent catalogue collections
      </h2>

      <CatalogCanvasToolbar
        collectionCount={collections.length}
        documentCount={catalogService.documentCount(section, contributor)}
        menu={menu}
        searchPlaceholder={searchPlaceholder}
        searchQuery={searchQuery}
        onSearchQueryChange={setSearchQuery}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-6 sm:py-8">
        {visibleCollections.length > 0 ? (
          <ul className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {visibleCollections.map((collection) => (
              <CatalogCanvasCollectionCard
                key={collection.id}
                collection={collection}
                onSelect={selectCollection}
              />
            ))}
          </ul>
        ) : (
          <div className="rounded-2xl border border-dashed border-slate-300 bg-card/80 px-6 py-16 text-center">
            <p className="text-sm font-medium text-zinc-800">
              No collection matches “{searchQuery}”.
            </p>

            <p className="mt-1 text-xs text-muted-foreground">
              Search checks collection names and every file inside them.
            </p>
          </div>
        )}
      </div>

      <CatalogCanvasCollectionDetail
        collection={selectedCollection}
        onOpenChange={(open) => {
          if (!open) selectCollection(null);
        }}
      />
    </section>
  );
}
