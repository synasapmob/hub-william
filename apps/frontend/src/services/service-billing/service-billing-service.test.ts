import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ServiceBillingError,
  serviceBillingService,
} from "./service-billing-service";

const apiWallet = { wallet_micro: 2_000_000 };

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input));
}

async function bodyOf(input: RequestInfo | URL) {
  return input instanceof Request ? await input.clone().json() : null;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("serviceBillingService", () => {
  it("reads the public price list by agent and maps it to camelCase", async () => {
    const price = {
      cached_micro_per_million: 60_000,
      input_micro_per_million: 600_000,
      output_micro_per_million: 4_700_000,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          currency: "USD",
          providers: [
            {
              label: "ChatGPT",
              models: [{ id: "gpt-test", name: "GPT Test", price }],
              provider: "chatgpt",
            },
            {
              label: "Gemini",
              models: [{ id: "gemini-test", name: "gemini-test", price }],
              provider: "gemini",
            },
          ],
          min_balance_micro: 50_000,
          test_top_up: true,
          card_top_up: false,
        }),
      ),
    );

    const pricing = await serviceBillingService.pricing();

    expect(pricing.testTopUp).toBe(true);
    expect(pricing.cardTopUp).toBe(false);
    expect(pricing.providers.map((provider) => provider.provider)).toEqual([
      "chatgpt",
      "gemini",
    ]);
    expect(pricing.minBalanceMicro).toBe(50_000);
    expect(pricing.providers[0].models[0]).toEqual({
      id: "gpt-test",
      name: "GPT Test",
      price: {
        cachedMicroPerMillion: 60_000,
        inputMicroPerMillion: 600_000,
        outputMicroPerMillion: 4_700_000,
      },
    });
  });

  it("maps the wallet", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(apiWallet)));

    await expect(serviceBillingService.wallet()).resolves.toEqual({
      walletMicro: 2_000_000,
    });
  });

  it("says whether a top up is paid by card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          currency: "USD",
          providers: [],
          min_balance_micro: 50_000,
          test_top_up: false,
          card_top_up: true,
        }),
      ),
    );

    const pricing = await serviceBillingService.pricing();

    expect(pricing.cardTopUp).toBe(true);
    expect(pricing.testTopUp).toBe(false);
  });

  it("returns where to pay when a top up is paid by card", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          wallet_micro: 2_000_000,
          checkout_url: "https://checkout.stripe.test/c/pay/cs_test_a1",
        }),
      ),
    );

    await expect(serviceBillingService.topUp(10_000_000)).resolves.toEqual({
      checkoutUrl: "https://checkout.stripe.test/c/pay/cs_test_a1",
      walletMicro: 2_000_000,
    });
  });

  it("returns no checkout when a test top up credited the wallet at once", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ wallet_micro: 7_000_000, checkout_url: null }),
        ),
    );

    await expect(serviceBillingService.topUp(5_000_000)).resolves.toEqual({
      checkoutUrl: null,
      walletMicro: 7_000_000,
    });
  });

  it("sends the amount of a top up", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ wallet_micro: 5_000_000, checkout_url: null }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await serviceBillingService.topUp(5_000_000);

    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual(["/service/top-up"]);
    await expect(bodyOf(fetchMock.mock.calls[0][0])).resolves.toEqual({
      amount_micro: 5_000_000,
    });
  });

  it("reports the API message when a top up is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: "not_available",
            message: "Top up is not available yet.",
          },
          501,
        ),
      ),
    );

    await expect(serviceBillingService.topUp(5_000_000)).rejects.toThrow(
      "Top up is not available yet.",
    );
  });

  it("repeats a call once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse(apiWallet));
    vi.stubGlobal("fetch", fetchMock);

    await expect(serviceBillingService.wallet()).resolves.toMatchObject({
      walletMicro: 2_000_000,
    });
    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual(["/service/wallet", "/auth/refresh", "/service/wallet"]);
  });

  it("replaces a network failure with the unavailable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const failure = serviceBillingService.wallet();

    await expect(failure).rejects.toBeInstanceOf(ServiceBillingError);
    await expect(failure).rejects.toThrow("The service is unavailable.");
  });
});

const apiListing = {
  days: 7,
  id: "11111111-1111-4111-8111-111111111111",
  name: "Claude Max · 7 ngày",
  price_micro: 4_000_000,
  quota: [
    { detail: "resets in 2h", label: "5-hour limit", value: "80% left" },
    { label: "Weekly limit", value: "50% left" },
  ],
  quota_captured_at: "2026-11-06T09:30:00Z",
};

const apiPurchased = {
  days: 7,
  expires_at: "2026-11-13T09:30:00Z",
  key: "hw_tkt_fake-not-a-secret",
  key_id: "22222222-2222-4222-8222-222222222222",
  last_four: "cret",
  name: "Claude Max · 7 ngày",
  price_micro: 4_000_000,
  provider: "claude",
};

