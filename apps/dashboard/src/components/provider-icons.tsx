import { useMemo, type PropsWithChildren } from "react";
import { useQuery } from "@tanstack/react-query";

import { iconService } from "@/services/icons/icon-service";
import slugify from "@/utils/utils.slug";

import { ProviderIconsContext } from "./provider-icons-context";

/**
 * Reads which icon each provider shows once and hands it to every icon below, so
 * a page of cards asks the API one time. While it loads, or when it fails, the
 * providers have no icon and show their first letter, as they do without a bucket.
 */
export default function ProviderIcons({ children }: PropsWithChildren) {
  const { data } = useQuery({
    queryFn: () => iconService.list(),
    queryKey: iconService.queryKey,
    staleTime: 5 * 60_000,
  });

  const value = useMemo(() => {
    const byProvider = new Map(
      (data?.assignments ?? []).map((icon) => [icon.provider, icon]),
    );

    return {
      enabled: data?.enabled ?? false,
      iconOf: (provider: string) => byProvider.get(slugify(provider)) ?? null,
    };
  }, [data]);

  return <ProviderIconsContext value={value}>{children}</ProviderIconsContext>;
}
