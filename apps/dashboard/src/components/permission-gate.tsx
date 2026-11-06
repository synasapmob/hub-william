import type { PropsWithChildren } from "react";
import { Lock } from "lucide-react";
import { Link } from "react-router";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import { navigationItems } from "@/components/dashboard-shell/dashboard-shell-navigation-items";
import PageBody from "@/components/page-body";
import Panel from "@/components/panel";
import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import { roleLabels } from "@/services/sales/sales-labels";
import type { Permission } from "@/services/sales/sales-types";

interface PermissionGateProps extends PropsWithChildren {
  permission: Permission;
}

/** Renders a page only for a role that may open it. */
export default function PermissionGate({
  children,
  permission,
}: PermissionGateProps) {
  const session = useDashboardSession();

  const home = navigationItems.find((item) => session.can(item.permission));

  if (!session.can(permission)) {
    return (
      <PageBody>
        <Panel>
          <Center className="flex-col gap-3 py-10 text-center">
            <Lock aria-hidden={true} className="size-6 text-muted-foreground" />

            <div className="space-y-1">
              <p className="font-medium">
                Trang này không dành cho vai trò của bạn
              </p>

              <p className="text-sm text-muted-foreground">
                {roleLabels[session.staff.role]} không có quyền mở trang này.
                Nhờ chủ shop cấp quyền nếu bạn cần.
              </p>
            </div>

            {home && (
              <Button asChild variant="outline">
                <Link to={home.href}>Về {home.label}</Link>
              </Button>
            )}
          </Center>
        </Panel>
      </PageBody>
    );
  }

  return children;
}
