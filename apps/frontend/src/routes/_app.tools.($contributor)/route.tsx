import { useParams } from "react-router";

import CatalogCanvas from "@/components/catalog-canvas";
import CatalogCanvasMenu from "@/components/catalog-canvas/catalog-canvas-menu";

/**
 * How to get the catalogue onto a machine.
 *
 * A separate collection view from `/library`: a reader installing Documents
 * CLIs or MCP servers should not have to walk the contract catalogue to get there.
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
          : "Search tools and installers..."
      }
      menu={<CatalogCanvasMenu contributor={contributor} section="tools" />}
    />
  );
}
