import { ServiceError } from "@/services/api/api-client";
import type {
  OrdersPage,
  OrdersQuery,
  SalesPage,
  SalesQuery,
  SettledOrder,
} from "@/services/orders/orders-service";
import type { PaymentMethod, SaleOrder } from "@/services/sales/sales-types";
import { shopDay } from "@/utils/utils.format";

const PAGE_SIZE = 20;

/** The account that settles an order in a test: the one `renderPage` signs in. */
export const SETTLED_BY = "minhanh";

let sequence = 0;

/**
 * An order as the API returns it: one awaiting payment, made 10 minutes ago and
 * good for 15, unless the test says otherwise. References never repeat.
 */
export function fakeOrder(overrides: Partial<SaleOrder> = {}): SaleOrder {
  sequence += 1;

  return {
    reference: `REF${String(sequence).padStart(9, "0")}`,
    customer: {
      username: `buyer_${sequence}`,
      first_name: `Buyer ${sequence}`,
    },
    item_title: "ChatGPT Plus 1 tháng (Full)",
    quantity: 1,
    total_vnd: 189_000,
    status: "awaiting_payment",
    payment_method: null,
    handled_by: null,
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    paid_at: null,
    ...overrides,
  };
}

/** The minutes before now an order was made, and how it ended up. */
function aged(minutesAgo: number, overrides: Partial<SaleOrder>) {
  const created = Date.now() - minutesAgo * 60_000;

  return fakeOrder({
    created_at: new Date(created).toISOString(),
    expires_at: new Date(created + 15 * 60_000).toISOString(),
    ...overrides,
  });
}

/**
 * A shop of 45 orders, newest first, 29 minutes apart: 10 awaiting payment,
 * 30 paid (6 by hand, the rest settled by SePay) and 5 cancelled.
 */
function defaultOrders() {
  const cycle = [
    "awaiting_payment",
    "paid",
    "paid",
    "paid",
    "awaiting_payment",
    "paid",
    "cancelled",
    "paid",
    "paid",
  ] as const;

  return Array.from({ length: 45 }, (_, index) => {
    const status = cycle[index % cycle.length];
    const minutesAgo = index * 29 + 8;

    if (status !== "paid") return aged(minutesAgo, { status });

    const byHand = index % 5 === 1;

    return aged(minutesAgo, {
      handled_by: byHand ? "thuha" : null,
      paid_at: new Date(
        Date.now() - minutesAgo * 60_000 + 120_000,
      ).toISOString(),
      payment_method: byHand ? "cash" : "bank_transfer",
      status,
    });
  });
}

let orders: SaleOrder[] = [];

/** Puts the shop back as every test starts, counting from the clock as it is now. */
export function resetFakeOrders() {
  sequence = 0;
  orders = defaultOrders();
}

/** Replaces every order, for a test that needs a shop of its own. */
export function setFakeOrders(next: SaleOrder[]) {
  orders = next;
}

function find(reference: string) {
  const order = orders.find((candidate) => candidate.reference === reference);

  if (!order)
    throw new ServiceError(
      "The requested resource was not found.",
      404,
      "not_found",
    );

  return order;
}

function waiting(reference: string) {
  const order = find(reference);

  if (order.status !== "awaiting_payment")
    throw new ServiceError(
      "That order is not waiting for payment.",
      422,
      "validation_error",
    );

  return order;
}

function matches(order: SaleOrder, query: string) {
  const needle = query.trim().toLowerCase();

  return (
    needle === "" ||
    [
      order.reference,
      order.customer.username ?? "",
      order.customer.first_name,
      order.item_title,
    ].some((field) => field.toLowerCase().includes(needle))
  );
}

/**
 * The orders service as the server would behave, kept in memory: the same
 * filters, order, paging and refusals. A test replaces one method with a spy to
 * see what was asked, or to make it fail.
 */
export const fakeOrdersService = {
  queryKey: ["dashboard", "orders"] as const,

  salesQueryKey: ["dashboard", "sales"] as const,

  async list({ page, query, status }: OrdersQuery): Promise<OrdersPage> {
    const matching = orders.filter((order) => matches(order, query));
    const count = (wanted: SaleOrder["status"]) =>
      matching.filter((order) => order.status === wanted).length;
    // The queue is first come, first served; everything else is newest first.
    const direction = status === "awaiting_payment" ? 1 : -1;
    const shown = matching
      .filter((order) => status === "all" || order.status === status)
      .sort((a, b) => direction * a.created_at.localeCompare(b.created_at));

    return structuredClone({
      counts: {
        all: matching.length,
        awaiting_payment: count("awaiting_payment"),
        cancelled: count("cancelled"),
        paid: count("paid"),
      },
      orders: shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      total: shown.length,
    });
  },

  async pay(
    reference: string,
    paymentMethod: PaymentMethod,
  ): Promise<SettledOrder> {
    const order = waiting(reference);

    Object.assign(order, {
      handled_by: SETTLED_BY,
      paid_at: new Date().toISOString(),
      payment_method: paymentMethod,
      status: "paid",
    });

    return structuredClone({ notified: true, order });
  },

  async cancel(reference: string): Promise<SaleOrder> {
    const order = waiting(reference);

    Object.assign(order, { handled_by: SETTLED_BY, status: "cancelled" });

    return structuredClone(order);
  },

  async sales({
    from,
    page,
    query,
    seller,
    to,
  }: SalesQuery): Promise<SalesPage> {
    const paid = orders.filter((order) => order.status === "paid");
    const shown = paid
      .filter((order) => {
        const day = shopDay(order.paid_at ?? order.created_at);

        return (
          day >= from &&
          day <= to &&
          matches(order, query) &&
          (seller === "all" ||
            (seller === "bot"
              ? order.handled_by === null
              : order.handled_by === seller))
        );
      })
      .sort((a, b) => (b.paid_at ?? "").localeCompare(a.paid_at ?? ""));

    return structuredClone({
      orders: shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      sellers: [
        ...new Set(paid.flatMap((order) => order.handled_by ?? [])),
      ].sort(),
      total: shown.length,
      total_vnd: shown.reduce((sum, order) => sum + order.total_vnd, 0),
    });
  },
};
