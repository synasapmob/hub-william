import { Fragment, useEffect, useRef, useState, type MouseEvent } from "react";
import { useParams, useSearchParams } from "react-router";

import catalogService, {
  CATEGORY_ORDER,
  type CatalogCategory,
  type CatalogEntry,
} from "@/services/catalog";

import {
  CANVAS_WORLD,
  categoryPositions,
  drawnBounds,
  treeGroups,
  type CanvasPosition,
  type TreeGroup,
} from "./canvas-geometry";
import CanvasControls from "./canvas-controls";
import CanvasToolbar from "./canvas-toolbar";
import CategoryRootCard from "./category-root-card";
import EntryCard from "./entry-card";
import EntryDetail from "./entry-detail";
import GroupHeading from "./group-heading";
import TreeBranches from "./tree-branches";

// The floor is low because "fit view" has to be able to reach it: a headed tree
// of six integrations is over three thousand canvas units tall, and a fit that
// clamps is a fit that lies.
const ZOOM_RANGE = { minimum: 0.15, maximum: 1.5 } as const;
const ZOOM_STEP = 0.15;
// The toolbar floats over the top of the canvas, so the default view starts
// below it rather than behind it. "Fit view" measures the toolbar instead; this
// is the one place a number has to stand in for that measurement, because it is
// the state the canvas mounts in.
const DEFAULT_VIEW = { pan: { x: 60, y: 95 }, zoom: 0.7 } as const;
/** Breathing room left around the tree when fitting it to the surface. */
const FIT_MARGIN = 24;

const TAB_PARAM = "tab";
const NODE_PARAM = "node";
/** What `?tab=` says when the reader closed the open tree on purpose. */
const CLOSED_TAB = "none";

/**
 * Where the artboard sits and how far in the reader is.
 *
 * The two are one fact, not two: zooming about a point moves the artboard as
 * well as scaling it, and holding them in separate state lets a render land
 * between the two updates with the canvas visibly lurching.
 */
interface CanvasViewport {
  pan: CanvasPosition;
  zoom: number;
}

function clampZoom(zoom: number) {
  return Math.min(Math.max(zoom, ZOOM_RANGE.minimum), ZOOM_RANGE.maximum);
}

/**
 * One wheel event's travel, in pixels.
 *
 * `deltaMode` is not always pixels — Firefox reports mouse wheels in lines —
 * so a handler that trusts `deltaY` directly makes the same gesture move the
 * canvas by two orders of magnitude less on one browser than another.
 */
function wheelDeltaPixels(delta: number, deltaMode: number) {
  if (deltaMode === WheelEvent.DOM_DELTA_LINE) return delta * 16;
  if (deltaMode === WheelEvent.DOM_DELTA_PAGE) return delta * 400;

  return delta;
}

/**
 * How much one wheel event should multiply the zoom by.
 *
 * A trackpad pinch arrives as a stream of small deltas and a mouse wheel as one
 * large notch, so the exponential keeps both at a comparable speed. The clamp
 * is what stops a single 120px notch — which the raw curve turns into ×1.9 —
 * from crossing the whole zoom range in one flick.
 */
function wheelZoomFactor(deltaPixels: number) {
  return Math.exp(-Math.max(-50, Math.min(50, deltaPixels)) / 250);
}

/**
 * Zoom about a fixed point, the way every canvas editor does it.
 *
 * With `transform-origin: 0 0` the screen position of a canvas point is
 * `pan + point * zoom`, so scaling on its own rakes everything toward the
 * artboard's top-left corner — which is exactly what makes a naive zoom feel
 * like it is fighting the pointer. Solving that relation for the pan that
 * leaves `anchor` over the same pixel gives the correction below. `anchor` is
 * in the surface's own coordinates, not the page's.
 */
function zoomAbout(
  viewport: CanvasViewport,
  nextZoom: number,
  anchor: CanvasPosition,
): CanvasViewport {
  const zoom = clampZoom(nextZoom);

  if (zoom === viewport.zoom) return viewport;

  return {
    zoom,
    pan: {
      x: anchor.x - ((anchor.x - viewport.pan.x) * zoom) / viewport.zoom,
      y: anchor.y - ((anchor.y - viewport.pan.y) * zoom) / viewport.zoom,
    },
  };
}

