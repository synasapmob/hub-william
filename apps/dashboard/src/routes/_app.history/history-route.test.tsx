import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import {
  fakeOrder,
  fakeOrdersService,
  resetFakeOrders,
  setFakeOrders,
} from "@/test/fake-orders-service";
import { money } from "@/test/format-money";
import renderPage from "@/test/render-page";

import HistoryRoute from "./route";

// The page talks to the server through this service; a test gives it a shop in
// memory instead, and watches what the page asks of it.
vi.mock("@/services/orders/orders-service", async (importActual) => {
  const { fakeOrdersService } = await import("@/test/fake-orders-service");

  return {
    ...(await importActual<object>()),
    ordersService: fakeOrdersService,
  };
});

// 14:40 on 5 November in shop time, so "today" and the ranges do not move.
const NOW = new Date("2026-11-05T14:40:00+07:00");

beforeEach(() => {
  vi.restoreAllMocks();
  // Only the clock is set; timers run, so the search can wait for a pause.
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  resetFakeOrders();
});

afterEach(() => {
  vi.useRealTimers();
});

const dataRows = () => screen.getAllByRole("row").slice(1);

/** Opens the page once its sales have arrived. */
async function setup() {
  const user = userEvent.setup();

  renderPage(<HistoryRoute />);
  await screen.findByText("Hiển thị 1–20 trong 30 đơn");

  return user;
}

