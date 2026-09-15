import { useParams } from "react-router";

import CatalogCanvas from "@/components/catalog-canvas";
import CatalogCanvasMenu from "@/components/catalog-canvas/catalog-canvas-menu";

export default function LibraryRoute() {
  // `/library` reads the shared catalogue; `/library/synasapmob` reads that
  // workspace's own. Absent means shared, which is why the parameter is
  // optional rather than a second route with a duplicated canvas.
  const { contributor = null } = useParams();

  return (
    <CatalogCanvas
      section="library"
      contributor={contributor}
      searchPlaceholder={
        contributor
          ? `Search @${contributor}'s workspace...`
          : "Search collections and files..."
      }
      menu={<CatalogCanvasMenu contributor={contributor} section="library" />}
    />
  );
}
