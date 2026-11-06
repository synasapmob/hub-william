import { useState, type PropsWithChildren } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import type {
  OwnedTicket,
  TicketListing,
  TicketProvider,
} from "@/services/service-billing/service-billing-types";
import { formatDollars } from "@/utils/utils.money";

import ServiceOwnedTickets from "./service-owned-tickets";
import ServiceTicketCard from "./service-ticket-card";
import ServiceTicketKeyDialog from "./service-ticket-key-dialog";

// What the open dialog is about: buying a ticket, or replacing the key of one.
type OpenDialog =
  | { kind: "buy"; listing: TicketListing; provider: TicketProvider }
  | { kind: "replace"; ticket: OwnedTicket };

function PricingFrame({ children }: PropsWithChildren) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Pricing
        </h1>

        <p className="mt-1 text-xs text-zinc-500">
          Each plan is an agent account someone put on sale. Pay once from your
          balance and get a key that runs on that account for the days shown.
          Nothing is charged by the token.
        </p>
      </header>

      {children}
    </div>
  );
}

export default function ServicePricingRoute() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const ticketsQuery = useQuery({
    queryFn: () => serviceBillingService.ticketListings(),
    queryKey: serviceBillingService.ticketsQueryKey,
  });
  // The same query as the wallet bar's, so the two always agree.
  const walletQuery = useQuery({
    enabled: Boolean(session.user),
    queryFn: () => serviceBillingService.wallet(),
    queryKey: serviceBillingService.walletQueryKey(session.user?.id),
  });
  const ownedQuery = useQuery({
    enabled: Boolean(session.user),
    queryFn: () => serviceBillingService.ownedTickets(),
    queryKey: serviceBillingService.ownedTicketsQueryKey(session.user?.id),
  });
  const providers = ticketsQuery.data;
  const balance = walletQuery.data?.walletMicro ?? null;
  const owned = ownedQuery.data ?? [];

  // A ticket that was just bought is no longer for sale, and the wallet is lower.
  function refresh() {
    void queryClient.invalidateQueries({
      queryKey: serviceBillingService.ticketsQueryKey,
    });
    void queryClient.invalidateQueries({
      queryKey: serviceBillingService.walletQueryKey(session.user?.id),
    });
    void queryClient.invalidateQueries({
      queryKey: serviceBillingService.ownedTicketsQueryKey(session.user?.id),
    });
  }

  if (ticketsQuery.error) {
    return (
      <PricingFrame>
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{ticketsQuery.error.message}</p>

          <Button
            className="mt-3"
            onClick={() => void ticketsQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      </PricingFrame>
    );
  }

  if (!providers) {
    return (
      <PricingFrame>
        <p role="status" className="sr-only">
          Loading plans
        </p>

        <div
          aria-hidden="true"
          className="grid gap-4 md:grid-cols-2 xl:grid-cols-3"
        >
          {[0, 1, 2].map((key) => (
            <Skeleton key={key} className="h-64 rounded-xl bg-zinc-200" />
          ))}
        </div>
      </PricingFrame>
    );
  }

  return (
    <PricingFrame>
      {providers.length === 0 ? (
        <p className="text-sm text-zinc-500">
          No plans are for sale right now.
        </p>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <ServiceTicketCard
              key={provider.provider}
              balanceMicro={balance}
              provider={provider}
              onBuy={(listing) => {
                // A guest signs in first, and presses Buy again.
                if (!session.user) {
                  session.openAuth();

                  return;
                }

                setDialog({ kind: "buy", listing, provider });
              }}
            />
          ))}
        </div>
      )}

      {owned.length > 0 && (
        <ServiceOwnedTickets
          tickets={owned}
          onReplace={(ticket) => setDialog({ kind: "replace", ticket })}
        />
      )}

      {dialog?.kind === "buy" && (
        <ServiceTicketKeyDialog
          confirmLabel={`Buy for ${formatDollars(dialog.listing.priceMicro)}`}
          description={`${formatDollars(dialog.listing.priceMicro)} is taken from your balance${balance === null ? "" : ` (${formatDollars(balance)} now)`}. You get a key that runs only on this ${dialog.provider.label} account, for ${dialog.listing.days} ${dialog.listing.days === 1 ? "day" : "days"} from now. The key is shown once.`}
          explain={(error) =>
            error.status === 404
              ? "This plan was just sold or is no longer for sale."
              : error.message
          }
          title={`Buy ${dialog.listing.name}?`}
          run={() => serviceBillingService.purchaseTicket(dialog.listing.id)}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}

      {dialog?.kind === "replace" && (
        <ServiceTicketKeyDialog
          confirmLabel="Get a new key"
          description="The key you have stops working at once, and the new one is shown once. The ticket ends when it was going to."
          explain={(error) =>
            error.status === 404
              ? "This ticket has ended, so its key cannot be replaced."
              : error.message
          }
          title={`New key for ${dialog.ticket.name}?`}
          run={() => serviceBillingService.reissueTicket(dialog.ticket.keyId)}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </PricingFrame>
  );
}
