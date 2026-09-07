import { useEffect, useRef, useState, type MouseEvent, type Ref } from "react";

import type { CanvasBounds, CanvasPosition } from "./catalog-canvas-geometry";

// The floor is low because "fit view" has to be able to reach it: a headed tree
// of six groups is over three thousand canvas units tall, and a fit that clamps
// is a fit that lies.
const ZOOM_RANGE = { minimum: 0.15, maximum: 1.5 } as const;
const ZOOM_STEP = 0.15;
// The toolbar floats over the top of the canvas, so the default view starts
// below it rather than behind it. "Fit view" measures the toolbar instead; this
// is the one place a number has to stand in for that measurement, because it is
// the state the canvas mounts in.
const DEFAULT_VIEW = { pan: { x: 60, y: 95 }, zoom: 0.7 } as const;
/** Breathing room left around the tree when fitting it to the surface. */
const FIT_MARGIN = 24;

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
 * With `transform-origin: 0` the screen position of a canvas point is
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

/**
 * Everything the scrolling surface has to be handed, as one object.
 *
 * A bundle rather than four returned handlers because the set is the contract:
 * drop `onMouseLeave` and the artboard keeps following a pointer that already
 * left the canvas, which is a bug you only find by dragging out of the window.
 * Spreading it makes forgetting one impossible.
 */
export interface CatalogCanvasSurfaceProps {
  ref: Ref<HTMLElement>;
  onMouseDown: (event: MouseEvent<HTMLElement>) => void;
  onMouseMove: (event: MouseEvent<HTMLElement>) => void;
  onMouseUp: () => void;
  onMouseLeave: () => void;
}

export interface CatalogCanvasViewportControls {
  pan: CanvasPosition;
  zoom: number;
  surface: CatalogCanvasSurfaceProps;
  /** Frame a box of canvas units against the surface as it is measured now. */
  fitView: (box: CanvasBounds) => void;
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface UseCatalogCanvasViewportOptions {
  /** Whether a modal surface currently owns pointer and wheel interaction. */
  locked: boolean;
}

/**
 * Pan and zoom for a fixed artboard, on Figma's contract.
 *
 * A plain wheel — or a two-finger trackpad scroll — pans, and only a pinch or a
 * held modifier zooms. Cards are fixed, so dragging the surface is the only
 * drag there is.
 *
 * It lives here rather than in the route because none of it is about the
 * catalogue: the route decides which tree is open and what a card links to, and
 * this decides where the artboard sits. The one place the two meet is
 * `fitView`, which takes the box to frame as an argument rather than reaching
 * for the entries itself.
 */
export function useCatalogCanvasViewport({
  locked,
}: UseCatalogCanvasViewportOptions): CatalogCanvasViewportControls {
  // The surface's own box: every pointer coordinate has to be measured against
  // it, because the canvas does not start at the top-left of the window.
  const surfaceRef = useRef<HTMLElement>(null);
  // Where the pointer grabbed the artboard, or null when nothing is being
  // dragged.
  const panGrabRef = useRef<CanvasPosition | null>(null);
  const [viewport, setViewport] = useState<CanvasViewport>(DEFAULT_VIEW);
  const lockedRef = useRef(locked);

  useEffect(() => {
    lockedRef.current = locked;
    if (locked) panGrabRef.current = null;
  }, [locked]);

  /**
   * The wheel is a native listener rather than `onWheel` because React
   * registers wheel passively, and a passive listener cannot call
   * `preventDefault` — without which a pinch zooms the whole browser page
   * instead of the canvas.
   *
   * Browsers report a trackpad pinch as a wheel event with `ctrlKey` set, which
   * is why one branch serves both gestures.
   */
  useEffect(() => {
    const surface = surfaceRef.current;

    if (!surface) return;

    function handleWheel(event: globalThis.WheelEvent) {
      if (lockedRef.current) return;

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
   * Frame a box of canvas units.
   *
   * Measured rather than pinned to a remembered pan and zoom: the tree is a
   * different size with each category open, the toolbar floating over the top
   * of the canvas is twice as tall once it wraps on a phone, and a fit that was
   * right on a laptop puts half the tree off the side of a narrow window.
   */
  function fitView(box: CanvasBounds) {
    const surface = surfaceRef.current;

    if (!surface) return;

    const overlay = surface.querySelector("[data-canvas-overlay]");
    const topInset = (overlay?.getBoundingClientRect().height ?? 0) + 40;
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

  function handleMouseDown(event: MouseEvent<HTMLElement>) {
    if (locked) return;

    // Cards, controls and the toolbar handle their own pointers. Without this
    // the whole artboard would slide the moment someone reached for a button.
    if (
      (event.target as HTMLElement).closest(
        "[data-canvas-overlay], a, button, input",
      )
    ) {
      return;
    }

    panGrabRef.current = {
      x: event.clientX - viewport.pan.x,
      y: event.clientY - viewport.pan.y,
    };
  }

  function handleMouseMove(event: MouseEvent<HTMLElement>) {
    const panGrab = panGrabRef.current;

    if (locked || !panGrab) return;

    setViewport((previous) => ({
      ...previous,
      pan: { x: event.clientX - panGrab.x, y: event.clientY - panGrab.y },
    }));
  }

  function releaseGrab() {
    panGrabRef.current = null;
  }

  return {
    pan: viewport.pan,
    zoom: viewport.zoom,
    surface: {
      ref: surfaceRef,
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: releaseGrab,
      onMouseLeave: releaseGrab,
    },
    fitView,
    resetView: () => setViewport(DEFAULT_VIEW),
    zoomIn: () =>
      setViewport((previous) =>
        zoomAbout(previous, previous.zoom + ZOOM_STEP, viewportCentre()),
      ),
    zoomOut: () =>
      setViewport((previous) =>
        zoomAbout(previous, previous.zoom - ZOOM_STEP, viewportCentre()),
      ),
  };
}
