import { useOutletContext } from "react-router";

import type { Organization } from "@/services/organizations";

export interface OrganizationContextValue {
  // Null while the session or the organization list is still loading. Every
  // page renders its own skeleton until this resolves.
  organization: Organization | null;
}

export function useOrganizationContext() {
  return useOutletContext<OrganizationContextValue>();
}

// Mutations sit behind controls that only render once the organization is
// known, so a missing one here is a bug rather than a state to handle.
export function requireOrganization(organization: Organization | null) {
  if (!organization) throw new Error("The organization has not loaded yet.");
  return organization;
}
