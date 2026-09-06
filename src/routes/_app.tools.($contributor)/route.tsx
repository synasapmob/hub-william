import { useParams } from "react-router";

import CatalogCanvas from "@/components/catalog-canvas";
import CatalogCanvasMenu from "@/components/catalog-canvas/catalog-canvas-menu";

/**
 * How to get the catalogue onto a machine.
 *
 * A separate canvas from `/library` rather than a fourth root on it: a reader
 * who wants to install has no use for twenty-five contracts, and a reader
 * comparing contracts has no use for install steps. Same component, same
 * contribution path — `contrib/<login>/tools/` publishes at `/tools/<login>`
 * exactly as the library's does.
 */
export default function ToolsRoute() {
  const { contributor = null } = useParams();

  return (
    <CatalogCanvas
      section="tools"
      contributor={contributor}
      searchPlaceholder={
        contributor
          ? `Search @${contributor}'s tools...`
          : "Search install steps and requirements..."
      }
      menu={<CatalogCanvasMenu contributor={contributor} section="tools" />}
    />
  );
}
