import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ServiceError } from "@/services/api/api-client";
import type { TelegramProduct } from "@/services/sales/sales-types";
import { stockService } from "@/services/stock/stock-service";
import type { AccountLines } from "@/utils/utils.account-lines";

// How long opened accounts stay on the form without a keystroke.
const IDLE_MINUTES = 5;

/** The accounts a block was made from, and the block as it was when they were opened. */
export interface OpenedAccounts {
  ids: string[];
  original: string;
}

function problemOf(error: Error) {
  if (error instanceof ServiceError && error.status === 422)
    return "Mật khẩu không đúng.";

  if (error instanceof ServiceError && error.status === 429)
    return "Thử quá nhiều lần. Chờ một phút rồi thử lại.";

  return error.message;
}

interface StockAccountsEditorProps {
  /** A package that hands out accounts. */
  item: TelegramProduct;
  /** The block as it is being edited. */
  text: string;
  /** What `text` comes to, line by line. */
  lines: AccountLines;
  /** The accounts the block was made from; null while they are not opened. */
  opened: OpenedAccounts | null;
  /** Opens the accounts (they are given), or forgets them (null). */
  onOpen: (opened: OpenedAccounts | null) => void;
  onTextChange: (text: string) => void;
}

/**
 * The accounts in stock for a package, for the owner: after they type their own
 * password they are the lines `email|mật khẩu`, in a box to read and to edit
 * where they are. Nothing is written here; the form says what the block would
 * change when it is saved. They are forgotten when the form closes or after a
 * while without a keystroke.
 */
export default function StockAccountsEditor({
  item,
  lines,
  onOpen,
  onTextChange,
  opened,
  text,
}: StockAccountsEditorProps) {
  const [password, setPassword] = useState("");
  const forgetting = useRef(onOpen);

  const accounts = useQuery({
    queryFn: () => stockService.accounts(item.slug),
    queryKey: stockService.accountsKey(item.slug),
  });
  const rows = accounts.data ?? [];
  const unsold = rows.filter((account) => !account.order_reference);
  const reveal = useMutation({
    mutationFn: () =>
      stockService.revealAccounts(
        unsold.map((account) => account.id),
        password,
      ),
    onSuccess: (revealed) => {
      setPassword("");
      onOpen({
        ids: revealed.map((line) => line.id),
        original: revealed.map((line) => line.account).join("\n"),
      });
    },
  });

  useEffect(() => {
    forgetting.current = onOpen;
  });

  // Out of sight again when left alone; the clock starts over at every keystroke.
  useEffect(() => {
    if (opened === null) return;

    const timer = window.setTimeout(
      () => {
        toast("Đã ẩn tài khoản vì lâu không thao tác.");
        forgetting.current(null);
      },
      IDLE_MINUTES * 60 * 1000,
    );

    return () => window.clearTimeout(timer);
  }, [opened, text]);

  const standing = `${unsold.length} chưa bán · ${rows.length - unsold.length} đã bán`;

  if (accounts.status === "pending") {
    return (
      <p className="text-xs text-muted-foreground" role="status">
        Đang tải tài khoản…
      </p>
    );
  }

  if (accounts.status === "error") {
    return (
      <p className="text-xs text-destructive" role="alert">
        {accounts.error.message}
      </p>
    );
  }

  if (opened) {
    return (
      <div className="space-y-1.5">
        <Flex className="items-baseline justify-between gap-2">
          <Label htmlFor="stock-accounts-block">Tài khoản trong kho</Label>

          <span className="text-xs text-muted-foreground tabular-nums">
            {lines.count} dòng · {standing.split(" · ")[1]}
          </span>
        </Flex>

        <Textarea
          aria-invalid={lines.problem !== null}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          className="font-mono"
          id="stock-accounts-block"
          rows={Math.min(Math.max(opened.ids.length + 2, 4), 14)}
          spellCheck={false}
          value={text}
          onChange={(event) => onTextChange(event.target.value)}
        />

        <p
          className={
            lines.problem === null
              ? "text-xs text-muted-foreground"
              : "text-xs text-destructive"
          }
        >
          {lines.problem ??
            `Mỗi dòng một tài khoản, dạng email|mật khẩu. Sửa một dòng để đổi, xóa một dòng để xóa tài khoản, thêm dòng mới để nạp thêm. Bấm Lưu sẽ hiện tóm tắt trước khi ghi. Tự ẩn sau ${IDLE_MINUTES} phút không thao tác.`}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Flex className="items-baseline justify-between gap-2">
        <p className="text-sm font-medium">Tài khoản trong kho</p>

        <span className="text-xs text-muted-foreground tabular-nums">
          {standing}
        </span>
      </Flex>

      {unsold.length > 0 ? (
        <>
          <Flex className="items-center gap-2">
            <Input
              aria-invalid={reveal.isError}
              aria-label="Mật khẩu của bạn"
              autoComplete="off"
              className="flex-1"
              placeholder="Mật khẩu của bạn"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;

                event.preventDefault();

                if (password !== "" && !reveal.isPending) reveal.mutate();
              }}
            />

            <Button
              disabled={password === "" || reveal.isPending}
              type="button"
              onClick={() => reveal.mutate()}
            >
              Hiện
            </Button>
          </Flex>

          {reveal.error && (
            <p className="text-xs text-destructive" role="alert">
              {problemOf(reveal.error)}
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          Chưa có tài khoản nào chưa bán.
        </p>
      )}
    </div>
  );
}
