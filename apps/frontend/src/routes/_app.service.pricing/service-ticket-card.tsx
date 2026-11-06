import AgentsProviderIcon from "@/components/agents-provider-icon";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import type {
  TicketListing,
  TicketProvider,
} from "@/services/service-billing/service-billing-types";
import { formatDollars } from "@/utils/utils.money";

import { formatMoment, quotaSummary } from "./service-ticket-text";

interface ServiceTicketCardProps {
  provider: TicketProvider;
  // What the signed-in user holds; null for a guest, or while it loads.
  balanceMicro: number | null;
  onBuy: (listing: TicketListing) => void;
}

// One agent that has tickets for sale: its icon, how many there are, then each
// ticket with how long its key lasts, what the account had left and the price.
export default function ServiceTicketCard({
  balanceMicro,
  onBuy,
  provider,
}: ServiceTicketCardProps) {
  const count = provider.listings.length;

  return (
    <section className="flex h-full flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xs">
      <Flex className="items-center gap-3 border-b border-zinc-100 p-4">
        <AgentsProviderIcon provider={provider.provider} size="lg" />

        <div className="min-w-0 flex-1">
          <h2 className="font-heading text-sm font-semibold">
            {provider.label}
          </h2>

          <p className="text-[11px] text-zinc-500">
            {count} {count === 1 ? "plan" : "plans"}
          </p>
        </div>
      </Flex>

      <ul className="divide-y divide-zinc-100">
        {provider.listings.map((listing) => {
          const quota = quotaSummary(listing.quota);
          const short =
            balanceMicro !== null && balanceMicro < listing.priceMicro;

          return (
            <li key={listing.id} className="space-y-1 p-4">
              <Flex className="items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium wrap-anywhere text-zinc-900">
                    {listing.name}
                  </p>

                  <p className="text-xs text-zinc-500">
                    {listing.days} {listing.days === 1 ? "day" : "days"}
                    {quota && ` · ${quota}`}
                  </p>

                  {quota && listing.quotaCapturedAt && (
                    <p className="text-[11px] text-zinc-400">
                      Read {formatMoment(listing.quotaCapturedAt)}
                    </p>
                  )}
                </div>

                <div className="text-right">
                  <p className="font-heading text-sm font-semibold">
                    {formatDollars(listing.priceMicro)}
                  </p>

                  <Button
                    aria-label={`Buy ${listing.name}`}
                    className="mt-1.5"
                    disabled={short}
                    onClick={() => onBuy(listing)}
                    size="sm"
                    type="button"
                  >
                    Buy
                  </Button>
                </div>
              </Flex>

              {short && (
                <p className="text-right text-[11px] text-zinc-500">
                  Top up {formatDollars(listing.priceMicro - balanceMicro)} more
                  to buy
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
