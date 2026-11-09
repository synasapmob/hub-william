import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StockAccount } from "@/services/stock/stock-service";

interface AccountRemoveDialogProps {
  account: StockAccount;
  onClose: () => void;
  onRemove: () => void;
}

export default function AccountRemoveDialog({
  account,
  onClose,
  onRemove,
}: AccountRemoveDialogProps) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            Xóa tài khoản {account.email_hint} khỏi {account.product_title}?
          </DialogTitle>

          <DialogDescription>
            Tài khoản này không còn được bán và tồn kho giảm một. Không hoàn tác
            được.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Giữ lại
          </Button>

          <Button variant="destructive" onClick={onRemove}>
            Xóa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
