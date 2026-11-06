import DashboardShell from "@/components/dashboard-shell";
import DashboardSessionGate from "@/components/dashboard-shell/dashboard-session-gate";

export default function AppLayoutRoute() {
  return (
    <DashboardSessionGate>
      <DashboardShell />
    </DashboardSessionGate>
  );
}
