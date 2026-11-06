import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import { answer, json, sent } from "@/test/mock-fetch";

import { ordersService } from "./orders-service";

const API_ORDER = {
  created_at: "2026-11-05T14:00:00Z",
  customer_first_name: "Thành",
  customer_username: "thanh_tran_92",
  expires_at: "2026-11-05T14:15:00Z",
  handled_by: "thuha",
  item_title: "Claude Pro 1 tháng",
  paid_at: "2026-11-05T14:05:00Z",
  payment_method: "cash",
  quantity: 2,
  reference: "AB12CD34EF56",
  status: "paid",
  total_vnd: 918_000,
  unit_price_vnd: 459_000,
};

const ORDER = {
  created_at: "2026-11-05T14:00:00Z",
  customer: { first_name: "Thành", username: "thanh_tran_92" },
  expires_at: "2026-11-05T14:15:00Z",
  handled_by: "thuha",
  item_title: "Claude Pro 1 tháng",
  paid_at: "2026-11-05T14:05:00Z",
  payment_method: "cash",
  quantity: 2,
  reference: "AB12CD34EF56",
  status: "paid",
  total_vnd: 918_000,
};

// What the API leaves out of an order nobody has dealt with yet.
const API_WAITING = {
  created_at: "2026-11-05T14:00:00Z",
  customer_first_name: "Lan Anh",
  expires_at: "2026-11-05T14:15:00Z",
  item_title: "ChatGPT Plus 1 tháng (Full)",
  quantity: 1,
  reference: "ZZ99YY88XX77",
  status: "awaiting_payment",
  total_vnd: 189_000,
  unit_price_vnd: 189_000,
};

const REFUSED = {
  code: "validation_error",
  message: "That order is not waiting for payment.",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ordersService.list", () => {
  it("asks for one page of a status under a search, 20 to a page", async () => {
    const spy = answer(
      json(200, {
        counts: { all: 3, awaiting_payment: 1, cancelled: 1, paid: 1 },
        orders: [],
        total: 1,
      }),
    );

    await ordersService.list({
      page: 2,
      query: "  thanh ",
      status: "awaiting_payment",
    });

    const request = await sent(spy);

    expect(request.method).toBe("GET");
    expect(request.path).toBe("/dashboard/telegram/orders");
    expect(request.credentials).toBe("include");
    expect(Object.fromEntries(request.query)).toEqual({
      page: "2",
      page_size: "20",
      q: "thanh",
      status: "awaiting_payment",
    });
  });

  it("leaves the status and the search out when there is none", async () => {
    const spy = answer(
      json(200, {
        counts: { all: 0, awaiting_payment: 0, cancelled: 0, paid: 0 },
        orders: [],
        total: 0,
      }),
    );

    await ordersService.list({ page: 1, query: "   ", status: "all" });

    expect([...(await sent(spy)).query.keys()].sort()).toEqual([
      "page",
      "page_size",
    ]);
  });

  it("answers the orders as the pages use them, the counts and the total", async () => {
    answer(
      json(200, {
        counts: { all: 7, awaiting_payment: 2, cancelled: 1, paid: 4 },
        orders: [API_ORDER, API_WAITING],
        total: 7,
      }),
    );

    const page = await ordersService.list({
      page: 1,
      query: "",
      status: "all",
    });

    expect(page.counts).toEqual({
      all: 7,
      awaiting_payment: 2,
      cancelled: 1,
      paid: 4,
    });
    expect(page.total).toBe(7);
    expect(page.orders[0]).toEqual(ORDER);
    // A buyer with no username, an order nobody has handled: nulls, not holes.
    expect(page.orders[1]).toMatchObject({
      customer: { first_name: "Lan Anh", username: null },
      handled_by: null,
      paid_at: null,
      payment_method: null,
    });
  });

  it("fails with the API's message, and its status", async () => {
    answer(
      json(403, { code: "forbidden", message: "Your role cannot do that." }),
    );

    await expect(
      ordersService.list({ page: 1, query: "", status: "all" }),
    ).rejects.toMatchObject({
      code: "forbidden",
      message: "Your role cannot do that.",
      status: 403,
    });
  });

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(
      ordersService.list({ page: 1, query: "", status: "all" }),
    ).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});

