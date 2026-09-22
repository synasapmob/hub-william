import { Outlet, useMatch } from "react-router";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";

import WorkspaceShellDesktop from "./workspace-shell-desktop";
import WorkspaceShellMobile from "./workspace-shell-mobile";
import WorkspaceShellSession from "./workspace-shell-session";

const workspace = tv({
  base: "w-full bg-background text-foreground",
  variants: { contained: { true: "h-svh overflow-hidden" } },
});

/**
 * The agents explorer owns its scroll container, so its shell fills the viewport
 * and keeps the page actions and mobile header visible. Other routes retain the
 * regular main-content scrolling layout.
 */
export default function WorkspaceShell() {
  const contained = useMatch("/agents") !== null;

  return (
    <WorkspaceShellSession>
      <Flex className={workspace({ contained })}>
        <WorkspaceShellDesktop />

        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
          <WorkspaceShellMobile />

          <div className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
        </main>
      </Flex>
    </WorkspaceShellSession>
  );
}
