import { Bot, Send } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stockTypeLabels } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";

const KINDS = [
  {
    description:
      "Một gói bán qua bot Telegram, có giá bằng đồng và số lượng riêng.",
    icon: Send,
    type: "telegram",
  },
  {
    description:
      "Một key Hub William của bạn làm nguồn: khách dùng Hub William chạy trên các account của key, trả theo token.",
    icon: Bot,
    type: "hub-william",
  },
] as const;

interface AddStockKindDialogProps {
  onChoose: (type: StockType) => void;
  onClose: () => void;
}

/** The first step of adding stock: Telegram and Hub William are two stocks. */
export default function AddStockKindDialog({
  onChoose,
  onClose,
}: AddStockKindDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Thêm hàng</DialogTitle>

          <DialogDescription>
            Telegram và Hub William là hai kho riêng, không dùng chung số lượng.
            Chọn loại hàng muốn thêm.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-2">
          {KINDS.map(({ description, icon: Icon, type }) => (
            <button
              key={type}
              className="flex items-start gap-3 rounded-xl border p-3 text-left transition-colors hover:border-zinc-300 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              type="button"
              onClick={() => onChoose(type)}
            >
              <Icon aria-hidden={true} className="mt-0.5 size-5 shrink-0" />

              <span className="space-y-0.5">
                <span className="block text-sm font-medium">
                  {stockTypeLabels[type]}
                </span>

                <span className="block text-xs text-muted-foreground">
                  {description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
