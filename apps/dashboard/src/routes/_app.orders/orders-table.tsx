import OrderStatusBadge from "@/components/order-status-badge";
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
import {
  orderHandlerLabel,
  paymentMethodLabels,
} from "@/services/sales/sales-labels";
import type { SaleOrder } from "@/services/sales/sales-types";
import {
  formatDateTime,
  formatDuration,
  formatTime,
  formatVnd,
} from "@/utils/utils.format";

// An order past its time keeps waiting and can still be paid; it only stops
// holding stock. So it is flagged, not removed.
function expiry(order: SaleOrder, now: Date) {
  const minutes = Math.round(
    (new Date(order.expires_at).getTime() - now.getTime()) / 60_000,
  );

  return minutes < 0
    ? { text: `Quá hạn ${formatDuration(-minutes)}`, overdue: true }
    : { text: `Còn ${formatDuration(minutes)}`, overdue: false };
}

interface OrdersTableProps {
  /** The state of the request for the orders. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  /** The orders of the page being shown. */
  orders: SaleOrder[];
  /** The queue position of the first row, when the rows are the queue. */
  queueStart: number | null;
  now: Date;
  onPay: (order: SaleOrder) => void;
  onCancel: (order: SaleOrder) => void;
  onRetry: () => void;
}

export default function OrdersTable({
  error,
  now,
  onCancel,
  onPay,
  onRetry,
  orders,
  queueStart,
  status,
}: OrdersTableProps) {
  if (status === "pending") {
    return (
      <div className="space-y-2 rounded-xl border bg-card p-4" role="status">
        <span className="sr-only">Đang tải đơn hàng…</span>

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
          {error ?? "Không tải được danh sách đơn."}
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
            {queueStart !== null && <TableHead className="w-10">#</TableHead>}

            <TableHead>Đơn</TableHead>

            <TableHead>Khách</TableHead>

            <TableHead>Hàng</TableHead>

            <TableHead className="text-right">Tổng</TableHead>

            <TableHead>Trạng thái</TableHead>

            <TableHead>Xử lý bởi</TableHead>

            <TableHead className="text-right">
              <span className="sr-only">Thao tác</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {orders.length === 0 && (
            <TableRow>
              <TableCell
                className="py-10 text-center text-muted-foreground"
                colSpan={8}
              >
                Không có đơn nào.
              </TableCell>
            </TableRow>
          )}

          {orders.map((order, index) => (
            <TableRow key={order.reference}>
              {queueStart !== null && (
                <TableCell className="text-muted-foreground tabular-nums">
                  {queueStart + index}
                </TableCell>
              )}

              <TableCell>
                <p className="font-mono text-xs">{order.reference}</p>

                <p className="text-xs text-muted-foreground tabular-nums">
                  {formatDateTime(order.created_at)}
                </p>
              </TableCell>

              <TableCell>
                <p className="font-medium">
                  {order.customer.username
                    ? `@${order.customer.username}`
                    : order.customer.first_name}
                </p>

                {order.customer.username && (
                  <p className="text-xs text-muted-foreground">
                    {order.customer.first_name}
                  </p>
                )}
              </TableCell>

              <TableCell>
                <p>{order.item_title}</p>

                <p className="text-xs text-muted-foreground">
                  SL {order.quantity}
                  {order.payment_method &&
                    ` · ${paymentMethodLabels[order.payment_method]}`}
                </p>
              </TableCell>

              <TableCell className="text-right font-medium tabular-nums">
                {formatVnd(order.total_vnd)}
              </TableCell>

              <TableCell>
                <div className="space-y-1">
                  <OrderStatusBadge status={order.status} />

                  {order.status === "awaiting_payment" && (
                    <p
                      className={
                        expiry(order, now).overdue
                          ? "text-xs text-amber-700"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {expiry(order, now).text}
                    </p>
                  )}
                </div>
              </TableCell>

              <TableCell>{orderHandlerLabel(order)}</TableCell>

              <TableCell className="text-right">
                {order.status === "awaiting_payment" && (
                  <Flex className="justify-end gap-1.5">
                    <Button
                      aria-label={`Đã nhận tiền đơn ${order.reference}`}
                      size="sm"
                      variant="outline"
                      onClick={() => onPay(order)}
                    >
                      Đã nhận tiền
                    </Button>

                    <Button
                      aria-label={`Hủy đơn ${order.reference}`}
                      size="sm"
                      variant="destructive"
                      onClick={() => onCancel(order)}
                    >
                      Hủy
                    </Button>
                  </Flex>
                )}

                {order.status === "paid" && order.paid_at && (
                  <span className="text-xs text-muted-foreground">
                    Thanh toán {formatTime(order.paid_at)}
                  </span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