export default function LibraryRoute() {
  // `/library` reads the shared catalogue; `/library/synasapmob` reads that
  // workspace's own. Absent means shared, which is why the parameter is
  // optional rather than a second route with a duplicated canvas.
  const { contributor = null } = useParams();
  // The surface's own box: every pointer coordinate has to be measured against
  // it, because the canvas does not start at the top-left of the window.
  const surfaceRef = useRef<HTMLElement>(null);
  // Where the pointer grabbed the artboard, or null when nothing is being
  // dragged. Cards are fixed, so panning is the only drag there is.
  const [panGrab, setPanGrab] = useState<CanvasPosition | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_VIEW);
  const [searchParams, setSearchParams] = useSearchParams();
  // Every route is prerendered to static HTML, and a prerendered page has no
  // query string. Reading one during the first client render would therefore
  // disagree with the HTML that shipped, and React reports that as a hydration
  // failure on every shared link. So the URL is read from the render after
  // mount: a deep link shows the default tree for one frame, then its own.
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => setHydrated(true), []);

  // Which tree is open and which document is being read live in the URL rather
  // than in state, so a canvas can be linked to, bookmarked, walked back
  // through with the browser's own back button, and pasted to an agent that
  // will read the same page a person did.
  //
  // One tree at a time: four fans of branches over the same rows would leave a
  // reader unable to tell which trunk a card hangs from. An absent `tab` opens
  // Harnesses, because a first visit showing four cards and no tree explains
  // nothing; `tab=none` is how a deliberately closed canvas says so.
  const tabParam = hydrated ? searchParams.get(TAB_PARAM) : null;
  const expandedCategory: CatalogCategory | null =
    tabParam === CLOSED_TAB
      ? null
      : (catalogService.findCategory(tabParam) ?? "HARNESSES");
  const selectedEntry = catalogService.findBySlug(
    hydrated ? searchParams.get(NODE_PARAM) : null,
  );

  const { pan, zoom } = viewport;
  const groups: TreeGroup[] = expandedCategory
    ? treeGroups(
        catalogService.listEntriesByCategory(expandedCategory, contributor),
        (entry) => catalogService.matchesQuery(entry, searchQuery),
      )
    : [];

  /**
   * Figma's wheel contract: a plain wheel — or a two-finger trackpad scroll —
   * pans, and only a pinch or a held modifier zooms. Browsers report a trackpad
   * pinch as a wheel event with `ctrlKey` set, which is why one branch serves
   * both gestures.
   *
   * It is a native listener rather than `onWheel` because React registers wheel
   * passively, and a passive listener cannot call `preventDefault` — without
   * which a pinch zooms the whole browser page instead of the canvas.
   */
  useEffect(() => {
    const surface = surfaceRef.current;

    if (!surface) return;

    function handleWheel(event: globalThis.WheelEvent) {
      event.preventDefault();

      const deltaY = wheelDeltaPixels(event.deltaY, event.deltaMode);

      if (!event.ctrlKey && !event.metaKey) {
        const deltaX = wheelDeltaPixels(event.deltaX, event.deltaMode);

        setViewport((previous) => ({
          ...previous,
          pan: { x: previous.pan.x - deltaX, y: previous.pan.y - deltaY },
        }));

        return;
      }

      const bounds = surface?.getBoundingClientRect();
      const anchor = {
        x: event.clientX - (bounds?.left ?? 0),
        y: event.clientY - (bounds?.top ?? 0),
      };

      setViewport((previous) =>
        zoomAbout(previous, previous.zoom * wheelZoomFactor(deltaY), anchor),
      );
    }

    surface.addEventListener("wheel", handleWheel, { passive: false });

    return () => surface.removeEventListener("wheel", handleWheel);
  }, []);

  /** The middle of the visible canvas — what the toolbar's own zoom holds still. */
  function viewportCentre(): CanvasPosition {
    const bounds = surfaceRef.current?.getBoundingClientRect();

    return { x: (bounds?.width ?? 0) / 2, y: (bounds?.height ?? 0) / 2 };
  }

  /**
   * Frame everything currently drawn.
   *
   * Measured rather than pinned to a remembered pan and zoom: the tree is a
   * different size with each category open, the toolbar floating over the top
   * of the canvas is twice as tall once it wraps on a phone, and a fit that was
   * right on a laptop puts half the tree off the side of a narrow window.
   */
  function fitView() {
    const surface = surfaceRef.current;

    if (!surface) return;

    const overlay = surface.querySelector("[data-canvas-overlay]");
    const topInset = (overlay?.getBoundingClientRect().height ?? 0) + 40;
    const box = drawnBounds(groups);
    const width = box.maxX - box.minX;
    const height = box.maxY - box.minY;
    const nextZoom = clampZoom(
      Math.min(
        (surface.clientWidth - FIT_MARGIN * 2) / width,
        (surface.clientHeight - topInset - FIT_MARGIN) / height,
      ),
    );

    setViewport({
      zoom: nextZoom,
      pan: {
        x: (surface.clientWidth - width * nextZoom) / 2 - box.minX * nextZoom,
        y: topInset - box.minY * nextZoom,
      },
    });
  }

  function handleCanvasMouseDown(event: MouseEvent<HTMLElement>) {
    // Cards, controls and the toolbar handle their own pointers. Without this
    // the whole artboard would slide the moment someone reached for a button.
    if (
      (event.target as HTMLElement).closest(
        "[data-canvas-overlay], a, button, input",
      )
    ) {
      return;
    }

    setPanGrab({ x: event.clientX - pan.x, y: event.clientY - pan.y });
  }

  function handleMouseMove(event: MouseEvent<HTMLElement>) {
    if (!panGrab) return;

    setViewport((previous) => ({
      ...previous,
      pan: { x: event.clientX - panGrab.x, y: event.clientY - panGrab.y },
    }));
  }

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

    const hit = CATEGORY_ORDER.find((category) =>
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
      ref={surfaceRef}
      aria-labelledby="library-title"
      className="canvas-grid-dots relative min-h-0 flex-1 cursor-default overflow-hidden bg-slate-50 select-none"
      onMouseDown={handleCanvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={() => setPanGrab(null)}
      onMouseLeave={() => setPanGrab(null)}
    >
      <h2 id="library-title" className="sr-only">
        Agent catalogue canvas
      </h2>

      <CanvasToolbar
        areaCount={catalogService.areaCount(contributor)}
        contributor={contributor}
        documentCount={catalogService.documentCount(contributor)}
        expandedCategory={expandedCategory}
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
            <TreeBranches category={expandedCategory} groups={groups} />
          ) : null}
        </svg>

        {CATEGORY_ORDER.map((category) => (
          <CategoryRootCard
            key={category}
            areas={catalogService.areasInCategory(category, contributor)}
            category={category}
            entryCount={
              catalogService.listEntriesByCategory(category, contributor).length
            }
            isDimmed={
              expandedCategory !== null && expandedCategory !== category
            }
            isExpanded={expandedCategory === category}
            position={categoryPositions[category]}
            onSelect={() => selectCategory(category)}
          />
        ))}

        {groups.map((group) => (
          <Fragment key={group.area}>
            <GroupHeading
              area={group.area}
              size={group.size}
              top={group.headingY}
            />

            {group.rows.map((row) =>
              row.placed.map((placed) => (
                <EntryCard
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
        ))}
      </div>

      <CanvasControls
        zoom={zoom}
        onFitView={fitView}
        onResetView={() => setViewport(DEFAULT_VIEW)}
        onZoomIn={() =>
          setViewport((previous) =>
            zoomAbout(previous, previous.zoom + ZOOM_STEP, viewportCentre()),
          )
        }
        onZoomOut={() =>
          setViewport((previous) =>
            zoomAbout(previous, previous.zoom - ZOOM_STEP, viewportCentre()),
          )
        }
      />

      <EntryDetail
        entry={selectedEntry}
        onOpenChange={(open) => {
          if (!open) selectEntry(null);
        }}
      />
    </section>
  );
}
