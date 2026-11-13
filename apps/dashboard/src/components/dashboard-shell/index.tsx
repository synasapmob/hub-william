import { Outlet } from "react-router";

import ProviderIcons from "@/components/provider-icons";
import Flex from "@/components/ui/flex";

import DashboardShellDesktop from "./dashboard-shell-desktop";
import DashboardShellMobile from "./dashboard-shell-mobile";

export default function DashboardShell() {
  return (
    <ProviderIcons>
      <Flex className="min-h-svh w-full bg-background text-foreground">
        <DashboardShellDesktop />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <DashboardShellMobile />

          <div className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </main>
      </Flex>
    </ProviderIcons>
  );
}
