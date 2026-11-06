import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import {
  fakeOrder,
  fakeOrdersService,
  resetFakeOrders,
  setFakeOrders,
} from "@/test/fake-orders-service";
import renderPage from "@/test/render-page";

import OrdersRoute from "./route";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// The page talks to the server through this service; a test gives it a shop in
// memory instead, and watches what the page asks of it.
vi.mock("@/services/orders/orders-service", async (importActual) => {
  const { fakeOrdersService } = await import("@/test/fake-orders-service");

  return {
    ...(await importActual<object>()),
    ordersService: fakeOrdersService,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeOrders();
});

afterEach(() => {
  vi.useRealTimers();
});

// A tab is named by its label and the count in its chip.
const tab = (label: string, count: number) =>
  screen.getByRole("tab", { name: new RegExp(`^${label}\\s*${count}$`) });

const dataRows = () => screen.getAllByRole("row").slice(1);
const refused = (message: string) =>
  new ServiceError(message, 422, "validation_error");

/** Opens the page once its orders have arrived. */
async function setup() {
  const user = userEvent.setup();

  renderPage(<OrdersRoute />);
  await screen.findByRole("tab", { name: /^Tất cả\s*45$/ });

  return user;
}

// The queue is a tab like the others, so its tests open it first.
async function openQueue(user: Awaited<ReturnType<typeof setup>>) {
  await user.click(tab("Chờ thanh toán", 10));
  await waitFor(() =>
    expect(tab("Chờ thanh toán", 10)).toHaveAttribute("data-state", "active"),
  );
}

describe("OrdersRoute, the list", () => {
  it("opens on every order, newest first, 20 to a page", async () => {
    const list = vi.spyOn(fakeOrdersService, "list");

    await setup();

    expect(list).toHaveBeenCalledWith({ page: 1, query: "", status: "all" });
    expect(tab("Tất cả", 45)).toHaveAttribute("data-state", "active");
    expect(dataRows()).toHaveLength(20);
    expect(screen.getByText("Hiển thị 1–20 trong 45 đơn")).toBeInTheDocument();
    expect(
      within(dataRows()[0]).queryByText(/^Quá hạn/),
    ).not.toBeInTheDocument();
  });

  it("puts Tất cả first among the status tabs, each with the server's count", async () => {
    await setup();

    expect(screen.getAllByRole("tab").map((item) => item.textContent)).toEqual([
      "Tất cả45",
      "Chờ thanh toán10",
      "Đã thanh toán30",
      "Đã hủy5",
    ]);
  });

  it("shows a loading state until the orders arrive", () => {
    vi.spyOn(fakeOrdersService, "list").mockReturnValue(new Promise(() => {}));

    renderPage(<OrdersRoute />);

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải đơn hàng");
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("says why the orders could not be loaded, and tries again on request", async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(fakeOrdersService, "list")
      .mockRejectedValueOnce(
        new ServiceError("Không kết nối được tới máy chủ.", null, null),
      );

    renderPage(<OrdersRoute />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Không kết nối được tới máy chủ.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await screen.findByRole("tab", { name: /^Tất cả/ })).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("names who dealt with each order: staff, SePay, the buyer, or no one yet", async () => {
    setFakeOrders([
      fakeOrder({ status: "awaiting_payment" }),
      fakeOrder({
        handled_by: "thuha",
        paid_at: new Date().toISOString(),
        payment_method: "cash",
        status: "paid",
      }),
      fakeOrder({
        paid_at: new Date().toISOString(),
        payment_method: "bank_transfer",
        status: "paid",
      }),
      fakeOrder({ status: "cancelled" }),
    ]);
    renderPage(<OrdersRoute />);
    await screen.findByRole("tab", { name: /^Tất cả\s*4$/ });

    const cells = dataRows().map(
      (row) => within(row).getAllByRole("cell").at(-2)?.textContent,
    );

    expect(cells.sort()).toEqual(
      ["SePay (tự động)", "thuha", "Khách tự hủy", "—"].sort(),
    );
  });

  it("shows no type column and no Hub William order", async () => {
    await setup();

    expect(
      screen.queryByRole("columnheader", { name: "Loại" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("combobox", { name: "Lọc theo loại" }),
    ).not.toBeInTheDocument();
  });
});

describe("OrdersRoute, the queue", () => {
  it("asks for the orders awaiting payment and lists the longest-waiting first", async () => {
    const list = vi.spyOn(fakeOrdersService, "list");
    const user = await setup();

    await openQueue(user);

    expect(list).toHaveBeenLastCalledWith({
      page: 1,
      query: "",
      status: "awaiting_payment",
    });

    const rows = dataRows();

    expect(rows).toHaveLength(10);
    expect(within(rows[0]).getAllByRole("cell")[0]).toHaveTextContent("1");
    // The oldest was made 8 + 29 * 36 minutes ago and expired 15 minutes after.
    expect(rows[0]).toHaveTextContent("Quá hạn");
    expect(within(rows[9]).getAllByRole("cell")[0]).toHaveTextContent("10");
  });

  it("flags an order past its time without dropping it, and counts the time left on the rest", async () => {
    setFakeOrders([
      fakeOrder({
        created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
        expires_at: new Date(Date.now() - 25 * 60_000).toISOString(),
      }),
      fakeOrder({
        created_at: new Date(Date.now() - 3 * 60_000).toISOString(),
        expires_at: new Date(Date.now() + 12 * 60_000).toISOString(),
      }),
    ]);
    const user = userEvent.setup();

    renderPage(<OrdersRoute />);
    await user.click(
      await screen.findByRole("tab", { name: /^Chờ thanh toán/ }),
    );

    await waitFor(() =>
      expect(screen.getByText("Quá hạn 25 phút")).toBeVisible(),
    );
    expect(screen.getByText("Còn 12 phút")).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: /^Đã nhận tiền đơn/ }),
    ).toHaveLength(2);
  });

  it("keeps counting across pages", async () => {
    setFakeOrders(Array.from({ length: 25 }, () => fakeOrder()));
    const user = userEvent.setup();

    renderPage(<OrdersRoute />);
    await user.click(
      await screen.findByRole("tab", { name: /^Chờ thanh toán/ }),
    );
    await screen.findByText("Hiển thị 1–20 trong 25 đơn");
    await user.click(screen.getByRole("button", { name: "Trang sau" }));
    await screen.findByText("Hiển thị 21–25 trong 25 đơn");

    const rows = dataRows();

    expect(rows).toHaveLength(5);
    expect(within(rows[0]).getAllByRole("cell")[0]).toHaveTextContent("21");
  });
});

describe("OrdersRoute, paging and search", () => {
  it("moves between pages and marks the current one", async () => {
    const list = vi.spyOn(fakeOrdersService, "list");
    const user = await setup();

    expect(screen.getByRole("button", { name: "Trang trước" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Trang 1" })).toHaveAttribute(
      "aria-current",
      "page",
    );

    await user.click(screen.getByRole("button", { name: "Trang 3" }));

    expect(
      await screen.findByText("Hiển thị 41–45 trong 45 đơn"),
    ).toBeInTheDocument();
    expect(list).toHaveBeenLastCalledWith({
      page: 3,
      query: "",
      status: "all",
    });
    expect(screen.getByRole("button", { name: "Trang 3" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("button", { name: "Trang sau" })).toBeDisabled();
  });

  it("finds an order by its reference, once the typing has paused", async () => {
    const list = vi.spyOn(fakeOrdersService, "list");
    const user = await setup();
    const reference = dataRows()[3].querySelector("p.font-mono")?.textContent;

    await user.type(screen.getByLabelText("Tìm đơn"), reference ?? "");

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        page: 1,
        query: reference,
        status: "all",
      }),
    );
    // One request for the whole word, not one for each letter.
    expect(list.mock.calls.length).toBeLessThanOrEqual(3);
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(dataRows()[0]).toHaveTextContent(reference ?? "");
  });

  it("goes back to the first page when the search changes", async () => {
    const list = vi.spyOn(fakeOrdersService, "list");
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    await screen.findByText("Hiển thị 21–40 trong 45 đơn");
    await user.type(screen.getByLabelText("Tìm đơn"), "buyer");

    await waitFor(() =>
      expect(list).toHaveBeenLastCalledWith({
        page: 1,
        query: "buyer",
        status: "all",
      }),
    );
  });

  it("goes back to the first page when the status changes", async () => {
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    await screen.findByText("Hiển thị 21–40 trong 45 đơn");
    await user.click(tab("Đã thanh toán", 30));

    expect(
      await screen.findByText("Hiển thị 1–20 trong 30 đơn"),
    ).toBeInTheDocument();
  });

  it("counts the tabs under the search and says so when nothing matches", async () => {
    const user = await setup();

    await user.type(screen.getByLabelText("Tìm đơn"), "no-such-order");

    expect(await screen.findByText("Không có đơn nào.")).toBeInTheDocument();
    expect(tab("Tất cả", 0)).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Phân trang" })).toBeNull();
    expect(screen.queryByText(/^Hiển thị/)).not.toBeInTheDocument();
  });

  it("steps back to the last page that is left when its only order is settled", async () => {
    setFakeOrders(Array.from({ length: 21 }, () => fakeOrder()));
    const user = userEvent.setup();

    renderPage(<OrdersRoute />);
    await user.click(
      await screen.findByRole("tab", { name: /^Chờ thanh toán/ }),
    );
    await screen.findByText("Hiển thị 1–20 trong 21 đơn");
    await user.click(screen.getByRole("button", { name: "Trang 2" }));
    await screen.findByText("Hiển thị 21–21 trong 21 đơn");
    await user.click(screen.getByRole("button", { name: /^Hủy đơn/ }));
    await user.click(screen.getByRole("button", { name: "Hủy đơn" }));

    expect(
      await screen.findByText("Hiển thị 1–20 trong 20 đơn"),
    ).toBeInTheDocument();
  });
});

describe("OrdersRoute, marking an order paid", () => {
  async function openPay() {
    const user = await setup();

    await openQueue(user);

    const row = dataRows()[0];
    const reference = row.querySelector("p.font-mono")?.textContent ?? "";

    await user.click(
      within(row).getByRole("button", { name: /^Đã nhận tiền đơn/ }),
    );

    return { user, reference, dialog: screen.getByRole("dialog") };
  }

  it("asks how the money arrived, bank transfer unless told otherwise", async () => {
    const { dialog, reference } = await openPay();

    expect(dialog).toHaveTextContent(`Đã nhận tiền đơn ${reference}?`);
    expect(
      within(dialog).getByRole("combobox", { name: "Khách trả bằng" }),
    ).toHaveTextContent("Chuyển khoản");
  });

  it("offers a bank transfer, USDT and cash", async () => {
    const { dialog, user } = await openPay();

    await user.click(
      within(dialog).getByRole("combobox", { name: "Khách trả bằng" }),
    );

    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["Chuyển khoản", "USDT", "Tiền mặt"]);
  });

  it("pays the order with the chosen method, then tells the staff the bot told the buyer", async () => {
    const pay = vi.spyOn(fakeOrdersService, "pay");
    const { dialog, reference, user } = await openPay();

    await user.click(
      within(dialog).getByRole("combobox", { name: "Khách trả bằng" }),
    );
    await user.click(screen.getByRole("option", { name: "Tiền mặt" }));
    await user.click(within(dialog).getByRole("button", { name: "Xác nhận" }));

    await waitFor(() => expect(pay).toHaveBeenCalledWith(reference, "cash"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        `Đơn ${reference} đã thanh toán`,
        { description: expect.stringMatching(/^Bot đã báo cho @buyer_/) },
      ),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The order left the queue and the tab says so.
    expect(
      await screen.findByRole("tab", { name: /^Chờ thanh toán\s*9$/ }),
    ).toBeVisible();
    expect(screen.queryByText(reference)).not.toBeInTheDocument();
  });

  it("does not claim the buyer was told when the bot could not", async () => {
    vi.spyOn(fakeOrdersService, "pay").mockImplementationOnce(
      async (reference) => ({
        notified: false,
        order: fakeOrder({ reference, status: "paid" }),
      }),
    );
    const { dialog, reference, user } = await openPay();

    await user.click(within(dialog).getByRole("button", { name: "Xác nhận" }));

    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        `Đơn ${reference} đã thanh toán`,
        { description: expect.stringContaining("Hãy nhắn cho khách") },
      ),
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("keeps the dialog and says why when the order cannot be paid", async () => {
    vi.spyOn(fakeOrdersService, "pay").mockRejectedValueOnce(
      refused("That order is not waiting for payment."),
    );
    const { dialog, user } = await openPay();

    await user.click(within(dialog).getByRole("button", { name: "Xác nhận" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Không xác nhận được thanh toán",
        { description: "That order is not waiting for payment." },
      ),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("changes nothing when backed out of", async () => {
    const pay = vi.spyOn(fakeOrdersService, "pay");
    const { dialog, user } = await openPay();

    await user.click(within(dialog).getByRole("button", { name: "Chưa" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(pay).not.toHaveBeenCalled();
    expect(tab("Chờ thanh toán", 10)).toBeInTheDocument();
  });
});

describe("OrdersRoute, cancelling an order", () => {
  async function openCancel() {
    const user = await setup();

    await openQueue(user);

    const row = dataRows()[0];
    const reference = row.querySelector("p.font-mono")?.textContent ?? "";

    await user.click(within(row).getByRole("button", { name: /^Hủy đơn/ }));

    return { user, reference, dialog: screen.getByRole("dialog") };
  }

  it("asks first, and says the stock goes back", async () => {
    const cancel = vi.spyOn(fakeOrdersService, "cancel");
    const { dialog, reference } = await openCancel();

    expect(dialog).toHaveTextContent(`Hủy đơn ${reference}?`);
    expect(dialog).toHaveTextContent("trả lại kho");
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels the order after confirming", async () => {
    const cancel = vi.spyOn(fakeOrdersService, "cancel");
    const { dialog, reference, user } = await openCancel();

    await user.click(within(dialog).getByRole("button", { name: "Hủy đơn" }));

    await waitFor(() => expect(cancel).toHaveBeenCalledWith(reference));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(`Đã hủy đơn ${reference}`, {
        description: "Hàng đang giữ cho đơn này được trả lại kho.",
      }),
    );
    expect(
      await screen.findByRole("tab", { name: /^Chờ thanh toán\s*9$/ }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: /^Đã hủy\s*6$/ })).toBeVisible();
  });

  it("keeps the order when backing out", async () => {
    const cancel = vi.spyOn(fakeOrdersService, "cancel");
    const { dialog, user } = await openCancel();

    await user.click(within(dialog).getByRole("button", { name: "Giữ đơn" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the dialog and says why when the order cannot be cancelled", async () => {
    vi.spyOn(fakeOrdersService, "cancel").mockRejectedValueOnce(
      refused("That order is not waiting for payment."),
    );
    const { dialog, user } = await openCancel();

    await user.click(within(dialog).getByRole("button", { name: "Hủy đơn" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Không hủy được đơn", {
        description: "That order is not waiting for payment.",
      }),
    );
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});

describe("OrdersRoute, who may use it", () => {
  it("offers no action on an order that is already settled", async () => {
    const user = await setup();

    await user.click(tab("Đã thanh toán", 30));
    await screen.findByText("Hiển thị 1–20 trong 30 đơn");

    expect(
      screen.queryByRole("button", { name: /^Đã nhận tiền đơn/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Hủy đơn/ }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByText(/^Thanh toán \d{2}:\d{2}$/).length).toBe(20);
  });

  it.each(["stock-keeper"] as const)(
    "is closed to a %s, who asks the server for nothing",
    (role) => {
      const list = vi.spyOn(fakeOrdersService, "list");

      renderPage(<OrdersRoute />, role);

      expect(
        screen.getByText("Trang này không dành cho vai trò của bạn"),
      ).toBeInTheDocument();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("is open to a cashier", async () => {
    renderPage(<OrdersRoute />, "cashier");

    expect(await screen.findByRole("tab", { name: /^Tất cả/ })).toBeVisible();
  });
});
