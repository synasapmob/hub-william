import { Flame, Pencil } from "lucide-react";
import { tv } from "tailwind-variants";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { warrantyLabels } from "@/services/sales/sales-labels";
import type { TelegramProduct } from "@/services/sales/sales-types";
import {
  availableStock,
  formatVnd,
  stockItemTitle,
} from "@/utils/utils.format";

// A package with this few left is about to sell out.
const LOW_STOCK = 5;

const stock = tv({
  base: "text-xs",
  variants: {
    level: {
      out: "font-medium text-rose-700",
      low: "font-medium text-amber-700",
      ok: "text-muted-foreground",
    },
  },
});

interface StockRowProps {
  item: TelegramProduct;
  onEdit: () => void;
}

/** One package under its provider: what it is, what it costs, how many are left. */
export default function StockRow({ item, onEdit }: StockRowProps) {
  const available = availableStock(item);
  const level = available === 0 ? "out" : available <= LOW_STOCK ? "low" : "ok";

  return (
    <li className="flex items-center gap-3 px-4 py-2.5">
      <div className="min-w-0 flex-1 space-y-0.5">
        <Flex className="items-center gap-1.5">
          <p className="min-w-0 truncate text-sm font-medium">
            {item.plan}
            {item.variant && ` (${item.variant})`}
          </p>

          {item.hot && (
            <Badge className="bg-rose-600 text-white">
              <Flame aria-hidden={true} />
              Hot
            </Badge>
          )}

          {!item.listed && <Badge variant="outline">Đang ẩn</Badge>}

          {item.delivers_accounts && (
            <Badge variant="secondary">Giao tự động</Badge>
          )}
        </Flex>

        <p className="text-xs text-muted-foreground">
          {warrantyLabels[item.warranty]}
          {" · "}
          <span className={stock({ level })}>
            {level === "out"
              ? "Hết hàng"
              : `Còn ${available}${level === "low" ? " · sắp hết" : ""}`}
          </span>
        </p>
      </div>

      <span className="text-sm font-semibold tabular-nums">
        {formatVnd(item.price_vnd)}
      </span>

      <Button
        aria-label={`Sửa ${stockItemTitle(item)}`}
        size="icon-sm"
        variant="ghost"
        onClick={onEdit}
      >
        <Pencil />
      </Button>
    </li>
  );
}
