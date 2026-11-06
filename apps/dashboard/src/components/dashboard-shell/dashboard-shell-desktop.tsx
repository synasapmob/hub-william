import DashboardShellSidebar from "./dashboard-shell-sidebar";

/** The sidebar that is always there, from `md` up. */
export default function DashboardShellDesktop() {
  return (
    <aside className="sticky top-0 hidden h-svh w-64 shrink-0 border-r border-zinc-200/80 bg-card md:flex md:flex-col">
      <DashboardShellSidebar />
    </aside>
  );
}