describe("ordersService.pay", () => {
  it("posts the way the money arrived, and answers the order and whether the buyer was told", async () => {
    const spy = answer(json(200, { notified: false, order: API_ORDER }));

    const settled = await ordersService.pay("AB12CD34EF56", "cash");

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/telegram/orders/AB12CD34EF56/pay");
    expect(JSON.parse(String(request.body))).toEqual({
      payment_method: "cash",
    });
    expect(settled).toEqual({ notified: false, order: ORDER });
  });

  it("fails with the API's message when the order is no longer waiting", async () => {
    answer(json(422, REFUSED));

    await expect(ordersService.pay("AB12CD34EF56", "usdt")).rejects.toEqual(
      expect.objectContaining({
        code: "validation_error",
        message: "That order is not waiting for payment.",
        status: 422,
      }),
    );
  });

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(
      ordersService.pay("AB12CD34EF56", "bank_transfer"),
    ).rejects.toBeInstanceOf(ServiceError);
  });
});

describe("ordersService.cancel", () => {
  it("posts to the order and answers it as cancelled", async () => {
    const spy = answer(
      json(200, { ...API_WAITING, handled_by: "thuha", status: "cancelled" }),
    );

    const order = await ordersService.cancel("ZZ99YY88XX77");

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/telegram/orders/ZZ99YY88XX77/cancel");
    expect(order).toMatchObject({
      handled_by: "thuha",
      reference: "ZZ99YY88XX77",
      status: "cancelled",
    });
  });

  it("fails with the API's message", async () => {
    answer(json(422, REFUSED));

    await expect(ordersService.cancel("ZZ99YY88XX77")).rejects.toMatchObject({
      message: "That order is not waiting for payment.",
      status: 422,
    });
  });
});

describe("ordersService.sales", () => {
  const range = { from: "2026-10-30", to: "2026-11-05" };

  it("asks for a range of shop days, a seller and a search, 20 to a page", async () => {
    const spy = answer(
      json(200, { orders: [], sellers: [], total: 0, total_vnd: 0 }),
    );

    await ordersService.sales({
      ...range,
      page: 3,
      query: " claude ",
      seller: "thuha",
    });

    const request = await sent(spy);

    expect(request.path).toBe("/dashboard/telegram/sales");
    expect(Object.fromEntries(request.query)).toEqual({
      from: "2026-10-30",
      handled_by: "thuha",
      page: "3",
      page_size: "20",
      q: "claude",
      to: "2026-11-05",
    });
  });

  it("passes what SePay settled as bot, and every seller as nothing", async () => {
    const bot = answer(
      json(200, { orders: [], sellers: [], total: 0, total_vnd: 0 }),
    );

    await ordersService.sales({ ...range, page: 1, query: "", seller: "bot" });

    expect((await sent(bot)).query.get("handled_by")).toBe("bot");

    vi.restoreAllMocks();

    const all = answer(
      json(200, { orders: [], sellers: [], total: 0, total_vnd: 0 }),
    );

    await ordersService.sales({ ...range, page: 1, query: "", seller: "all" });

    expect((await sent(all)).query.has("handled_by")).toBe(false);
  });

  it("answers the sales, the sellers, and what every match comes to", async () => {
    answer(
      json(200, {
        orders: [API_ORDER],
        sellers: ["quocbao", "thuha"],
        total: 41,
        total_vnd: 7_650_000,
      }),
    );

    expect(
      await ordersService.sales({
        ...range,
        page: 1,
        query: "",
        seller: "all",
      }),
    ).toEqual({
      orders: [ORDER],
      sellers: ["quocbao", "thuha"],
      total: 41,
      total_vnd: 7_650_000,
    });
  });

  it("fails with the API's message", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "A range cannot end before it starts.",
      }),
    );

    await expect(
      ordersService.sales({ ...range, page: 1, query: "", seller: "all" }),
    ).rejects.toMatchObject({
      message: "A range cannot end before it starts.",
      status: 422,
    });
  });
});
