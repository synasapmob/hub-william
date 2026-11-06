import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import { formatDollars } from "@/utils/utils.money";

import ServiceTopUpDialog from "./service-top-up-dialog";

export default function ServiceWalletBar() {
  const session = useWorkspaceSession();
  const walletQuery = useQuery({
    enabled: Boolean(session.user),
    queryFn: () => serviceBillingService.wallet(),
    queryKey: serviceBillingService.walletQueryKey(session.user?.id),
  });
  const pricingQuery = useQuery({
    queryFn: () => serviceBillingService.pricing(),
    queryKey: serviceBillingService.pricingQueryKey,
  });
  const wallet = walletQuery.data;

  // Only a signed-in user has a wallet to show; a guest sees nothing here.
  if (session.status === "guest") {
    return null;
  }

  if (walletQuery.error) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
      >
        <p>{walletQuery.error.message}</p>

        <Button
          className="mt-3"
          onClick={() => void walletQuery.refetch()}
          size="sm"
          type="button"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }

  if (!wallet) {
    return (
      <div
        aria-hidden="true"
        className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs"
      >
        <Skeleton className="h-10 w-72 max-w-full bg-zinc-200" />
      </div>
    );
  }

  return (
    <Flex className="flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
      <div>
        <p className="text-[11px] font-medium tracking-wide text-zinc-500 uppercase">
          Your balance
        </p>

        <p className="font-heading text-xl font-semibold">
          {formatDollars(wallet.walletMicro)}
        </p>
      </div>

      <ServiceTopUpDialog
        cardTopUp={pricingQuery.data?.cardTopUp ?? false}
        testTopUp={pricingQuery.data?.testTopUp ?? false}
      />
    </Flex>
  );
}
