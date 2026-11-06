import { createContext, useContext } from "react";

import type { Permission, Role } from "@/services/sales/sales-types";

/** Who is signed in, as far as the shell needs to know. */
export interface SessionStaff {
  id: string;
  /** What to call them: the username of their account. */
  name: string;
  role: Role;
}

export interface DashboardSessionValue {
  staff: SessionStaff;
  can: (permission: Permission) => boolean;
  signOut: () => void;
}

export const DashboardSessionContext =
  createContext<DashboardSessionValue | null>(null);

export function useDashboardSession() {
  const session = useContext(DashboardSessionContext);

  if (!session)
    throw new Error("useDashboardSession needs a DashboardSession above it.");

  return session;
}
