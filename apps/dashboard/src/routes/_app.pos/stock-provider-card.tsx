import { Plus } from "lucide-react";

import ProviderIcon from "@/components/provider-icon";
import StockTypeBadge from "@/components/stock-type-badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import type { TelegramProduct } from "@/services/sales/sales-types";
import { availableStock } from "@/utils/utils.format";

import StockRow from "./stock-row";

interface StockProviderCardProps {
  provider: string;
  /** Every package of the provider that is being shown. */
  items: TelegramProduct[];
  onAdd: () => void;
  onEdit: (item: TelegramProduct) => void;
}

/** One provider and its packages, so a shop of many reads as a few cards. */
export default function StockProviderCard({
  items,
  onAdd,
  onEdit,
  provider,
}: StockProviderCardProps) {
  return (
    <section className="flex flex-col overflow-hidden rounded-xl border bg-card">
      <header className="flex items-center gap-3 border-b px-4 py-3">
        <ProviderIcon provider={provider} />

        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="truncate text-sm font-semibold">{provider}</h2>

          <StockTypeBadge type="telegram" />
        </div>

        <p className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {items.length} gói
          <br />
          {items.reduce((total, item) => total + availableStock(item), 0)} còn
        </p>
      </header>

      <ul className="flex-1 divide-y">
        {items.map((item) => (
          <StockRow key={item.slug} item={item} onEdit={() => onEdit(item)} />
        ))}
      </ul>

      <Flex className="border-t px-2 py-1.5">
        <Button
          aria-label={`Thêm gói cho ${provider}`}
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
