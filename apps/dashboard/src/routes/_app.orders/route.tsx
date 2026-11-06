import { useState } from "react";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Search } from "lucide-react";
import { toast } from "sonner";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import TablePagination from "@/components/table-pagination";
import { Input } from "@/components/ui/input";
import {
  ORDERS_PAGE_SIZE,
  ordersService,
} from "@/services/orders/orders-service";
import { sessionService } from "@/services/session/session-service";
import type {
  OrderStatusFilter,
  PaymentMethod,
  SaleOrder,
} from "@/services/sales/sales-types";
import useDebouncedValue from "@/utils/utils.debounced-value";

import OrderCancelDialog from "./order-cancel-dialog";
import OrderPayDialog from "./order-pay-dialog";
import OrdersStatusFilter from "./orders-status-filter";
import OrdersTable from "./orders-table";

// New orders arrive from Telegram all day, so the queue looks again by itself.
const REFRESH_MS = 15_000;

// What the open dialog is about; at most one is open at a time.
type OpenDialog = { kind: "pay" | "cancel"; order: SaleOrder };

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

export default function OrdersRoute() {
  const queryClient = useQueryClient();
  const session = useDashboardSession();
  const [status, setStatus] = useState<OrderStatusFilter>("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<OpenDialog | null>(null);

  const search = useDebouncedValue(query.trim());
  const orders = useQuery({
    // A role without the orders permission is shown the refusal, not an error.
    enabled: session.can("orders"),
    placeholderData: keepPreviousData,
    queryFn: () => ordersService.list({ page, query: search, status }),
    queryKey: [...ordersService.queryKey, { page, search, status }],
    refetchInterval: REFRESH_MS,
  });
  // Paying or cancelling moves an order between tabs, a sale into the history and
  // the takings, and takes stock, so everything but the session looks again.
  const refresh = () =>
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) => queryKey[1] !== sessionService.queryKey[1],
    });
  const pay = useMutation({
    mutationFn: ({
      method,
      order,
    }: {
      method: PaymentMethod;
      order: SaleOrder;
    }) => ordersService.pay(order.reference, method),
    onSettled: refresh,
  });
  const cancel = useMutation({
    mutationFn: (order: SaleOrder) => ordersService.cancel(order.reference),
    onSettled: refresh,
  });

  // Settling the last order of a page can leave the page beyond the end.
  const total = orders.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  if (orders.data && !orders.isPlaceholderData && page > lastPage)
    setPage(lastPage);

  // The queue is first come, first served, which is how the API lists it.
  const queue = status === "awaiting_payment";

  return (
    <PermissionGate permission="orders">
      <PageBody>
        <PageHeader
          description="Các đơn từ bot Telegram, đơn mới nhất nằm trên. Ở mục Chờ thanh toán, đơn chờ lâu nhất lên trước."
          title="Đơn hàng"
        />

        <OrdersStatusFilter
          counts={orders.data?.counts}
          value={status}
          onValueChange={(next) => {
            setStatus(next);
            setPage(1);
          }}
        />

        <div className="relative">
          <Search
            aria-hidden={true}
            className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />

          <Input
            aria-label="Tìm đơn"
            className="h-10 pl-9"
            placeholder="Tìm theo mã đơn, username hoặc tên hàng..."
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </div>

        <OrdersTable
          error={messageOf(orders.error) ?? null}
          now={new Date(orders.dataUpdatedAt)}
          orders={orders.data?.orders ?? []}
          queueStart={queue ? (page - 1) * ORDERS_PAGE_SIZE + 1 : null}
          status={orders.status}
          onCancel={(order) => setDialog({ kind: "cancel", order })}
          onPay={(order) => setDialog({ kind: "pay", order })}
          onRetry={() => void orders.refetch()}
        />

        <TablePagination
          page={page}
          pageSize={ORDERS_PAGE_SIZE}
          total={total}
          unit="đơn"
          onPageChange={setPage}
        />

        {dialog?.kind === "pay" && (
          <OrderPayDialog
            order={dialog.order}
            onClose={() => setDialog(null)}
            onPay={async (method) => {
              const { order } = dialog;

              try {
                const settled = await pay.mutateAsync({ method, order });

                setDialog(null);

                if (settled.notified) {
                  toast.success(`Đơn ${order.reference} đã thanh toán`, {
                    description: `Bot đã báo cho ${order.customer.username ? `@${order.customer.username}` : order.customer.first_name} trên Telegram.`,
                  });

                  return;
                }

                toast.warning(`Đơn ${order.reference} đã thanh toán`, {
                  description:
                    "Bot chưa báo được cho khách trên Telegram. Hãy nhắn cho khách.",
                });
              } catch (error) {
                toast.error("Không xác nhận được thanh toán", {
                  description: messageOf(error),
                });

                // The dialog stays, so the same order can be tried again.
                throw error;
              }
            }}
          />
        )}

        {dialog?.kind === "cancel" && (
          <OrderCancelDialog
            order={dialog.order}
            onClose={() => setDialog(null)}
            onCancel={async () => {
              const { order } = dialog;

              try {
                await cancel.mutateAsync(order);
              } catch (error) {
                toast.error("Không hủy được đơn", {
                  description: messageOf(error),
                });

                throw error;
              }

              setDialog(null);
              toast(`Đã hủy đơn ${order.reference}`, {
                description: "Hàng đang giữ cho đơn này được trả lại kho.",
              });
            }}
          />
        )}
      </PageBody>
    </PermissionGate>
  );
}
