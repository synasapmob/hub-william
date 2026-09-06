import {
  Fragment,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useSearchParams } from "react-router";

import catalogService, {
  type CatalogCategory,
  type CatalogEntry,
  type CatalogSection,
} from "@/services/catalog";

import {
  CANVAS_WORLD,
  drawnBounds,
  rootPositions,
  treeGroups,
  type TreeGroup,
} from "./catalog-canvas-geometry";
import CatalogCanvasControls from "./catalog-canvas-controls";
import CatalogCanvasToolbar from "./catalog-canvas-toolbar";
import CatalogCanvasRootCard from "./catalog-canvas-root-card";
import CatalogCanvasEntryCard from "./catalog-canvas-entry-card";
import CatalogCanvasEntryDetail from "./catalog-canvas-entry-detail";
import CatalogCanvasGroupHeading from "./catalog-canvas-group-heading";
import CatalogCanvasTreeBranches from "./catalog-canvas-tree-branches";
import { useCatalogCanvasViewport } from "./catalog-canvas-viewport";

/** Hydration never changes after it happens, so there is nothing to subscribe to. */
function subscribeToNothing() {
  return () => {};
}

const TAB_PARAM = "tab";
const NODE_PARAM = "node";
/** What `?tab=` says when the reader closed the open tree on purpose. */
const CLOSED_TAB = "none";

interface CatalogCanvasProps {
  /** Which canvas this is: the catalogue itself, or how to install it. */
  section: CatalogSection;
  /** Whose catalogue is being read, or null for the shared one. */
  contributor?: string | null;
  /** What the search box says it searches. */
  searchPlaceholder: string;
  /** Anything this canvas wants beside "Contribute". */
  menu?: ReactNode;
}

/**
 * One artboard, whatever it is drawing.
 *
 * `/library` and `/tools` are the same picture over different folders — roots
 * in a row, one open tree, a headed block per folder — so they are one
 * component taking a section rather than two that drift apart. What differs is
 * passed in: which section, whose catalogue, and what sits in the toolbar.
 */
