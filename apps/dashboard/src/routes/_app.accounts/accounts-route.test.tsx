import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import type { Role } from "@/services/sales/sales-types";
import {
  FAKE_OWNER_PASSWORD,
  fakeStockService,
  resetFakeStock,
} from "@/test/fake-stock-service";
import renderPage from "@/test/render-page";

import AccountsRoute from "./route";

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
vi.mock("@/services/stock/stock-service", async (importActual) => {
  const { fakeStockService } = await import("@/test/fake-stock-service");

  return {
    ...(await importActual<object>()),
    stockService: fakeStockService,
  };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeStock();
});

// A tab is named by its label and the count in its chip.
const tab = (label: string, count: number) =>
  screen.getByRole("tab", { name: new RegExp(`^${label}\\s*${count}$`) });
const dataRows = () => screen.getAllByRole("row").slice(1);

/** Opens the page once its accounts have arrived. */
async function setup(role: Role = "owner") {
  const user = userEvent.setup();

  renderPage(<AccountsRoute />, role);
  await screen.findByRole("tab", { name: /^Tất cả\s*2$/ });

  return user;
}

describe("AccountsRoute", () => {
  it("opens on every account, with the standing of each counted on its tab", async () => {
    await setup();

    expect(tab("Chưa bán", 1)).toBeInTheDocument();
    expect(tab("Đã bán", 1)).toBeInTheDocument();
    expect(dataRows()).toHaveLength(2);

    const unsold = within(dataRows()[0]);
    const sold = within(dataRows()[1]);

    expect(unsold.getByText("o***@example.com")).toBeInTheDocument();
    expect(unsold.getByText("Claude Max 5x 1 tháng")).toBeInTheDocument();
    expect(unsold.getByText("Chưa bán")).toBeInTheDocument();
    expect(unsold.getByText("minhanh")).toBeInTheDocument();
    expect(sold.getByText("Đã bán")).toBeInTheDocument();
    expect(sold.getByText("ABC123DEF456")).toBeInTheDocument();
    // Never an email in full, and never a password.
    expect(document.body.textContent).not.toContain("owner@example.com");
    expect(document.body.textContent).not.toContain("right-secret");
  });

  it("shows only the accounts not sold, or only those sold, from the tabs", async () => {
    const search = vi.spyOn(fakeStockService, "searchAccounts");
    const user = await setup();

    await user.click(tab("Chưa bán", 1));
    await waitFor(() => expect(dataRows()).toHaveLength(1));

    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ page: 1, status: "unsold" }),
    );
    expect(screen.getByText("o***@example.com")).toBeInTheDocument();

    await user.click(tab("Đã bán", 1));
    await waitFor(() =>
      expect(screen.getByText("b***@example.com")).toBeInTheDocument(),
    );

    expect(search).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "sold" }),
    );
    // A sold account cannot be taken out of stock.
    expect(
      screen.queryByRole("button", { name: /^Xóa tài khoản/ }),
    ).not.toBeInTheDocument();
  });

  it("searches by what is typed, after a moment", async () => {
    const search = vi.spyOn(fakeStockService, "searchAccounts");
    const user = await setup();

    await user.type(screen.getByLabelText("Tìm tài khoản"), "abc123");

    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ page: 1, query: "abc123" }),
      ),
    );
    await waitFor(() => expect(dataRows()).toHaveLength(1));
    expect(screen.getByText("ABC123DEF456")).toBeInTheDocument();
  });

  it("narrows to one package, among those that hand out accounts", async () => {
    const search = vi.spyOn(fakeStockService, "searchAccounts");
    const user = await setup();

    await user.click(screen.getByRole("combobox", { name: "Lọc theo gói" }));
    // Only a package that hands out accounts is offered.
    expect(screen.getAllByRole("option")).toHaveLength(2);
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );

    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ product: "claude-max-5x-1-thang" }),
      ),
    );
  });

  it("lets the owner look at an account already sold, which cannot be edited", async () => {
    const user = await setup();

    await user.click(
      screen.getByRole("button", {
        name: "Xem tài khoản b***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(
      screen.getByLabelText("Mật khẩu của bạn"),
      FAKE_OWNER_PASSWORD,
    );
    await user.click(screen.getByRole("button", { name: "Mở" }));

    const lines = await screen.findByLabelText("Tài khoản");

    expect(lines).toHaveValue("buyer@example.com|already-sent");
    expect(lines).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Xem thay đổi" }),
    ).not.toBeInTheDocument();
  });

  it("opens one account to edit, shows what would change, and saves it", async () => {
    const edit = vi.spyOn(fakeStockService, "editAccounts");
    const user = await setup();

    await user.click(
      screen.getByRole("button", {
        name: "Xem / sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(
      screen.getByLabelText("Mật khẩu của bạn"),
      FAKE_OWNER_PASSWORD,
    );
    await user.click(screen.getByRole("button", { name: "Mở" }));

    const lines = await screen.findByLabelText("Tài khoản");

    expect(lines).toHaveValue("owner@example.com|right-secret");
    // Nothing changed yet, so nothing to look at.
    expect(screen.getByRole("button", { name: "Xem thay đổi" })).toBeDisabled();

    await user.clear(lines);
    await user.type(lines, "renamed@example.com|right-secret");
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));

    expect(await screen.findByText("Xác nhận thay đổi")).toBeInTheDocument();
    expect(edit).toHaveBeenLastCalledWith(
      "claude-max-5x-1-thang",
      expect.objectContaining({ dryRun: true, ids: ["account-unsold"] }),
    );
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    await waitFor(() =>
      expect(edit).toHaveBeenLastCalledWith(
        "claude-max-5x-1-thang",
        expect.objectContaining({ dryRun: false }),
      ),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã lưu thay đổi", {
      description: "Đổi 1. Trong kho còn 4 tài khoản.",
    });
    // The page follows the change, and the dialog is gone with what it held.
    expect(await screen.findByText("r***@example.com")).toBeInTheDocument();
    expect(screen.queryByText("o***@example.com")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("right-secret");
  });

  it("offers the whole package as one block once the page is narrowed to it", async () => {
    const user = await setup();

    // Not while every package is shown.
    expect(
      screen.queryByRole("button", { name: "Xem / sửa cả gói" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Lọc theo gói" }));
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Xem / sửa cả gói" }),
    );
    await user.type(
      screen.getByLabelText("Mật khẩu của bạn"),
      FAKE_OWNER_PASSWORD,
    );
    await user.click(screen.getByRole("button", { name: "Mở" }));

    // The account sold is not part of the block.
    expect(await screen.findByLabelText("Tài khoản")).toHaveValue(
      "owner@example.com|right-secret",
    );
  });

  it.each(["manager", "stock-keeper"] as const)(
    "offers a %s no way to open an account",
    async (role: Role) => {
      await setup(role);

      expect(dataRows()).toHaveLength(2);
      expect(
        screen.queryByRole("button", { name: /^Xem( \/ sửa)? tài khoản/ }),
      ).not.toBeInTheDocument();
    },
  );

  it("takes an account not sold out of stock once it is confirmed", async () => {
    const remove = vi.spyOn(fakeStockService, "removeAccount");
    const user = await setup();

    await user.click(
      screen.getByRole("button", {
        name: "Xóa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    // Asked first, not done.
    expect(remove).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Xóa" }),
    );

    await waitFor(() => expect(remove).toHaveBeenCalledWith("account-unsold"));
    await waitFor(() =>
      expect(screen.queryByText("o***@example.com")).not.toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã xóa tài khoản", {
      description: "Trong kho còn 3 tài khoản.",
    });
  });

  it("loads the accounts pasted into a package, and lists them hidden", async () => {
    const load = vi.spyOn(fakeStockService, "loadAccounts");
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Thêm tài khoản" }));

    const dialog = within(screen.getByRole("dialog"));
    const submit = dialog.getByRole("button", { name: "Nạp tài khoản" });

    // Nothing to load yet, and no package chosen.
    expect(submit).toBeDisabled();

    await user.click(dialog.getByRole("combobox", { name: "Gói" }));
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );
    await user.click(dialog.getByLabelText("Tài khoản"));
    await user.paste("new.one@example.com|pw-1\nowner@example.com|pw-other\n");

    expect(dialog.getByText("2 tài khoản")).toBeInTheDocument();
    await user.click(submit);

    await waitFor(() =>
      expect(load).toHaveBeenCalledWith(
        "claude-max-5x-1-thang",
        "new.one@example.com|pw-1\nowner@example.com|pw-other",
      ),
    );
    // Two new accounts, though one of them has an email already in stock.
    expect(toast.success).toHaveBeenCalledWith("Đã nạp tài khoản", {
      description: "Trong kho còn 6 tài khoản.",
    });
    expect(await screen.findByText("n***@example.com")).toBeInTheDocument();
    expect(screen.getAllByText("o***@example.com")).toHaveLength(2);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("pw-1");
    expect(document.body.textContent).not.toContain("new.one@example.com");
  });

  it("starts the package on the one the page is narrowed to", async () => {
    const user = await setup();

    await user.click(screen.getByRole("combobox", { name: "Lọc theo gói" }));
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );
    await user.click(screen.getByRole("button", { name: "Thêm tài khoản" }));

    expect(
      within(screen.getByRole("dialog")).getByRole("combobox", {
        name: "Gói",
      }),
    ).toHaveTextContent("Claude Max 5x 1 tháng");
  });

  it("names the line that is wrong, without quoting it, and loads nothing", async () => {
    const load = vi.spyOn(fakeStockService, "loadAccounts");
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Thêm tài khoản" }));

    const dialog = within(screen.getByRole("dialog"));

    await user.click(dialog.getByRole("combobox", { name: "Gói" }));
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );
    await user.click(dialog.getByLabelText("Tài khoản"));
    await user.paste("good@example.com|ok\nno-bar-here-secret");

    // It names the line; the line itself is only in the box it was typed in.
    expect(
      dialog.getByText("Dòng 2 không đúng dạng email|mật khẩu."),
    ).not.toHaveTextContent("no-bar-here-secret");
    expect(
      dialog.getByRole("button", { name: "Nạp tài khoản" }),
    ).toBeDisabled();
    expect(load).not.toHaveBeenCalled();
  });

  it("keeps the dialog open and says why when the accounts could not be loaded", async () => {
    vi.spyOn(fakeStockService, "loadAccounts").mockRejectedValueOnce(
      new ServiceError("Loading accounts needs a key.", 501, "not_available"),
    );

    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Thêm tài khoản" }));

    const dialog = within(screen.getByRole("dialog"));

    await user.click(dialog.getByRole("combobox", { name: "Gói" }));
    await user.click(
      screen.getByRole("option", { name: "Claude Max 5x 1 tháng" }),
    );
    await user.click(dialog.getByLabelText("Tài khoản"));
    await user.paste("a@example.com|b");
    await user.click(dialog.getByRole("button", { name: "Nạp tài khoản" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Không nạp được tài khoản", {
        description: "Loading accounts needs a key.",
      }),
    );
    // Still there, with what was pasted, to try again.
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(dialog.getByLabelText("Tài khoản")).toHaveValue("a@example.com|b");
  });

  it("says there is nowhere to load them when no package hands out accounts", async () => {
    vi.spyOn(fakeStockService, "list").mockResolvedValue(
      (await fakeStockService.list()).map((item) => ({
        ...item,
        delivers_accounts: false,
      })),
    );

    const user = await setup();

    await user.click(
      await screen.findByRole("button", { name: "Thêm tài khoản" }),
    );

    expect(
      within(screen.getByRole("dialog")).getByText(
        "Chưa có gói nào giao tài khoản",
      ),
    ).toBeInTheDocument();
  });

  it("changes only the password of an account, and keeps the email", async () => {
    const update = vi.spyOn(fakeStockService, "updateAccount");
    const user = await setup("manager");

    await user.click(
      screen.getByRole("button", {
        name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );

    const dialog = within(screen.getByRole("dialog"));

    // Nothing typed, nothing to save.
    expect(dialog.getByRole("button", { name: "Lưu" })).toBeDisabled();

    await user.type(dialog.getByLabelText("Mật khẩu mới"), "fresh-password");
    await user.click(dialog.getByRole("button", { name: "Lưu" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("account-unsold", {
        email: undefined,
        password: "fresh-password",
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã sửa tài khoản", {
      description: "o***@example.com",
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("fresh-password");
  });

  it("changes the email too, and the list follows", async () => {
    const user = await setup("manager");

    await user.click(
      screen.getByRole("button", {
        name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(screen.getByLabelText("Email mới"), "renamed@example.com");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(await screen.findByText("r***@example.com")).toBeInTheDocument();
    expect(screen.queryByText("o***@example.com")).not.toBeInTheDocument();
  });

  it("refuses a bar in the email before asking the server", async () => {
    const update = vi.spyOn(fakeStockService, "updateAccount");
    const user = await setup("manager");

    await user.click(
      screen.getByRole("button", {
        name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(screen.getByLabelText("Email mới"), "a|b@example.com");

    expect(screen.getByText("Email không được có dấu |.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
    expect(update).not.toHaveBeenCalled();
  });

  it("shows the server's refusal inside the dialog, which stays open", async () => {
    vi.spyOn(fakeStockService, "updateAccount").mockRejectedValueOnce(
      new ServiceError(
        "That account is already in stock for this package.",
        422,
        "validation_error",
      ),
    );

    const user = await setup("manager");

    await user.click(
      screen.getByRole("button", {
        name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(screen.getByLabelText("Email mới"), "taken@example.com");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "That account is already in stock for this package.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("says the account is gone when it was sold meanwhile", async () => {
    vi.spyOn(fakeStockService, "updateAccount").mockRejectedValueOnce(
      new ServiceError(
        "The requested resource was not found.",
        404,
        "not_found",
      ),
    );

    const user = await setup("manager");

    await user.click(
      screen.getByRole("button", {
        name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
      }),
    );
    await user.type(screen.getByLabelText("Mật khẩu mới"), "x-new");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Tài khoản này đã bán hoặc không còn trong kho.",
    );
  });

  it("offers no edit on an account already sold", async () => {
    const user = await setup();

    await user.click(tab("Đã bán", 1));
    await screen.findByText("b***@example.com");

    expect(
      screen.queryByRole("button", { name: /^Sửa tài khoản/ }),
    ).not.toBeInTheDocument();
  });

  it.each(["manager", "stock-keeper"] as const)(
    "lets a %s add and change accounts, though not open them",
    async (role: Role) => {
      await setup(role);

      expect(
        screen.getByRole("button", { name: "Thêm tài khoản" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "Sửa tài khoản o***@example.com của Claude Max 5x 1 tháng",
        }),
      ).toBeInTheDocument();
    },
  );

  it("is closed to a role without the stock, and asks the server for nothing", () => {
    const search = vi.spyOn(fakeStockService, "searchAccounts");

    renderPage(<AccountsRoute />, "cashier");

    expect(
      screen.getByText("Trang này không dành cho vai trò của bạn"),
    ).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });

  it("says why the accounts could not be loaded, and tries again on request", async () => {
    const user = userEvent.setup();

    vi.spyOn(fakeStockService, "searchAccounts").mockRejectedValueOnce(
      new ServiceError("Loading accounts needs a key.", 501, "not_available"),
    );
    renderPage(<AccountsRoute />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Loading accounts needs a key.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await screen.findByText("o***@example.com")).toBeInTheDocument();
  });
});
