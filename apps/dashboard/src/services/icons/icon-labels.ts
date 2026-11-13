import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type { ServiceProvider } from "@/services/sales/sales-types";

import type { IconUser } from "./icon-service";

/** The name an icon is picked by: its name in the bucket, without `icons/`. */
export const iconName = (key: string) => key.replace(/^icons\//, "");

/**
 * What a provider that shows an icon is called: its name when the shop sells under
 * it on Telegram, else the name of the Hub William agent, else its slug.
 */
export const iconUserName = (user: IconUser) =>
  user.name ??
  serviceProviderLabels[user.provider as ServiceProvider] ??
  user.provider;
