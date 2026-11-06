import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import type { Revenue, RevenueDays } from "@/services/revenue/revenue-service";
import { money } from "@/test/format-money";
import renderPage from "@/test/render-page";

import RevenueRoute from "./route";

// The page talks to the server through this service; a test answers for it.
const get = vi.hoisted(() => vi.fn());

vi.mock("@/services/revenue/revenue-service", () => ({
  revenueService: { get, queryKey: ["dashboard", "revenue"] },
}));

/** `days` days of takings, then the same number before them, oldest first. */
function revenue(days: RevenueDays): Revenue {
  return {
    by_seller: [
      { orders: 5, seller: "thuha", total_vnd: 900_000 },
      { orders: 14, seller: null, total_vnd: 2_100_000 },
    ],
    daily: Array.from({ length: days * 2 }, (_, index) => ({
      // The period before earns 100.000 ₫ a day, the period shown 200.000 ₫.
      date: new Date(Date.UTC(2026, 8, 1 + index)).toISOString().slice(0, 10),
      orders: index < days ? 1 : 2,
      total: index < days ? 100_000 : 200_000,
    })),
    days,
    top_items: [
      { orders: 9, title: "ChatGPT Plus 1 tháng (Full)", total_vnd: 1_701_000 },
      { orders: 4, title: "Claude Pro 1 tháng", total_vnd: 1_836_000 },
    ],
  };
}

// The label of a figure above the chart. The same words head columns below, and
// the page title, so only a paragraph is one; it also shows once the data is in.
const figure = (label: string) =>
  screen
    .findByText(label, { selector: "p" })
    .then((element) => element.nextElementSibling);

beforeEach(() => {
  vi.resetAllMocks();
  get.mockImplementation(async (days: RevenueDays) => revenue(days));
});

describe("RevenueRoute", () => {
  it("asks for 7 days and shows what they took against the 7 before", async () => {
    renderPage(<RevenueRoute />);

    // 7 days of 200.000 ₫, up 100% on 7 days of 100.000 ₫.
    expect(await figure("Doanh thu")).toHaveTextContent(money(1_400_000));
    expect(get).toHaveBeenCalledWith(7);
    expect(screen.getAllByText(/\+100,0% so với kỳ trước/).length).toBe(2);
    expect(await figure("Số đơn")).toHaveTextContent("14");
  });

  it("asks again for another period and compares it with the one before that", async () => {
    const user = userEvent.setup();

    renderPage(<RevenueRoute />);
    await figure("Doanh thu");
    await user.click(screen.getByRole("combobox", { name: "Kỳ báo cáo" }));
    await user.click(screen.getByRole("option", { name: "30 ngày qua" }));

    await waitFor(() => expect(get).toHaveBeenLastCalledWith(30));
    // 30 days of 200.000 ₫.
    await waitFor(async () =>
      expect(await figure("Doanh thu")).toHaveTextContent(money(6_000_000)),
    );
  });

  it("lists the best sellers and the sellers, SePay among them", async () => {
    renderPage(<RevenueRoute />);

    const best = (await screen.findByText("Bán chạy nhất (theo số đơn)"))
      .parentElement as HTMLElement;
    const sellers = screen.getByText("Theo người bán")
      .parentElement as HTMLElement;

    expect(within(best).getByText("ChatGPT Plus 1 tháng (Full)")).toBeVisible();
    expect(within(best).getByText(money(1_701_000))).toBeVisible();
    expect(within(sellers).getByText("thuha")).toBeVisible();
    expect(within(sellers).getByText("SePay (tự động)")).toBeVisible();
    expect(within(sellers).getByText("14 đơn")).toBeVisible();
  });

  it("shows only Telegram, in đồng, since Hub William is not connected", async () => {
    renderPage(<RevenueRoute />);
    await figure("Doanh thu");

    expect(screen.queryByText("Hub William")).not.toBeInTheDocument();
    expect(screen.getAllByText("Telegram")).toHaveLength(1);
    expect(screen.queryByText(/USD|\$/)).not.toBeInTheDocument();
  });

  it("says so when nothing was sold", async () => {
    get.mockResolvedValue({
      ...revenue(7),
      by_seller: [],
      daily: revenue(7).daily.map((day) => ({ ...day, orders: 0, total: 0 })),
      top_items: [],
    });

    renderPage(<RevenueRoute />);

    expect(
      await screen.findAllByText("Chưa bán được đơn nào trong kỳ này."),
    ).toHaveLength(2);
  });

  it("shows a loading state, then why the revenue could not be loaded, and tries again", async () => {
    const user = userEvent.setup();

    get.mockRejectedValueOnce(new ServiceError("Máy chủ đang bận.", 503, null));
    renderPage(<RevenueRoute />);

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải doanh thu");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Máy chủ đang bận.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await figure("Doanh thu")).toBeVisible();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it.each(["cashier", "stock-keeper"] as const)(
    "is closed to a %s, who asks the server for nothing",
    (role) => {
      renderPage(<RevenueRoute />, role);

      expect(
        screen.getByText("Trang này không dành cho vai trò của bạn"),
      ).toBeInTheDocument();
      expect(get).not.toHaveBeenCalled();
    },
  );
});
