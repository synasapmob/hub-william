import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { SaleOrder } from "@/services/sales/sales-types";

interface OrderCancelDialogProps {
  order: SaleOrder;
  onClose: () => void;
  /** Rejects when the order could not be cancelled; the dialog then stays. */
  onCancel: () => Promise<void>;
}

export default function OrderCancelDialog({
  onCancel,
  onClose,
  order,
}: OrderCancelDialogProps) {
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Hủy đơn {order.reference}?</DialogTitle>

          <DialogDescription>
            Hàng đang giữ cho đơn này được trả lại kho. Đơn đã hủy không mở lại
            được; nếu khách trả tiền sau đó, hãy xử lý riêng với khách.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button disabled={saving} variant="outline" onClick={onClose}>
            Giữ đơn
          </Button>

          <Button
            disabled={saving}
            variant="destructive"
            onClick={async () => {
              setSaving(true);

              try {
                await onCancel();
              } catch {
                // The page has said why; the dialog stays for another try.
              } finally {
                setSaving(false);
              }
            }}
          >
            Hủy đơn
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
