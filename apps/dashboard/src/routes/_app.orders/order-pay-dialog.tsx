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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { paymentMethodLabels } from "@/services/sales/sales-labels";
import type { PaymentMethod, SaleOrder } from "@/services/sales/sales-types";
import { formatVnd } from "@/utils/utils.format";

interface OrderPayDialogProps {
  order: SaleOrder;
  onClose: () => void;
  /** Rejects when the order could not be marked paid; the dialog then stays. */
  onPay: (method: PaymentMethod) => Promise<void>;
}

/** Asks how the money arrived, since the order is paid once and for good. */
export default function OrderPayDialog({
  onClose,
  onPay,
  order,
}: OrderPayDialogProps) {
  const [method, setMethod] = useState<PaymentMethod>("bank_transfer");
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Đã nhận tiền đơn {order.reference}?</DialogTitle>

          <DialogDescription>
            {formatVnd(order.total_vnd)} cho {order.item_title}, SL{" "}
            {order.quantity}. Đơn chuyển sang đã thanh toán, kho trừ hàng và bot
            báo cho khách trên Telegram.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label htmlFor="order-payment-method">Khách trả bằng</Label>

          <Select
            value={method}
            onValueChange={(next) => setMethod(next as PaymentMethod)}
          >
            <SelectTrigger className="w-full" id="order-payment-method">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              {(Object.keys(paymentMethodLabels) as PaymentMethod[]).map(
                (value) => (
                  <SelectItem key={value} value={value}>
                    {paymentMethodLabels[value]}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </div>

        <DialogFooter>
          <Button disabled={saving} variant="outline" onClick={onClose}>
            Chưa
          </Button>

          <Button
            disabled={saving}
            onClick={async () => {
              setSaving(true);

              try {
                await onPay(method);
              } catch {
                // The page has said why; the dialog stays for another try.
              } finally {
                setSaving(false);
              }
            }}
          >
            Xác nhận
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
