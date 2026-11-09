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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ServiceError } from "@/services/api/api-client";
import {
  stockService,
  type StockAccount,
} from "@/services/stock/stock-service";

function problemOf(error: Error) {
  if (error instanceof ServiceError && error.status === 404)
    return "Tài khoản này đã bán hoặc không còn trong kho.";

  return error.message;
}

interface AccountEditDialogProps {
  account: StockAccount;
  onClose: () => void;
}

/**
 * Changes the email, the password, or both, of an account not sold. The page
 * never has the account in the clear: a field left blank keeps what the server
 * holds, and what is typed goes to the server once.
 */
export default function AccountEditDialog({
  account,
  onClose,
}: AccountEditDialogProps) {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const change = useMutation({
    mutationFn: () =>
      stockService.updateAccount(account.id, {
        email: email.trim() || undefined,
        password: password.trim() || undefined,
      }),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: stockService.queryKey }),
    onSuccess: (hint) => {
      toast.success("Đã sửa tài khoản", { description: hint });
      onClose();
    },
  });

  const emailProblem = email.includes("|")
    ? "Email không được có dấu |."
    : null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            change.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Sửa tài khoản {account.email_hint}</DialogTitle>

            <DialogDescription>
              Gói {account.product_title}. Để trống ô nào thì giữ nguyên ô đó.
              Mật khẩu hiện tại không hiển thị ở đây.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="edit-account-email">Email mới</Label>

            <Input
              aria-invalid={emailProblem !== null}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              id="edit-account-email"
              spellCheck={false}
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />

            {emailProblem && (
              <p className="text-xs text-destructive">{emailProblem}</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="edit-account-password">Mật khẩu mới</Label>

            <Input
              autoComplete="new-password"
              id="edit-account-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          {change.error && (
            <p className="text-xs text-destructive" role="alert">
              {problemOf(change.error)}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>

            <Button
              disabled={
                (email.trim() === "" && password.trim() === "") ||
                emailProblem !== null ||
                change.isPending
              }
              type="submit"
            >
              Lưu
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
