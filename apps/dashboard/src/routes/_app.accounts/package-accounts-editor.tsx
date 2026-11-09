import { useQuery } from "@tanstack/react-query";

import AccountEditorDialog from "@/components/account-editor-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { stockService } from "@/services/stock/stock-service";

interface PackageAccountsEditorProps {
  /** The package, by its slug. */
  slug: string;
  onClose: () => void;
}

/**
 * Opens every account of a package that is not sold, as one block to read and
 * edit. It asks the server which accounts there are before it asks for the
 * owner's password.
 */
export default function PackageAccountsEditor({
  onClose,
  slug,
}: PackageAccountsEditorProps) {
  const accounts = useQuery({
    queryFn: () => stockService.accounts(slug),
    queryKey: stockService.accountsKey(slug),
  });
  const unsold = (accounts.data ?? []).filter(
    (account) => !account.order_reference,
  );

  if (
    accounts.status === "pending" ||
    accounts.status === "error" ||
    unsold.length === 0
  ) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Xem / sửa cả gói</DialogTitle>

            <DialogDescription
              role={accounts.status === "error" ? "alert" : "status"}
            >
              {accounts.status === "pending" && "Đang tải tài khoản…"}

              {accounts.status === "error" && accounts.error.message}

              {accounts.status === "success" &&
                "Gói này chưa có tài khoản nào chưa bán."}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button variant="outline" onClick={onClose}>
              Đóng
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return <AccountEditorDialog accounts={unsold} onClose={onClose} />;
}