describe("serviceBillingService, tickets", () => {
  it("reads the tickets for sale by agent, public, and maps them to camelCase", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({
          providers: [
            { label: "Claude", listings: [apiListing], provider: "claude" },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const providers = await serviceBillingService.ticketListings();

    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual(["/service/listings"]);
    expect(providers).toEqual([
      {
        label: "Claude",
        listings: [
          {
            days: 7,
            id: apiListing.id,
            name: "Claude Max · 7 ngày",
            priceMicro: 4_000_000,
            quota: [
              {
                detail: "resets in 2h",
                label: "5-hour limit",
                value: "80% left",
              },
              { detail: null, label: "Weekly limit", value: "50% left" },
            ],
            quotaCapturedAt: "2026-11-06T09:30:00Z",
          },
        ],
        provider: "claude",
      },
    ]);
  });

  it("has no agents when nothing is for sale", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ providers: [] })),
    );

    await expect(serviceBillingService.ticketListings()).resolves.toEqual([]);
  });

  it("leaves out a quota the provider does not give", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          providers: [
            {
              label: "DeepSeek",
              listings: [
                { ...apiListing, quota: [], quota_captured_at: undefined },
              ],
              provider: "deepseek",
            },
          ],
        }),
      ),
    );

    const [provider] = await serviceBillingService.ticketListings();

    expect(provider.listings[0]).toMatchObject({
      quota: [],
      quotaCapturedAt: null,
    });
  });

  it("buys a ticket and answers its key, which is shown this once", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(jsonResponse(apiPurchased, 201));
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await serviceBillingService.purchaseTicket(apiListing.id);

    const request = fetchMock.mock.calls[0][0] as Request;

    expect(request.method).toBe("POST");
    expect(urlOf(request).pathname).toBe(
      `/service/listings/${apiListing.id}/purchase`,
    );
    expect(request.credentials).toBe("include");
    expect(ticket).toEqual({
      days: 7,
      expiresAt: "2026-11-13T09:30:00Z",
      key: "hw_tkt_fake-not-a-secret",
      keyId: apiPurchased.key_id,
      lastFour: "cret",
      name: "Claude Max · 7 ngày",
      priceMicro: 4_000_000,
      provider: "claude",
    });
  });

  it.each([
    [402, "insufficient_balance", "Your balance is too low."],
    [404, "not_found", "The requested resource was not found."],
    [
      502,
      "provider_unavailable",
      "The claude account did not answer a test request: the provider answered 401",
    ],
    [422, "validation_error", "You cannot buy your own ticket."],
  ])(
    "rejects with the API's words and its status when a purchase answers %i",
    async (status, code, message) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(jsonResponse({ code, message }, status)),
      );

      const failure = serviceBillingService.purchaseTicket(apiListing.id);

      await expect(failure).rejects.toBeInstanceOf(ServiceBillingError);
      await expect(failure).rejects.toMatchObject({ message, status });
    },
  );

  it("repeats a purchase once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse(apiPurchased, 201));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      serviceBillingService.purchaseTicket(apiListing.id),
    ).resolves.toMatchObject({ lastFour: "cret" });
    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual([
      `/service/listings/${apiListing.id}/purchase`,
      "/auth/refresh",
      `/service/listings/${apiListing.id}/purchase`,
    ]);
  });

  it("reads the tickets the user bought, without their keys", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          tickets: [
            {
              days: 7,
              expires_at: "2026-11-13T09:30:00Z",
              key_id: apiPurchased.key_id,
              last_four: "cret",
              name: "Claude Max · 7 ngày",
              price_micro: 4_000_000,
              provider: "claude",
              purchased_at: "2026-11-06T09:30:00Z",
              status: "active",
            },
            {
              days: 3,
              expires_at: "2026-11-01T09:30:00Z",
              key_id: "33333333-3333-4333-8333-333333333333",
              last_four: "abcd",
              name: "Claude Pro · 3 ngày",
              price_micro: 1_500_000,
              provider: "claude",
              purchased_at: "2026-10-29T09:30:00Z",
              status: "expired",
            },
          ],
        }),
      ),
    );

    const tickets = await serviceBillingService.ownedTickets();

    expect(tickets.map((ticket) => ticket.status)).toEqual([
      "active",
      "expired",
    ]);
    expect(tickets[0]).toEqual({
      days: 7,
      expiresAt: "2026-11-13T09:30:00Z",
      keyId: apiPurchased.key_id,
      lastFour: "cret",
      name: "Claude Max · 7 ngày",
      priceMicro: 4_000_000,
      provider: "claude",
      purchasedAt: "2026-11-06T09:30:00Z",
      status: "active",
    });
    expect(JSON.stringify(tickets)).not.toContain("hw_tkt_");
  });

  it("asks for a new key for a ticket, and answers it", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(jsonResponse(apiPurchased));
    vi.stubGlobal("fetch", fetchMock);

    const ticket = await serviceBillingService.reissueTicket(
      apiPurchased.key_id,
    );

    const request = fetchMock.mock.calls[0][0] as Request;

    expect(request.method).toBe("POST");
    expect(urlOf(request).pathname).toBe(
      `/service/tickets/${apiPurchased.key_id}/reissue`,
    );
    expect(ticket.key).toBe("hw_tkt_fake-not-a-secret");
  });

  it("rejects when there is no such ticket to replace the key of", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ code: "not_found", message: "Gone." }, 404),
        ),
    );

    await expect(
      serviceBillingService.reissueTicket(apiPurchased.key_id),
    ).rejects.toMatchObject({ message: "Gone.", status: 404 });
  });

  it("replaces a network failure with the unavailable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(
      serviceBillingService.purchaseTicket(apiListing.id),
    ).rejects.toThrow("The service is unavailable.");
    await expect(serviceBillingService.ticketListings()).rejects.toThrow(
      "The service is unavailable.",
    );
  });
});
