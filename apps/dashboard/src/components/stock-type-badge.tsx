import { Send } from "lucide-react";
import { tv } from "tailwind-variants";

import { stockTypeLabels } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";

const badge = tv({
  base: "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
  variants: {
    type: {
      telegram: "border-sky-200 bg-sky-50 text-sky-700",
    },
  },
});

/** Where an item or an order is sold. */
export default function StockTypeBadge({ type }: { type: StockType }) {
  return (
    <span className={badge({ type })}>
      <Send aria-hidden={true} className="size-3" />

      {stockTypeLabels[type]}
    </span>
  );
}