export default function CatalogCanvas({
  section,
  contributor = null,
  searchPlaceholder,
  menu,
}: CatalogCanvasProps) {
  const roots = catalogService.rootsInSection(section, contributor);
  const positions = rootPositions(roots);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchParams, setSearchParams] = useSearchParams();
  // Panning, zooming and the surface's own measurements. None of that is about
  // the catalogue, so none of it is in here.
  const { pan, zoom, surface, fitView, resetView, zoomIn, zoomOut } =
    useCatalogCanvasViewport();
  // Every route is prerendered to static HTML, and a prerendered page has no
  // query string. Reading one during the first client render would therefore
  // disagree with the HTML that shipped, and React reports that as a hydration
  // failure on every shared link. So the URL is read from the render after
  // mount: a deep link shows the default tree for one frame, then its own.
  // `useSyncExternalStore` rather than an effect that sets state: its server
  // snapshot is what the prerendered HTML sees and its client snapshot is what
  // the browser sees, which is exactly the question being asked. An effect
  // would answer the same way and cost a second render to do it.
  const hydrated = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

  // Which tree is open and which document is being read live in the URL rather
  // than in state, so a canvas can be linked to, bookmarked, walked back
  // through with the browser's own back button, and pasted to an agent that
  // will read the same page a person did.
  //
  // One tree at a time: several fans of branches over the same rows would leave
  // a reader unable to tell which trunk a card hangs from. An unknown or absent
  // `tab` opens Harnesses, because a first visit showing bare roots and no tree
  // explains nothing; `tab=none` is how a deliberately closed canvas says so.
  const tabParam = hydrated ? searchParams.get(TAB_PARAM) : null;
  const expandedCategory: CatalogCategory | null =
    tabParam === CLOSED_TAB
      ? null
      : (catalogService.findCategory(tabParam, section, contributor) ??
        roots[0] ??
        null);
  const selectedEntry = catalogService.findBySlug(
    hydrated ? searchParams.get(NODE_PARAM) : null,
  );

  const groups: TreeGroup[] = expandedCategory
    ? treeGroups(
        catalogService.listEntriesByCategory(expandedCategory, contributor),
        catalogService.groupsInCategory(expandedCategory, contributor),
        (entry) => catalogService.matchesQuery(entry, searchQuery),
      )
    : [];

  /**
   * Searching opens the tree that holds the hits.
   *
   * A query matching three contracts inside a closed root would otherwise read
   * as no results at all. Whatever is already open stays open, because only one
   * tree can be out and a query is a weaker signal than a deliberate click.
   */
  function handleSearchQueryChange(query: string) {
    setSearchQuery(query);

    if (!query.trim() || expandedCategory) return;

    const hit = roots.find((category) =>
      catalogService
        .listEntriesByCategory(category, contributor)
        .some((entry) => catalogService.matchesQuery(entry, query)),
    );

    if (hit) selectCategory(hit);
  }

  /**
   * Selecting a category swaps the open tree rather than queuing behind an undo.
   *
   * Clicking the tree that is already out closes it; clicking another one takes
   * over. Comparing two groups is the whole point of the canvas, and making
   * that cost two clicks would be felt on every comparison.
   */
  function selectCategory(category: CatalogCategory) {
    const next = new URLSearchParams(searchParams);

    next.set(
      TAB_PARAM,
      expandedCategory === category ? CLOSED_TAB : category.toLowerCase(),
    );
    // A document in one tree is not a document in another, so switching trees
    // clears whatever was open rather than leaving a `node` the canvas no
    // longer draws.
    next.delete(NODE_PARAM);
    setSearchParams(next);
  }

  function selectEntry(entry: CatalogEntry | null) {
    const next = new URLSearchParams(searchParams);

    if (entry) {
      next.set(NODE_PARAM, entry.slug);
    } else {
      next.delete(NODE_PARAM);
    }

    setSearchParams(next);
  }

  return (
    <section
      {...surface}
      aria-labelledby="library-title"
      className="canvas-grid-dots relative min-h-0 flex-1 cursor-default overflow-hidden bg-slate-50 select-none"
    >
      <h2 id="library-title" className="sr-only">
        Agent catalogue canvas
      </h2>

      <CatalogCanvasToolbar
        groupCount={catalogService.groupCount(section, contributor)}
        menu={menu}
        searchPlaceholder={searchPlaceholder}
        documentCount={catalogService.documentCount(section, contributor)}
        expandedCategory={expandedCategory}
        roots={roots}
        searchQuery={searchQuery}
        onSearchQueryChange={handleSearchQueryChange}
        onSelectCategory={selectCategory}
      />

      <div
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${zoom})`,
          transformOrigin: "0 0",
          width: `${CANVAS_WORLD.width}px`,
          height: `${CANVAS_WORLD.height}px`,
        }}
        className="absolute top-0 left-0"
      >
        <svg
          aria-hidden="true"
          width={CANVAS_WORLD.width}
          height={CANVAS_WORLD.height}
          className="pointer-events-none absolute top-0 left-0"
        >
          {expandedCategory ? (
            <CatalogCanvasTreeBranches
              groups={groups}
              root={expandedCategory}
              rootPosition={positions[expandedCategory]}
            />
          ) : null}
        </svg>

        {roots.map((category) => (
          <CatalogCanvasRootCard
            key={category}
            groups={catalogService.groupsInCategory(category, contributor)}
            category={category}
            entryCount={
              catalogService.listEntriesByCategory(category, contributor).length
            }
            isDimmed={
              expandedCategory !== null && expandedCategory !== category
            }
            isExpanded={expandedCategory === category}
            position={positions[category]}
            onSelect={() => selectCategory(category)}
          />
        ))}

        {/* `groups` is empty unless a root is open, so the guard draws nothing
            the map would not have. It is here to say the open root out loud:
            every heading and card below is coloured by the tree it hangs in,
            and that tree is this one. */}
        {expandedCategory
          ? groups.map((group) => (
              <Fragment key={group.group}>
                <CatalogCanvasGroupHeading
                  group={group.group}
                  root={expandedCategory}
                  size={group.size}
                  top={group.headingY}
                />

                {group.rows.map((row) =>
                  row.placed.map((placed) => (
                    <CatalogCanvasEntryCard
                      key={placed.entry.id}
                      entry={placed.entry}
                      isDimmed={!placed.isMatch}
                      isSelected={selectedEntry?.id === placed.entry.id}
                      position={placed.position}
                      onSelect={selectEntry}
                    />
                  )),
                )}
              </Fragment>
            ))
          : null}
      </div>

      <CatalogCanvasControls
        zoom={zoom}
        onFitView={() => fitView(drawnBounds(groups, positions))}
        onResetView={resetView}
        onZoomIn={zoomIn}
        onZoomOut={zoomOut}
      />

      <CatalogCanvasEntryDetail
        entry={selectedEntry}
        contributor={contributor}
        onOpenChange={(open) => {
          if (!open) selectEntry(null);
        }}
      />
    </section>
  );
}
