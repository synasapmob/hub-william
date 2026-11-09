import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { StockAccount } from "@/services/stock/stock-service";
import { formatDateTime } from "@/utils/utils.format";

interface AccountsTableProps {
  /** The state of the request for the accounts. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  /** The accounts of the page being shown. */
  accounts: StockAccount[];
  /** Whether the person looking may open an account, which is also how they edit. */
  canReveal: boolean;
  /** Opens the account to read, and to edit when it is not sold. */
  onReveal: (account: StockAccount) => void;
  /** Changes an account without opening it, for those who may not. */
  onEdit: (account: StockAccount) => void;
  onRemove: (account: StockAccount) => void;
  onRetry: () => void;
}

export default function AccountsTable({
  accounts,
  canReveal,
  error,
  onEdit,
  onRemove,
  onReveal,
  onRetry,
  status,
}: AccountsTableProps) {
  if (status === "pending") {
    return (
      <div className="space-y-2 rounded-xl border bg-card p-4" role="status">
        <span className="sr-only">Đang tải tài khoản…</span>

        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-3 rounded-xl border bg-card py-10 text-center">
        <p className="text-sm text-destructive" role="alert">
          {error ?? "Không tải được tài khoản."}
        </p>

        <Button variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tài khoản</TableHead>

            <TableHead>Gói</TableHead>

            <TableHead>Trạng thái</TableHead>

            <TableHead>Nạp bởi</TableHead>

            <TableHead className="text-right">
              <span className="sr-only">Thao tác</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {accounts.length === 0 && (
            <TableRow>
              <TableCell
                className="py-10 text-center text-muted-foreground"
                colSpan={5}
              >
                Không có tài khoản nào.
              </TableCell>
            </TableRow>
          )}

          {accounts.map((account) => (
            <TableRow key={account.id}>
              <TableCell className="font-mono text-sm">
                {account.email_hint}
              </TableCell>

              <TableCell>{account.product_title}</TableCell>

              <TableCell>
                {account.order_reference ? (
                  <div className="space-y-1">
                    <Badge variant="outline">Đã bán</Badge>

                    <p className="font-mono text-xs text-muted-foreground">
                      {account.order_reference}
                    </p>
                  </div>
                ) : (
                  <Badge variant="secondary">Chưa bán</Badge>
                )}
              </TableCell>

              <TableCell>
                <p>{account.loaded_by ?? "—"}</p>

                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(account.loaded_at)}
                </p>
              </TableCell>

              <TableCell className="text-right">
                <Flex className="justify-end gap-1.5">
                  {canReveal && (
                    <Button
                      aria-label={`${account.order_reference ? "Xem" : "Xem / sửa"} tài khoản ${account.email_hint} của ${account.product_title}`}
                      size="sm"
                      variant="outline"
                      onClick={() => onReveal(account)}
                    >
                      {account.order_reference ? "Xem" : "Xem / Sửa"}
                    </Button>
                  )}

                  {!canReveal && !account.order_reference && (
                    <Button
                      aria-label={`Sửa tài khoản ${account.email_hint} của ${account.product_title}`}
                      size="sm"
                      variant="outline"
                      onClick={() => onEdit(account)}
                    >
                      Sửa
                    </Button>
                  )}

                  {!account.order_reference && (
                    <Button
                      aria-label={`Xóa tài khoản ${account.email_hint} của ${account.product_title}`}
                      size="sm"
                      variant="outline"
                      onClick={() => onRemove(account)}
                    >
                      Xóa
                    </Button>
                  )}
                </Flex>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
