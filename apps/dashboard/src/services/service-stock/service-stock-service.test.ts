import { afterEach, describe, expect, it, vi } from "vitest";

import { answer, json, sent } from "@/test/mock-fetch";

import { serviceStockService } from "./service-stock-service";

const ID = "3f2b8c1e-6d4a-4b7e-9a10-2c5d7e8f9a0b";
const CONNECTION_ID = "7a1c3b5d-9e2f-4a6b-8c0d-1e2f3a4b5c6d";

const API_METRIC = {
  detail: "resets in 2h",
  label: "5-hour limit",
  value: "80% left",
};

const API_LISTING = {
  account_label: "Shop Claude",
  created_at: "2026-11-05T03:00:00Z",
  days: 7,
  id: ID,
  listed: true,
  name: "Claude Max 5x · 7 ngày",
  plan: "Max 5x",
  price_micro: 4_000_000,
  provider: "claude",
  quota: [API_METRIC, { label: "Weekly limit", value: "50% left" }],
  quota_captured_at: "2026-11-06T02:30:00Z",
  seller: "minhanh",
  status: "for_sale",
};

const API_VERIFIED = {
  account_label: "Shop Claude",
  captured_at: "2026-11-06T02:30:00Z",
  plan: "Max 5x",
  provider: "claude",
  quota: [API_METRIC],
};

const API_SALE = {
  buyer: "quocbao",
  days: 7,
  expires_at: "2026-11-13T02:30:00Z",
  id: ID,
  key_last_four: "ab12",
  name: "Claude Max 5x · 7 ngày",
  price_micro: 4_000_000,
  provider: "claude",
  seller: "minhanh",
  sold_at: "2026-11-06T02:30:00Z",
};

