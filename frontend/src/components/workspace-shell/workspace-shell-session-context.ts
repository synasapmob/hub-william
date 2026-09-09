import { createContext, useContext } from "react";

import type { AuthenticatedUser } from "@/services/auth";

export type WorkspaceSessionStatus = "authenticated" | "guest" | "loading";

export interface WorkspaceSessionContextValue {
  openAuth: () => void;
  signOut: () => Promise<void>;
  status: WorkspaceSessionStatus;
  user: AuthenticatedUser | null;
}

const WorkspaceShellSessionContext =
  createContext<WorkspaceSessionContextValue | null>(null);

export default WorkspaceShellSessionContext;

export function useWorkspaceSession() {
  const context = useContext(WorkspaceShellSessionContext);

  if (!context) {
    throw new Error(
      "useWorkspaceSession must be used inside WorkspaceShellSession",
    );
  }

  return context;
}
