import { Navigate } from "react-router";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import { navigationItems } from "@/components/dashboard-shell/dashboard-shell-navigation-items";

/** There is no home page: `/` opens the first page the signed-in role may use. */
export default function IndexRoute() {
  const session = useDashboardSession();

  const first = navigationItems.find((item) => session.can(item.permission));

  return <Navigate replace to={first?.href ?? "/pos"} />;
}
