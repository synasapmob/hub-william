import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type {
  OrderStatusFilter,
  PaymentMethod,
  SaleOrder,
} from "@/services/sales/sales-types";

type ApiOrder = components["schemas"]["DashboardOrder"];

export const ORDERS_PAGE_SIZE = 20;

export interface OrdersQuery {
  status: OrderStatusFilter;
  /** Matches the reference, the buyer's name and username, and the item. */
  query: string;
  /** Counted from 1. */
  page: number;
}

export interface OrdersPage {
  orders: SaleOrder[];
  /** How many orders each status has under the search, whatever status is shown. */
  counts: Record<OrderStatusFilter, number>;
  /** How many the status and the search match, across every page. */
  total: number;
}

export interface SettledOrder {
  order: SaleOrder;
  /** Whether the bot told the buyer. The order is paid either way. */
  notified: boolean;
}

export interface SalesQuery {
  /** `YYYY-MM-DD`, in shop time. */
  from: string;
  to: string;
  /** A username, `bot` for what SePay settled, or `all`. */
  seller: string;
  query: string;
  page: number;
}

export interface SalesPage {
  orders: SaleOrder[];
  /** Everyone who has sold something, whatever the filters. */
  sellers: string[];
  total: number;
  /** What every matching order comes to, not only this page. */
  total_vnd: number;
}

function orderFromApi(order: ApiOrder): SaleOrder {
  return {
    reference: order.reference,
    customer: {
      username: order.customer_username ?? null,
      first_name: order.customer_first_name,
    },
    item_title: order.item_title,
    quantity: order.quantity,
    total_vnd: order.total_vnd,
    status: order.status as SaleOrder["status"],
    payment_method: (order.payment_method as PaymentMethod | null) ?? null,
    handled_by: order.handled_by ?? null,
    created_at: order.created_at,
    expires_at: order.expires_at,
    paid_at: order.paid_at ?? null,
  };
}

/** The orders of the Telegram bot: the queue, and what has been sold. */
class OrdersService {
  readonly queryKey = ["dashboard", "orders"] as const;

  readonly salesQueryKey = ["dashboard", "sales"] as const;

  async list({ page, query, status }: OrdersQuery): Promise<OrdersPage> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/orders",
        {
          params: {
            query: {
              page,
              page_size: ORDERS_PAGE_SIZE,
              q: query.trim() || undefined,
              status: status === "all" ? undefined : status,
            },
          },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không tải được danh sách đơn.");

      return {
        counts: data.counts,
        orders: data.orders.map(orderFromApi),
        total: data.total,
      };
    });
  }

  /** Records that the money arrived, which takes the stock and tells the buyer. */
  async pay(
    reference: string,
    paymentMethod: PaymentMethod,
  ): Promise<SettledOrder> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/orders/{reference}/pay",
        {
          body: { payment_method: paymentMethod },
          params: { path: { reference } },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không xác nhận được thanh toán.");

      return { notified: data.notified, order: orderFromApi(data.order) };
    });
  }

  async cancel(reference: string): Promise<SaleOrder> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/dashboard/telegram/orders/{reference}/cancel",
        { params: { path: { reference } } },
      );

      if (!data) throw serviceError(response, error, "Không hủy được đơn.");

      return orderFromApi(data);
    });
  }

  /** Paid orders in a range of days, newest first. */
  async sales({
    from,
    page,
    query,
    seller,
    to,
  }: SalesQuery): Promise<SalesPage> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/dashboard/telegram/sales",
        {
          params: {
            query: {
              from,
              handled_by: seller === "all" ? undefined : seller,
              page,
              page_size: ORDERS_PAGE_SIZE,
              q: query.trim() || undefined,
              to,
            },
          },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không tải được lịch sử bán hàng.");

      return {
        orders: data.orders.map(orderFromApi),
        sellers: data.sellers,
        total: data.total,
        total_vnd: data.total_vnd,
      };
    });
  }
}

export const ordersService = new OrdersService();
