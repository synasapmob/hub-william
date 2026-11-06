import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TelegramProduct } from "@/services/sales/sales-types";
import { productTitle } from "@/utils/utils.format";

interface StockDeleteDialogProps {
  item: TelegramProduct;
  onClose: () => void;
  onDelete: () => void;
}

export default function StockDeleteDialog({
  item,
  onClose,
  onDelete,
}: StockDeleteDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xóa {productTitle(item)}?</DialogTitle>

          <DialogDescription>
            Gói này biến mất khỏi menu của bot và khỏi kho. Đơn đã tạo vẫn giữ
            nguyên trong lịch sử.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Giữ lại
          </Button>

          <Button variant="destructive" onClick={onDelete}>
            Xóa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
