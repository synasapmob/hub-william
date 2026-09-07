import WorkspaceShellSidebar from "./workspace-shell-sidebar";

/**
 * The sidebar that is always there, from `md` up.
 *
 * It is its own file because it is a different container, not a different
 * sidebar: everything inside it is shared with the drawer, and only the box
 * around it — pinned, fixed width, its own scroll — belongs to this breakpoint.
 */
export default function WorkspaceShellDesktop() {
  return (
    <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r border-border bg-card md:flex md:flex-col">
      <WorkspaceShellSidebar />
    </aside>
  );
}