const TERMS = {
  days: 7,
  name: "Claude Max 5x · 7 ngày",
  price_micro: 4_000_000,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("serviceStockService.listings", () => {
  it("answers the tickets that are not sold, as the page uses them", async () => {
    const spy = answer(json(200, { listings: [API_LISTING] }));

    const listings = await serviceStockService.listings();

    const request = await sent(spy);

    expect(request.method).toBe("GET");
    expect(request.path).toBe("/dashboard/service/listings");
    expect(request.credentials).toBe("include");
    expect(listings).toEqual([
      {
        account_label: "Shop Claude",
        created_at: "2026-11-05T03:00:00Z",
        days: 7,
        id: ID,
        listed: true,
        name: "Claude Max 5x · 7 ngày",
        plan: "Max 5x",
        price_micro: 4_000_000,
        provider: "claude",
        quota: [
          {
            detail: "resets in 2h",
            label: "5-hour limit",
            value: "80% left",
          },
          { detail: null, label: "Weekly limit", value: "50% left" },
        ],
        quota_captured_at: "2026-11-06T02:30:00Z",
        seller: "minhanh",
        status: "for_sale",
      },
    ]);
  });

  it("fills in what the API leaves out", async () => {
    answer(
      json(200, {
        listings: [
          {
            ...API_LISTING,
            account_label: null,
            plan: null,
            quota: [],
            quota_captured_at: null,
            seller: null,
          },
        ],
      }),
    );

    const [listing] = await serviceStockService.listings();

    expect(listing).toMatchObject({
      account_label: null,
      plan: null,
      quota: [],
      quota_captured_at: null,
      seller: null,
    });
  });

  it("fails with the API's message", async () => {
    answer(json(500, { code: "internal_error", message: "Oops." }));

    await expect(serviceStockService.listings()).rejects.toMatchObject({
      message: "Oops.",
      status: 500,
    });
  });

  it("says the server cannot be reached when it cannot", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(serviceStockService.listings()).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});

describe("serviceStockService.verify", () => {
  it("asks about the connection, and answers the account with what it has left", async () => {
    const spy = answer(json(200, API_VERIFIED));

    const verified = await serviceStockService.verify(CONNECTION_ID);

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/service/verify");
    expect(JSON.parse(String(request.body))).toEqual({
      connection_id: CONNECTION_ID,
    });
    expect(verified).toEqual({
      account_label: "Shop Claude",
      captured_at: "2026-11-06T02:30:00Z",
      plan: "Max 5x",
      provider: "claude",
      quota: [
        { detail: "resets in 2h", label: "5-hour limit", value: "80% left" },
      ],
    });
  });

  it.each([
    [
      422,
      "validation_error",
      "That account is not one you connected yourself.",
    ],
    [
      502,
      "provider_unavailable",
      "The claude account did not answer a test request: the provider answered 401",
    ],
  ])(
    "fails with the API's own words when it answers %i",
    async (status, code, message) => {
      answer(json(status, { code, message }));

      await expect(
        serviceStockService.verify(CONNECTION_ID),
      ).rejects.toMatchObject({ code, message, status });
    },
  );
});

describe("serviceStockService.addListing", () => {
  it("sends the account and the terms, and answers the ticket", async () => {
    const spy = answer(json(201, API_LISTING));

    const listing = await serviceStockService.addListing(CONNECTION_ID, TERMS);

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/service/listings");
    expect(JSON.parse(String(request.body))).toEqual({
      connection_id: CONNECTION_ID,
      ...TERMS,
    });
    expect(listing.id).toBe(ID);
  });

  it.each([
    [
      409,
      "already_exists",
      "That account is on sale already, or sold to a customer whose ticket has not ended.",
    ],
    [422, "validation_error", "The days must be 1 to 365."],
    [502, "provider_unavailable", "The claude account did not answer."],
  ])(
    "fails with the API's own words when it answers %i",
    async (status, code, message) => {
      answer(json(status, { code, message }));

      await expect(
        serviceStockService.addListing(CONNECTION_ID, TERMS),
      ).rejects.toMatchObject({ code, message, status });
    },
  );
});

describe("serviceStockService.updateListing", () => {
  it("puts the change to that ticket and answers it as it is now", async () => {
    const spy = answer(
      json(200, { ...API_LISTING, listed: false, status: "hidden" }),
    );

    const listing = await serviceStockService.updateListing(ID, {
      ...TERMS,
      listed: false,
    });

    const request = await sent(spy);

    expect(request.method).toBe("PUT");
    expect(request.path).toBe(`/dashboard/service/listings/${ID}`);
    expect(JSON.parse(String(request.body))).toEqual({
      ...TERMS,
      listed: false,
    });
    expect(listing).toMatchObject({ listed: false, status: "hidden" });
  });

  it("fails with the API's message when the ticket is sold or gone", async () => {
    answer(
      json(404, {
        code: "not_found",
        message: "The requested resource was not found.",
      }),
    );

    await expect(
      serviceStockService.updateListing(ID, { ...TERMS, listed: true }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("serviceStockService.removeListing", () => {
  it("deletes the ticket", async () => {
    const spy = answer(new Response(null, { status: 204 }));

    await expect(
      serviceStockService.removeListing(ID),
    ).resolves.toBeUndefined();

    const request = await sent(spy);

    expect(request.method).toBe("DELETE");
    expect(request.path).toBe(`/dashboard/service/listings/${ID}`);
  });

  it("fails with the API's message when there is no such ticket", async () => {
    answer(
      json(404, {
        code: "not_found",
        message: "The requested resource was not found.",
      }),
    );

    await expect(
      serviceStockService.removeListing("gone"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("serviceStockService.sales", () => {
  it("answers the tickets that were sold, as the history uses them", async () => {
    const spy = answer(json(200, { sales: [API_SALE] }));

    const sales = await serviceStockService.sales();

    expect((await sent(spy)).path).toBe("/dashboard/service/sales");
    expect(sales).toEqual([
      {
        buyer: "quocbao",
        days: 7,
        expires_at: "2026-11-13T02:30:00Z",
        id: ID,
        key_last_four: "ab12",
        name: "Claude Max 5x · 7 ngày",
        price_micro: 4_000_000,
        provider: "claude",
        seller: "minhanh",
        sold_at: "2026-11-06T02:30:00Z",
      },
    ]);
  });

  it("fills in a buyer, a seller or a key that is gone", async () => {
    answer(
      json(200, {
        sales: [
          {
            ...API_SALE,
            buyer: null,
            expires_at: null,
            key_last_four: null,
            seller: null,
          },
        ],
      }),
    );

    const [sale] = await serviceStockService.sales();

    expect(sale).toMatchObject({
      buyer: null,
      expires_at: null,
      key_last_four: null,
      seller: null,
    });
  });

  it("fails with the API's message", async () => {
    answer(json(403, { code: "forbidden", message: "Not for your role." }));

    await expect(serviceStockService.sales()).rejects.toMatchObject({
      message: "Not for your role.",
      status: 403,
    });
  });
});
