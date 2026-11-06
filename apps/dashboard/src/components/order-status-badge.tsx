import { CircleCheck, CircleX, Clock } from "lucide-react";
import { tv } from "tailwind-variants";

import { orderStatusLabels } from "@/services/sales/sales-labels";
import type { OrderStatus } from "@/services/sales/sales-types";

const badge = tv({
  base: "inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap",
  variants: {
    status: {
      awaiting_payment: "border-amber-200 bg-amber-50 text-amber-800",
      paid: "border-emerald-200 bg-emerald-50 text-emerald-800",
      cancelled: "border-zinc-200 bg-zinc-100 text-zinc-600",
    },
  },
});

const icons = {
  awaiting_payment: Clock,
  paid: CircleCheck,
  cancelled: CircleX,
};

/** The status is always written out; the colour only repeats it. */
export default function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const Icon = icons[status];

  return (
    <span className={badge({ status })}>
      <Icon aria-hidden={true} className="size-3" />

      {orderStatusLabels[status]}
    </span>
  );
}
