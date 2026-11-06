import { useMemo, type PropsWithChildren } from "react";

import type { DashboardIdentity } from "@/services/session/session-service";

import {
  DashboardSessionContext,
  type DashboardSessionValue,
} from "./dashboard-session-context";

interface DashboardSessionProps extends PropsWithChildren {
  identity: DashboardIdentity;
  onSignOut: () => void;
}

/**
 * Hands a signed-in member of staff to the pages. Pages only ask
 * `can(permission)`: what the role may open is the API's answer, kept as it came.
 */
export default function DashboardSession({
  children,
  identity,
  onSignOut,
}: DashboardSessionProps) {
  const value = useMemo<DashboardSessionValue>(
    () => ({
      staff: { id: identity.id, name: identity.username, role: identity.role },
      can: (permission) => identity.permissions.includes(permission),
      signOut: onSignOut,
    }),
    [identity, onSignOut],
  );

  return (
    <DashboardSessionContext value={value}>{children}</DashboardSessionContext>
  );
}
