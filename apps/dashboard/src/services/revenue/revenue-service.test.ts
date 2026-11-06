import { afterEach, describe, expect, it, vi } from "vitest";

import { answer, json, sent } from "@/test/mock-fetch";

import { revenueService } from "./revenue-service";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("revenueService.get", () => {
  it("asks for the period in days", async () => {
    const spy = answer(
      json(200, { by_seller: [], daily: [], days: 14, top_items: [] }),
    );

    await revenueService.get(14);

    const request = await sent(spy);

    expect(request.method).toBe("GET");
    expect(request.path).toBe("/dashboard/telegram/revenue");
    expect(request.credentials).toBe("include");
    expect(request.query.get("days")).toBe("14");
  });

  it("answers the days with their takings, the best sellers and the sellers", async () => {
    answer(
      json(200, {
        by_seller: [
          { orders: 5, seller: "thuha", total_vnd: 900_000 },
          // What SePay settled comes without a seller.
          { orders: 14, total_vnd: 2_100_000 },
        ],
        daily: [
          { date: "2026-10-30", orders: 0, total_vnd: 0 },
          { date: "2026-10-31", orders: 3, total_vnd: 567_000 },
        ],
        days: 7,
        top_items: [
          { orders: 9, title: "ChatGPT Plus 1 tháng", total_vnd: 1_701_000 },
        ],
      }),
    );

    expect(await revenueService.get(7)).toEqual({
      by_seller: [
        { orders: 5, seller: "thuha", total_vnd: 900_000 },
        { orders: 14, seller: null, total_vnd: 2_100_000 },
      ],
      daily: [
        { date: "2026-10-30", orders: 0, total: 0 },
        { date: "2026-10-31", orders: 3, total: 567_000 },
      ],
      days: 7,
      top_items: [
        { orders: 9, title: "ChatGPT Plus 1 tháng", total_vnd: 1_701_000 },
      ],
    });
  });

  it("fails with the API's message, and its status", async () => {
    answer(
      json(403, { code: "forbidden", message: "Your role cannot do that." }),
    );

    await expect(revenueService.get(7)).rejects.toMatchObject({
      message: "Your role cannot do that.",
      status: 403,
    });
  });

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(revenueService.get(30)).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});
