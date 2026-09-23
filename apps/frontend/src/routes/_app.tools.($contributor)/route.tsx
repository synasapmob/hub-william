import { useParams } from "react-router";

import ToolsCatalog from "./tools-catalog";

export default function ToolsRoute() {
  const { contributor = null } = useParams();
  return <ToolsCatalog contributor={contributor} />;
}
