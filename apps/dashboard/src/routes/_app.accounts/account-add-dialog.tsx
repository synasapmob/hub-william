import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { TelegramProduct } from "@/services/sales/sales-types";
import { loadedText } from "@/services/stock/stock-labels";
import { stockService } from "@/services/stock/stock-service";
import { checkAccountLines } from "@/utils/utils.account-lines";

interface AccountAddDialogProps {
  /** The packages that hand out accounts. */
  packages: TelegramProduct[];
  /** The slug the page is narrowed to, or "all". */
  initialProduct: string;
  onClose: () => void;
}

/**
 * Puts accounts in stock for one package: a block pasted here goes to the server
 * once, is sealed there, and is dropped from this page when the dialog closes.
 */
export default function AccountAddDialog({
  initialProduct,
  onClose,
  packages,
}: AccountAddDialogProps) {
  const queryClient = useQueryClient();
  const [slug, setSlug] = useState(
    packages.some((item) => item.slug === initialProduct) ? initialProduct : "",
  );
  const [accounts, setAccounts] = useState("");

  const lines = checkAccountLines(accounts);
  const load = useMutation({
    mutationFn: () => stockService.loadAccounts(slug, accounts.trim()),
    onError: (error) =>
      toast.error("Không nạp được tài khoản", { description: error.message }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: stockService.queryKey }),
    onSuccess: (loaded) => {
      toast.success("Đã nạp tài khoản", { description: loadedText(loaded) });
      onClose();
    },
  });

  if (packages.length === 0) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Chưa có gói nào giao tài khoản</DialogTitle>

            <DialogDescription>
              Vào Kho hàng, tạo một gói và bật “Giao tài khoản tự động”, rồi
              quay lại đây để nạp tài khoản.
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button onClick={onClose}>Đóng</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            load.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Thêm tài khoản</DialogTitle>

            <DialogDescription>
              Mỗi dòng một tài khoản, dạng email|mật khẩu. Tài khoản được mã hóa
              khi lưu; danh sách chỉ hiện email đã che.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="add-accounts-package">Gói</Label>

            <Select value={slug} onValueChange={setSlug}>
              <SelectTrigger className="w-full" id="add-accounts-package">
                <SelectValue placeholder="Chọn gói" />
              </SelectTrigger>

              <SelectContent>
                {packages.map((item) => (
                  <SelectItem key={item.slug} value={item.slug}>
                    {item.provider} {item.plan}
                    {item.variant && ` (${item.variant})`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Flex className="items-baseline justify-between gap-2">
              <Label htmlFor="add-accounts-lines">Tài khoản</Label>

              {lines.count > 0 && (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {lines.count} tài khoản
                </span>
              )}
            </Flex>

            <Textarea
              aria-invalid={lines.problem !== null}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              className="font-mono"
              id="add-accounts-lines"
              placeholder={
                "email1@example.com|mat-khau-1\nemail2@example.com|mat-khau-2"
              }
              rows={6}
              spellCheck={false}
              value={accounts}
              onChange={(event) => setAccounts(event.target.value)}
            />

            <p
              className={
                lines.problem === null
                  ? "text-xs text-muted-foreground"
                  : "text-xs text-destructive"
              }
            >
              {lines.problem ??
                "Một dòng là một tài khoản, kể cả khi email giống nhau. Muốn xem hoặc sửa tài khoản đã nạp, dùng nút Xem / Sửa."}
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>

            <Button
              disabled={
                slug === "" ||
                lines.count === 0 ||
                lines.problem !== null ||
                load.isPending
              }
              type="submit"
            >
              Nạp tài khoản
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
