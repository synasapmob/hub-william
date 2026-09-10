import WorkspaceShell from "@/components/workspace-shell";

/**
 * The workspace layout stays open. Its session provider only gates actions
 * that change account-bound state, beginning with requesting access to a shared
 * agent pool; browsing never redirects to a dedicated auth route.
 */
export default function AppLayoutRoute() {
  return <WorkspaceShell />;
}
