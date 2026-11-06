import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import { fakeOrdersService, resetFakeOrders } from "@/test/fake-orders-service";
import {
  fakeServiceStockService,
  resetFakeServiceStock,
} from "@/test/fake-service-stock-service";
import renderPage from "@/test/render-page";

import HistoryRoute from "./route";

// The page talks to the server through these services; a test gives them a shop
// in memory instead, and watches what the page asks of them.
vi.mock("@/services/orders/orders-service", async (importActual) => {
  const { fakeOrdersService } = await import("@/test/fake-orders-service");

  return {
    ...(await importActual<object>()),
    ordersService: fakeOrdersService,
  };
});

vi.mock("@/services/service-stock/service-stock-service", async () => {
  const { fakeServiceStockService } =
    await import("@/test/fake-service-stock-service");

  return { serviceStockService: fakeServiceStockService };
});

// 14:40 on 5 November in shop time, so "today" and the ranges do not move. The
// fake sales are an hour, two days and twenty days before it.
const NOW = new Date("2026-11-05T14:40:00+07:00");

beforeEach(() => {
  vi.restoreAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  resetFakeOrders();
  resetFakeServiceStock();
});

afterEach(() => {
  vi.useRealTimers();
});

const dataRows = () => screen.getAllByRole("row").slice(1);
const typeFilter = () => screen.getByRole("combobox", { name: "Loại hàng" });
const rangeFilter = () =>
  screen.getByRole("combobox", { name: "Khoảng thời gian" });
const sellerFilter = () =>
  screen.getByRole("combobox", { name: "Lọc theo người bán" });
const figure = (label: string) =>
  (screen.getByText(label).parentElement as HTMLElement).textContent;

/** Opens the page on Hub William's history, once its sales have arrived. */
async function setup() {
  const user = userEvent.setup();

  renderPage(<HistoryRoute />);
  await screen.findByText("Số đơn đã bán");
  await user.click(typeFilter());
  await user.click(screen.getByRole("option", { name: "Hub William" }));
  await screen.findByText("Claude Max · 7 ngày");

  return user;
}

