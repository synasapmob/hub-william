import { useEffect, useRef, useState, type PropsWithChildren } from "react";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { toast } from "sonner";
import { tv } from "tailwind-variants";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ServiceError } from "@/services/api/api-client";
import { editedText } from "@/services/stock/stock-labels";
import {
  stockService,
  type AccountsEdited,
  type RevealedAccount,
  type StockAccount,
} from "@/services/stock/stock-service";
import {
  checkAccountLines,
  type AccountLines,
} from "@/utils/utils.account-lines";

// How long opened accounts stay in view without a keystroke before the dialog
// closes and drops them: longer when there is something to edit.
const EDIT_MINUTES = 5;
const VIEW_SECONDS = 30;

const total = tv({
  base: "tabular-nums",
  variants: { danger: { true: "font-medium text-destructive" } },
});

function problemOf(error: Error) {
  if (error instanceof ServiceError && error.status === 422)
    return "Mật khẩu không đúng.";

  if (error instanceof ServiceError && error.status === 429)
    return "Thử quá nhiều lần. Chờ một phút rồi thử lại.";

  return error.message;
}

function Shell({
  children,
  onClose,
}: PropsWithChildren<{ onClose: () => void }>) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">{children}</DialogContent>
    </Dialog>
  );
}

interface PasswordStepProps {
  accounts: StockAccount[];
  editable: boolean;
  password: string;
  reveal: UseMutationResult<RevealedAccount[], Error, void>;
  onClose: () => void;
  onPasswordChange: (value: string) => void;
}

function PasswordStep({
  accounts,
  editable,
  onClose,
  onPasswordChange,
  password,
  reveal,
}: PasswordStepProps) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        reveal.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {editable ? "Xem / sửa" : "Xem"}{" "}
          {accounts.length === 1
            ? `tài khoản ${accounts[0].email_hint}`
            : `${accounts.length} tài khoản của ${accounts[0].product_title}`}
        </DialogTitle>

        <DialogDescription>
          Nhập mật khẩu đăng nhập của bạn. Mỗi tài khoản được mở đều được ghi
          lại.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Label htmlFor="editor-password">Mật khẩu của bạn</Label>

        <Input
          aria-invalid={reveal.isError}
          autoComplete="off"
          id="editor-password"
          type="password"
          value={password}
          onChange={(event) => onPasswordChange(event.target.value)}
        />

        {reveal.error && (
          <p className="text-xs text-destructive" role="alert">
            {problemOf(reveal.error)}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Hủy
        </Button>

        <Button disabled={password === "" || reveal.isPending} type="submit">
          Mở
        </Button>
      </DialogFooter>
    </form>
  );
}

interface EditStepProps {
  check: UseMutationResult<AccountsEdited, Error, void>;
  editable: boolean;
  /** How many accounts were opened. */
  opened: number;
  lines: AccountLines;
  text: string;
  /** Whether the block is what it was when it was opened. */
  unchanged: boolean;
  onClose: () => void;
  onTextChange: (value: string) => void;
}

