import { Maximize2, Minus, Plus } from "lucide-react";

import Flex from "@/components/ui/flex";
import { Separator } from "@/components/ui/separator";

const CONTROL_CLASS =
  "rounded-xl p-2 text-muted-foreground transition-colors hover:bg-slate-100 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden";

interface CatalogCanvasControlsProps {
  zoom: number;
  onFitView: () => void;
  onResetView: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
}

export default function CatalogCanvasControls({
  zoom,
  onFitView,
  onResetView,
  onZoomIn,
  onZoomOut,
}: CatalogCanvasControlsProps) {
  return (
    <Flex
      data-canvas-overlay
      className="items-center absolute bottom-6 left-6 z-20 gap-1.5 rounded-2xl border border-slate-200/90 bg-card/95 p-1.5 shadow-sm backdrop-blur-md"
    >
      <button
        type="button"
        aria-label="Zoom in"
        className={CONTROL_CLASS}
        onClick={onZoomIn}
      >
        <Plus aria-hidden="true" className="size-4" />
      </button>

      <button
        type="button"
        aria-label="Zoom out"
        className={CONTROL_CLASS}
        onClick={onZoomOut}
      >
        <Minus aria-hidden="true" className="size-4" />
      </button>

      <Separator orientation="vertical" className="mx-1 h-4" />

      <button
        type="button"
        aria-label="Reset zoom"
        onClick={onResetView}
        className="rounded-xl px-2.5 py-1 font-mono text-sm text-zinc-700 transition-colors hover:bg-slate-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
      >
        {Math.round(zoom * 100)}%
      </button>

      <button
        type="button"
        aria-label="Fit view"
        className={CONTROL_CLASS}
        onClick={onFitView}
      >
        <Maximize2 aria-hidden="true" className="size-4" />
      </button>
    </Flex>
  );
}