describe("HistoryRoute, Hub William's tickets", () => {
  it("asks the server for the tickets that were sold, once, and lists those of the last 7 days", async () => {
    const sales = vi.spyOn(fakeServiceStockService, "sales");

    await setup();

    expect(sales).toHaveBeenCalledTimes(1);
    expect(dataRows()).toHaveLength(2);
    expect(dataRows()[0]).toHaveTextContent("Claude Max · 7 ngày");
    expect(dataRows()[1]).toHaveTextContent("ChatGPT Plus · 30 ngày");
    // The one of 20 days ago is out of the range.
    expect(
      screen.queryByText("Grok SuperGrok · 7 ngày"),
    ).not.toBeInTheDocument();
  });

  it("says what each ticket was, who bought it and who sold it, which key it got and what it cost", async () => {
    await setup();

    const [claude] = dataRows();

    expect(claude).toHaveTextContent("Claude · 7 ngày");
    expect(claude).toHaveTextContent("@quocbao");
    expect(claude).toHaveTextContent("@minhanh");
    expect(claude).toHaveTextContent("…ab12");
    expect(claude).toHaveTextContent("$4.00");
    expect(dataRows()[1]).toHaveTextContent("@thuha");
    expect(dataRows()[1]).toHaveTextContent("$9.99");
  });

  it("counts the tickets and what they came to, in dollars and not in đồng", async () => {
    await setup();

    expect(figure("Số gói đã bán")).toContain("2");
    expect(figure("Doanh thu")).toContain("$13.99");
    expect(figure("Doanh thu")).not.toContain("₫");
  });

  it("widens to the last 30 days, or narrows to today", async () => {
    const user = await setup();

    await user.click(rangeFilter());
    await user.click(screen.getByRole("option", { name: "30 ngày qua" }));

    expect(dataRows()).toHaveLength(3);
    expect(figure("Doanh thu")).toContain("$16.99");

    await user.click(rangeFilter());
    await user.click(screen.getByRole("option", { name: "Hôm nay" }));

    expect(dataRows()).toHaveLength(1);
    expect(dataRows()[0]).toHaveTextContent("Claude Max · 7 ngày");
    expect(figure("Số gói đã bán")).toContain("1");
  });

  it("filters by who sold, among the sellers of the tickets, and has no bot to choose", async () => {
    const user = await setup();

    await user.click(sellerFilter());

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Mọi người bán", "minhanh", "quocbao"]);

    await user.click(screen.getByRole("option", { name: "quocbao" }));

    expect(dataRows()).toHaveLength(1);
    expect(dataRows()[0]).toHaveTextContent("ChatGPT Plus · 30 ngày");
    expect(figure("Doanh thu")).toContain("$9.99");
  });

  it.each([
    ["the name of the ticket", "chatgpt", "ChatGPT Plus · 30 ngày"],
    ["the buyer", "thuha", "ChatGPT Plus · 30 ngày"],
    ["the seller", "minhanh", "Claude Max · 7 ngày"],
    ["the end of the key", "ab12", "Claude Max · 7 ngày"],
  ])("finds a ticket by %s", async (_, typed, found) => {
    const user = await setup();

    await user.type(
      screen.getByRole("searchbox", { name: "Tìm đơn đã bán" }),
      typed,
    );

    expect(dataRows()).toHaveLength(1);
    expect(dataRows()[0]).toHaveTextContent(found);
  });

  it("says so when nothing was sold in the range", async () => {
    vi.spyOn(fakeServiceStockService, "sales").mockResolvedValue([]);
    const user = userEvent.setup();

    renderPage(<HistoryRoute />);
    await screen.findByText("Số đơn đã bán");
    await user.click(typeFilter());
    await user.click(screen.getByRole("option", { name: "Hub William" }));

    expect(
      await screen.findByText("Không có gói nào được bán trong khoảng này."),
    ).toBeInTheDocument();
    expect(figure("Số gói đã bán")).toContain("0");
    expect(figure("Doanh thu")).toContain("$0.00");
  });

  it("says why the tickets could not be loaded, and tries again on request", async () => {
    const sales = vi
      .spyOn(fakeServiceStockService, "sales")
      .mockRejectedValueOnce(new ServiceError("The API is down.", 500, "x"));
    const user = userEvent.setup();

    renderPage(<HistoryRoute />);
    await screen.findByText("Số đơn đã bán");
    await user.click(typeFilter());
    await user.click(screen.getByRole("option", { name: "Hub William" }));

    expect(await screen.findByText("The API is down.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await screen.findByText("Claude Max · 7 ngày")).toBeInTheDocument();
    expect(sales).toHaveBeenCalledTimes(2);
  });

  it("goes back to Telegram's history, in đồng, and forgets the seller that was chosen", async () => {
    const orders = vi.spyOn(fakeOrdersService, "sales");
    const user = await setup();

    await user.click(sellerFilter());
    await user.click(screen.getByRole("option", { name: "quocbao" }));
    await user.click(typeFilter());
    await user.click(screen.getByRole("option", { name: "Telegram" }));

    await screen.findByText("Số đơn đã bán");
    await waitFor(() =>
      expect(orders).toHaveBeenLastCalledWith(
        expect.objectContaining({ seller: "all" }),
      ),
    );
    expect(sellerFilter()).toHaveTextContent("Mọi người bán");
    expect(within(screen.getAllByRole("row")[1]).queryByText(/\$/)).toBeNull();
  });

  it("does not ask for Telegram's orders while Hub William's are shown, nor the other way round", async () => {
    const tickets = vi.spyOn(fakeServiceStockService, "sales");
    const orders = vi.spyOn(fakeOrdersService, "sales");
    const user = userEvent.setup();

    renderPage(<HistoryRoute />);
    await screen.findByText("Số đơn đã bán");

    expect(tickets).not.toHaveBeenCalled();

    const before = orders.mock.calls.length;

    await user.click(typeFilter());
    await user.click(screen.getByRole("option", { name: "Hub William" }));
    await screen.findByText("Claude Max · 7 ngày");

    expect(orders.mock.calls.length).toBe(before);
    expect(tickets).toHaveBeenCalledTimes(1);
  });
});

describe("HistoryRoute, who may see Hub William's tickets", () => {
  it("never asks for them of a role that cannot see the history", () => {
    const tickets = vi.spyOn(fakeServiceStockService, "sales");

    renderPage(<HistoryRoute />, "stock-keeper");

    expect(
      screen.getByText("Trang này không dành cho vai trò của bạn"),
    ).toBeInTheDocument();
    expect(tickets).not.toHaveBeenCalled();
  });

  it("lets a cashier see them, as they see the orders", async () => {
    const user = userEvent.setup();

    renderPage(<HistoryRoute />, "cashier");
    await screen.findByText("Số đơn đã bán");
    await user.click(typeFilter());
    await user.click(screen.getByRole("option", { name: "Hub William" }));

    expect(await screen.findByText("Claude Max · 7 ngày")).toBeInTheDocument();
  });
});
