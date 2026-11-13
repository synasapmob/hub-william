import { createContext, useContext } from "react";

import type { IconAssignment } from "@/services/icons/icon-service";

/** The icons the shop gave its providers. */
export interface ProviderIconsValue {
  /** Whether the icon bucket is set up, so an icon can be chosen. */
  enabled: boolean;
  /** The icon of a provider named however the shop wrote it; null for none. */
  iconOf: (provider: string) => IconAssignment | null;
}

// Without a provider above (a page in a test, say) no provider has an icon.
export const ProviderIconsContext = createContext<ProviderIconsValue>({
  enabled: false,
  iconOf: () => null,
});

export function useProviderIcons() {
  return useContext(ProviderIconsContext);
}
