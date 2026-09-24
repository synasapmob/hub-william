import { useOutletContext } from "react-router";

import type { Organization } from "@/services/organizations";

export interface OrganizationContextValue {
  organization: Organization;
}

export function useOrganizationContext() {
  return useOutletContext<OrganizationContextValue>();
}