function EditStep({
  check,
  editable,
  lines,
  onClose,
  onTextChange,
  opened,
  text,
  unchanged,
}: EditStepProps) {
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        check.mutate();
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {editable ? "Sửa" : "Xem"} {opened} tài khoản
        </DialogTitle>

        <DialogDescription>
          {editable
            ? `Mỗi dòng một tài khoản, dạng email|mật khẩu. Sửa một dòng để đổi, xóa một dòng để xóa tài khoản, thêm dòng mới để nạp thêm; chưa có gì được lưu cho tới khi bạn xác nhận. Tự đóng sau ${EDIT_MINUTES} phút không thao tác. Lần xem này đã được ghi lại.`
            : `Tài khoản đã bán, chỉ để xem. Tự đóng sau ${VIEW_SECONDS} giây. Lần xem này đã được ghi lại.`}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <Flex className="items-baseline justify-between gap-2">
          <Label htmlFor="editor-lines">Tài khoản</Label>

          <span className="text-xs text-muted-foreground tabular-nums">
            {lines.count} dòng
          </span>
        </Flex>

        <Textarea
          aria-invalid={lines.problem !== null}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="font-mono"
          id="editor-lines"
          readOnly={!editable}
          rows={Math.min(Math.max(opened + 2, 4), 14)}
          spellCheck={false}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
        />

        {lines.problem && (
          <p className="text-xs text-destructive">{lines.problem}</p>
        )}

        {check.error && (
          <p className="text-xs text-destructive" role="alert">
            {check.error.message}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {editable ? "Hủy" : "Đóng"}
        </Button>

        {editable && (
          <Button
            disabled={unchanged || lines.problem !== null || check.isPending}
            type="submit"
          >
            Xem thay đổi
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

interface ConfirmStepProps {
  plan: AccountsEdited;
  productTitle: string;
  save: UseMutationResult<AccountsEdited, Error, void>;
  onBack: () => void;
}

function ConfirmStep({ onBack, plan, productTitle, save }: ConfirmStepProps) {
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>Xác nhận thay đổi</DialogTitle>

        <DialogDescription>Gói {productTitle}.</DialogDescription>
      </DialogHeader>

      <ul className="space-y-1 text-sm">
        <li>
          Đổi email hoặc mật khẩu:{" "}
          <span className={total()}>{plan.changed}</span>
        </li>

        <li>
          Thêm mới: <span className={total()}>{plan.added}</span>
        </li>

        <li>
          Xóa khỏi kho:{" "}
          <span className={total({ danger: plan.removed > 0 })}>
            {plan.removed}
          </span>
        </li>

        {plan.duplicates > 0 && (
          <li className="text-muted-foreground">
            {plan.duplicates} dòng đã có sẵn trong gói nên được bỏ qua.
          </li>
        )}

        <li className="text-muted-foreground">
          Trong kho sau khi lưu: {plan.available} tài khoản.
        </li>
      </ul>

      {plan.removed > 0 && (
        <p className="text-xs text-destructive">
          Tài khoản bị xóa không còn được bán và không hoàn tác được.
        </p>
      )}

      {plan.changed + plan.added + plan.removed === 0 && (
        <p className="text-xs text-muted-foreground">Không có gì thay đổi.</p>
      )}

      {save.error && (
        <p className="text-xs text-destructive" role="alert">
          {save.error.message}
        </p>
      )}

      <DialogFooter>
        <Button variant="outline" onClick={onBack}>
          Quay lại sửa
        </Button>

        <Button
          disabled={
            plan.changed + plan.added + plan.removed === 0 || save.isPending
          }
          variant={plan.removed > 0 ? "destructive" : "default"}
          onClick={() => save.mutate()}
        >
          Lưu thay đổi
        </Button>
      </DialogFooter>
    </div>
  );
}

interface AccountEditorDialogProps {
  /** The accounts to open, all of one package. */
  accounts: StockAccount[];
  onClose: () => void;
}

/**
 * Opens accounts for the owner, once they have typed their own password, as a
 * block of `email|mật khẩu` lines to read and edit. Saving shows what would
 * change first: lines changed are rewritten, lines deleted are taken out of
 * stock, lines added are put in. The accounts live only in this component:
 * closing it, or leaving it alone for a while, drops them.
 */
export default function AccountEditorDialog({
  accounts,
  onClose,
}: AccountEditorDialogProps) {
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [opened, setOpened] = useState<RevealedAccount[] | null>(null);
  const [text, setText] = useState("");
  const [plan, setPlan] = useState<AccountsEdited | null>(null);
  const closing = useRef(onClose);

  const editable = accounts.every((account) => !account.order_reference);
  const ids = (opened ?? []).map((line) => line.id);
  const original = (opened ?? []).map((line) => line.account).join("\n");

  const reveal = useMutation({
    mutationFn: () =>
      stockService.revealAccounts(
        accounts.map((account) => account.id),
        password,
      ),
    onSuccess: (revealed) => {
      setPassword("");
      setOpened(revealed);
      setText(revealed.map((line) => line.account).join("\n"));
    },
  });
  const check = useMutation({
    mutationFn: () =>
      stockService.editAccounts(accounts[0].product_slug, {
        accounts: text,
        dryRun: true,
        ids,
      }),
    onSuccess: setPlan,
  });
  const save = useMutation({
    mutationFn: () =>
      stockService.editAccounts(accounts[0].product_slug, {
        accounts: text,
        dryRun: false,
        ids,
      }),
    onSettled: () =>
      // The list and the stock both sit under the stock key.
      queryClient.invalidateQueries({ queryKey: stockService.queryKey }),
    onSuccess: (done) => {
      toast.success("Đã lưu thay đổi", { description: editedText(done) });
      onClose();
    },
  });

  useEffect(() => {
    closing.current = onClose;
  });

  // Out of sight again when left alone, and the clock starts over at every keystroke.
  useEffect(() => {
    if (opened === null) return;

    const timer = window.setTimeout(
      () => {
        toast("Đã đóng vì lâu không thao tác.");
        closing.current();
      },
      (editable ? EDIT_MINUTES * 60 : VIEW_SECONDS) * 1000,
    );

    return () => window.clearTimeout(timer);
  }, [editable, opened, plan, text]);

  if (plan) {
    return (
      <Shell onClose={onClose}>
        <ConfirmStep
          plan={plan}
          productTitle={accounts[0].product_title}
          save={save}
          onBack={() => {
            setPlan(null);
            check.reset();
            save.reset();
          }}
        />
      </Shell>
    );
  }

  if (opened) {
    return (
      <Shell onClose={onClose}>
        <EditStep
          check={check}
          editable={editable}
          lines={checkAccountLines(text)}
          opened={opened.length}
          text={text}
          unchanged={text === original}
          onClose={onClose}
          onTextChange={setText}
        />
      </Shell>
    );
  }

  return (
    <Shell onClose={onClose}>
      <PasswordStep
        accounts={accounts}
        editable={editable}
        password={password}
        reveal={reveal}
        onClose={onClose}
        onPasswordChange={setPassword}
      />
    </Shell>
  );
}
