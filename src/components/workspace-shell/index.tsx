import { Outlet } from "react-router";

import WorkspaceShellDesktop from "./workspace-shell-desktop";
import WorkspaceShellMobile from "./workspace-shell-mobile";

/**
 * The frame every page under `_app` renders inside.
 *
 * The two containers are split by where they render rather than by size: the
 * aside and the drawer show the same sidebar, and keeping the breakpoint in one
 * file each is what stops a change landing on one and not the other. The scroll
 * lives on `main` alone — the shell is exactly the viewport, so a sticky mobile
 * header and a pinned sidebar have something fixed to sit against.
 */
export default function WorkspaceShell() {
  return (
    <div className="flex h-svh w-full overflow-hidden bg-background text-foreground">
      <WorkspaceShellDesktop />

      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">
        <WorkspaceShellMobile />

        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