describe("HistoryRoute", () => {
  it("asks for the last 7 shop days, today included, from every seller", async () => {
    const sales = vi.spyOn(fakeOrdersService, "sales");

    await setup();

    expect(sales).toHaveBeenCalledWith({
      from: "2026-10-30",
      page: 1,
      query: "",
      seller: "all",
      to: "2026-11-05",
    });
  });

  it.each([
    ["Hôm nay", "2026-11-05"],
    ["30 ngày qua", "2026-10-07"],
  ])("asks for %s from %s", async (label, from) => {
    const sales = vi.spyOn(fakeOrdersService, "sales");
    const user = await setup();

    await user.click(
      screen.getByRole("combobox", { name: "Khoảng thời gian" }),
    );
    await user.click(screen.getByRole("option", { name: label }));

    await waitFor(() =>
      expect(sales).toHaveBeenLastCalledWith({
        from,
        page: 1,
        query: "",
        seller: "all",
        to: "2026-11-05",
      }),
    );
  });

  it("totals what the server says every matching order comes to", async () => {
    await setup();

    expect(
      screen.getByText("Số đơn đã bán").nextElementSibling,
    ).toHaveTextContent("30");
    // 30 paid orders of 189.000 ₫, though only 20 are on the page.
    expect(screen.getByText("Doanh thu").nextElementSibling).toHaveTextContent(
      money(30 * 189_000),
    );
    expect(dataRows().filter((row) => row.children.length > 1)).toHaveLength(
      20,
    );
  });

  it("starts on Telegram's history, in đồng, with Hub William's one choice away", async () => {
    await setup();

    expect(
      screen.getByRole("combobox", { name: "Loại hàng" }),
    ).toHaveTextContent("Telegram");
    expect(screen.getByText("Số đơn đã bán")).toBeInTheDocument();
    // The two are never added together: Telegram's figures are all in đồng.
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("lists the sales under their day, the newest day first", async () => {
    const user = await setup();
    const headers = () => dataRows().filter((row) => row.children.length === 1);

    // The first page is all today.
    expect(headers()).toHaveLength(1);
    expect(headers()[0]).toHaveTextContent("05/11");
    // A day can run on into the next page, so it is named but not totalled.
    expect(headers()[0]).not.toHaveTextContent("₫");

    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    await screen.findByText("Hiển thị 21–30 trong 30 đơn");

    expect(headers()).toHaveLength(2);
    expect(headers()[0]).toHaveTextContent("05/11");
    expect(headers()[1]).toHaveTextContent("04/11");
  });

  it("lists the columns of a sale, and who sold it", async () => {
    await setup();

    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual([
      "Giờ",
      "Mã đơn",
      "Khách",
      "Hàng",
      "Người bán",
      "Thanh toán",
      "Tổng",
    ]);

    const sale = dataRows().find((row) => row.children.length > 1);

    expect(sale).toBeDefined();
    expect(
      within(sale as HTMLElement).getAllByRole("cell")[4],
    ).toHaveTextContent(/SePay \(tự động\)|thuha/);
  });

  it("puts the search above the table, across its full width, below the filters", async () => {
    await setup();

    const search = screen.getByLabelText("Tìm đơn đã bán");
    const filter = screen.getByRole("combobox", { name: "Khoảng thời gian" });

    expect(
      search.compareDocumentPosition(screen.getByRole("table")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      filter.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(search).toHaveClass("w-full");
  });

  it("filters by seller: staff by username, and what SePay settled", async () => {
    const sales = vi.spyOn(fakeOrdersService, "sales");
    const user = await setup();

    await user.click(
      screen.getByRole("combobox", { name: "Lọc theo người bán" }),
    );

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Mọi người bán", "SePay (tự động)", "thuha"]);

    await user.click(screen.getByRole("option", { name: "thuha" }));

    await waitFor(() =>
      expect(sales).toHaveBeenLastCalledWith(
        expect.objectContaining({ seller: "thuha" }),
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByText("Số đơn đã bán").nextElementSibling,
      ).toHaveTextContent("6"),
    );

    await user.click(
      screen.getByRole("combobox", { name: "Lọc theo người bán" }),
    );
    await user.click(screen.getByRole("option", { name: "SePay (tự động)" }));

    await waitFor(() =>
      expect(sales).toHaveBeenLastCalledWith(
        expect.objectContaining({ seller: "bot" }),
      ),
    );
  });

  it("searches the sales once the typing has paused, from the first page", async () => {
    const sales = vi.spyOn(fakeOrdersService, "sales");
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    await screen.findByText("Hiển thị 21–30 trong 30 đơn");
    await user.type(screen.getByLabelText("Tìm đơn đã bán"), "buyer_2");

    await waitFor(() =>
      expect(sales).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, query: "buyer_2" }),
      ),
    );
    // Not once for each letter.
    expect(sales.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("moves between pages", async () => {
    const sales = vi.spyOn(fakeOrdersService, "sales");
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Trang 2" }));

    expect(
      await screen.findByText("Hiển thị 21–30 trong 30 đơn"),
    ).toBeInTheDocument();
    expect(sales).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 2 }),
    );
  });

  it("says so when no order was sold in the range", async () => {
    setFakeOrders([fakeOrder()]);
    renderPage(<HistoryRoute />);

    expect(
      await screen.findByText("Không có đơn nào trong khoảng này."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Số đơn đã bán").nextElementSibling,
    ).toHaveTextContent("0");
  });

  it("shows a loading state, then why the sales could not be loaded, and tries again", async () => {
    const user = userEvent.setup();
    const sales = vi
      .spyOn(fakeOrdersService, "sales")
      .mockRejectedValueOnce(new ServiceError("Máy chủ đang bận.", 503, null));

    renderPage(<HistoryRoute />);

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải lịch sử");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Máy chủ đang bận.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(
      await screen.findByText("Hiển thị 1–20 trong 30 đơn"),
    ).toBeInTheDocument();
    expect(sales).toHaveBeenCalledTimes(2);
  });

  it("is closed to a stock keeper, who asks the server for nothing", () => {
    const sales = vi.spyOn(fakeOrdersService, "sales");

    renderPage(<HistoryRoute />, "stock-keeper");

    expect(
      screen.getByText("Trang này không dành cho vai trò của bạn"),
    ).toBeInTheDocument();
    expect(sales).not.toHaveBeenCalled();
  });
});
