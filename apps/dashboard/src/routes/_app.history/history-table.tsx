import { Fragment } from "react";

import { Button } from "@/components/ui/button";
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
  formatDayWithWeekday,
  formatTime,
  formatVnd,
  shopDay,
} from "@/utils/utils.format";

// A sale belongs to the day the shop took the money.
function paidDay(order: SaleOrder) {
  return shopDay(order.paid_at ?? order.created_at);
}

// The page's orders under their day, the newest day first. A day can continue on
// the next page, so it is named but not totalled.
function byDay(orders: SaleOrder[]) {
  const days = new Map<string, SaleOrder[]>();

  for (const order of orders) {
    const day = paidDay(order);

    days.set(day, [...(days.get(day) ?? []), order]);
  }

  return [...days];
}

interface HistoryTableProps {
  /** The state of the request for the sales. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  /** The orders of the page being shown, newest first. */
  orders: SaleOrder[];
  onRetry: () => void;
}

export default function HistoryTable({
  error,
  onRetry,
  orders,
  status,
}: HistoryTableProps) {
  if (status === "pending") {
    return (
      <div className="space-y-2 rounded-xl border bg-card p-4" role="status">
        <span className="sr-only">Đang tải lịch sử bán hàng…</span>

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
          {error ?? "Không tải được lịch sử bán hàng."}
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
            <TableHead>Giờ</TableHead>

            <TableHead>Mã đơn</TableHead>

            <TableHead>Khách</TableHead>

            <TableHead>Hàng</TableHead>

            <TableHead>Người bán</TableHead>

            <TableHead>Thanh toán</TableHead>

            <TableHead className="text-right">Tổng</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {orders.length === 0 && (
            <TableRow>
              <TableCell
                className="py-10 text-center text-muted-foreground"
                colSpan={7}
              >
                Không có đơn nào trong khoảng này.
              </TableCell>
            </TableRow>
          )}

          {byDay(orders).map(([day, sales]) => (
            <Fragment key={day}>
              <TableRow className="bg-muted/50 hover:bg-muted/50">
                <TableCell className="font-medium capitalize" colSpan={7}>
                  {formatDayWithWeekday(`${day}T12:00:00+07:00`)}
                </TableCell>
              </TableRow>

              {sales.map((order) => (
                <TableRow key={order.reference}>
                  <TableCell className="text-muted-foreground tabular-nums">
                    {formatTime(order.paid_at ?? order.created_at)}
                  </TableCell>

                  <TableCell className="font-mono text-xs">
                    {order.reference}
                  </TableCell>

                  <TableCell>
                    <p>
                      {order.customer.username
                        ? `@${order.customer.username}`
                        : order.customer.first_name}
                    </p>
                  </TableCell>

                  <TableCell>
                    {order.item_title}
                    {order.quantity > 1 && (
                      <span className="text-muted-foreground">
                        {" "}
                        × {order.quantity}
                      </span>
                    )}
                  </TableCell>

                  <TableCell>{orderHandlerLabel(order)}</TableCell>

                  <TableCell>
                    {order.payment_method
                      ? paymentMethodLabels[order.payment_method]
                      : "—"}
                  </TableCell>

                  <TableCell className="text-right font-medium tabular-nums">
                    {formatVnd(order.total_vnd)}
                  </TableCell>
                </TableRow>
              ))}
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
