import { Plus } from "lucide-react";

import ProviderIcon from "@/components/provider-icon";
import StockTypeBadge from "@/components/stock-type-badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type {
  ServiceListing,
  ServiceProvider,
} from "@/services/sales/sales-types";

import ServiceListingRow from "./service-listing-row";

interface ServiceProviderCardProps {
  provider: ServiceProvider;
  /** The agent's tickets that are being shown, in the order they were put on sale. */
  listings: ServiceListing[];
  onAdd: () => void;
  onEdit: (listing: ServiceListing) => void;
}

/** One agent of Hub William's stock: the tickets on sale for it. */
export default function ServiceProviderCard({
  listings,
  onAdd,
  onEdit,
  provider,
}: ServiceProviderCardProps) {
  const name = serviceProviderLabels[provider];

  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <ProviderIcon label={name} provider={provider} />

        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-sm font-semibold">{name}</h2>

          <StockTypeBadge type="hub-william" />
        </div>

        <p className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {listings.length} gói
        </p>
      </header>

      <ul className="flex-1 divide-y">
        {listings.map((listing) => (
          <ServiceListingRow
            key={listing.id}
            listing={listing}
            onEdit={() => onEdit(listing)}
          />
        ))}
      </ul>

      <Flex className="gap-1 border-t px-2 py-1.5">
        <Button
          aria-label={`Thêm gói cho ${name}`}
          className="text-muted-foreground"
          size="sm"
          variant="ghost"
          onClick={onAdd}
        >
          <Plus data-icon="inline-start" />
          Thêm gói
        </Button>
      </Flex>
    </section>
  );
}
