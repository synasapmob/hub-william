import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type {
  ServiceListing,
  ServiceProvider,
  TelegramProduct,
} from "@/services/sales/sales-types";

import ServiceProviderCard from "./service-provider-card";
import StockProviderCard from "./stock-provider-card";

const GRID = "grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3";

// The packages under their provider, in the order the shop keeps them: a
// provider stands where its first package does.
function byProvider(items: TelegramProduct[]) {
  const providers = new Map<string, TelegramProduct[]>();

  for (const item of items)
    providers.set(item.provider, [
      ...(providers.get(item.provider) ?? []),
      item,
    ]);

  return [...providers];
}

// The agents in the order Hub William lists them.
const AGENTS = Object.keys(serviceProviderLabels) as ServiceProvider[];

interface StockListProps {
  /** The state of the request for the stock. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  /** What to show once loaded: the packages after the search and the type filter. */
  items: TelegramProduct[];
  /** Hub William's tickets after the same search and filter. */
  listings: ServiceListing[];
  /** The type shown, to say what an empty list is missing. */
  type: "all" | "telegram" | "hub-william";
  /** What was searched for; empty when nothing was. */
  query: string;
  onAdd: (provider: string) => void;
  onEdit: (item: TelegramProduct) => void;
  onAddListing: (provider: ServiceProvider) => void;
  onEditListing: (listing: ServiceListing) => void;
  onRetry: () => void;
}

/** The stock as one card per provider, or why there is none to show. */
export default function StockList({
  error,
  items,
  listings,
  onAdd,
  onAddListing,
  onEdit,
  onEditListing,
  onRetry,
  query,
  status,
  type,
}: StockListProps) {
  if (status === "pending") {
    return (
      <div className={GRID} role="status">
        <span className="sr-only">Đang tải kho hàng…</span>

        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-56 rounded-xl" />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="text-sm text-destructive" role="alert">
          {error ?? "Không tải được kho hàng."}
        </p>

        <Button variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    );
  }

  // An agent has a card of Hub William's only while it has a ticket to show: with
  // none for sale there is nothing to put on a card, and the first one is added from
  // the header.
  const agents = AGENTS.filter(
    (agent) =>
      type !== "telegram" &&
      listings.some((listing) => listing.provider === agent),
  );

  if (items.length === 0 && agents.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        {query !== "" ? (
          <>Không có hàng nào khớp &ldquo;{query}&rdquo;.</>
        ) : (
          "Chưa có hàng nào trong mục này."
        )}
      </p>
    );
  }

  return (
    <div className={GRID}>
      {byProvider(items).map(([provider, packages]) => (
        <StockProviderCard
          key={provider}
          items={packages}
          provider={provider}
          onAdd={() => onAdd(provider)}
          onEdit={onEdit}
        />
      ))}

      {agents.map((agent) => (
        <ServiceProviderCard
          key={agent}
          listings={listings.filter((listing) => listing.provider === agent)}
          provider={agent}
          onAdd={() => onAddListing(agent)}
          onEdit={onEditListing}
        />
      ))}
    </div>
  );
}
