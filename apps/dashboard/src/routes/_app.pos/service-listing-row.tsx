import { Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import { listingStatusLabels } from "@/services/sales/sales-labels";
import type { ServiceListing } from "@/services/sales/sales-types";
import { formatUsd } from "@/utils/utils.format";

import { quotaLine } from "./service-listing-text";

interface ServiceListingRowProps {
  listing: ServiceListing;
  onEdit: () => void;
}

/** One ticket on a card: what it is called, how long it lasts, what it costs. */
export default function ServiceListingRow({
  listing,
  onEdit,
}: ServiceListingRowProps) {
  const quota = quotaLine(listing.quota);

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="truncate text-sm font-medium">{listing.name}</p>

          {listing.status !== "for_sale" && (
            <span className="inline-flex h-5 items-center rounded-4xl border border-amber-200 bg-amber-50 px-2 text-xs font-medium text-amber-800">
              {listingStatusLabels[listing.status]}
            </span>
          )}
        </div>

        <p className="text-xs text-muted-foreground">
          {listing.days} ngày{quota && ` · ${quota}`}
        </p>
      </div>

      <p className="text-sm font-medium tabular-nums">
        {formatUsd(listing.price_micro)}
      </p>

      <Button
        aria-label={`Sửa gói ${listing.name}`}
        size="icon-sm"
        variant="ghost"
        onClick={onEdit}
      >
        <Pencil />
      </Button>
    </li>
  );
}
