import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import type { StockAccount } from "@/services/stock/stock-service";
import {
  FAKE_OWNER_PASSWORD,
  fakeStockService,
  resetFakeStock,
} from "@/test/fake-stock-service";
import renderPage from "@/test/render-page";

import AccountEditorDialog from "./account-editor-dialog";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

vi.mock("@/services/stock/stock-service", async (importActual) => {
  const { fakeStockService } = await import("@/test/fake-stock-service");

  return {
    ...(await importActual<object>()),
    stockService: fakeStockService,
  };
});

const SLUG = "claude-max-5x-1-thang";

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeStock();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The accounts of the package not sold, after three more are loaded: four. */
async function unsold(): Promise<StockAccount[]> {
  await fakeStockService.loadAccounts(
    SLUG,
    "second@example.com|pass-2\nthird@example.com|pass-3\nfourth@example.com|pass-4",
  );

  return (await fakeStockService.accounts(SLUG)).filter(
    (account) => !account.order_reference,
  );
}

/** Opens the dialog on the accounts and goes through the password to the block. */
async function openBlock(accounts: StockAccount[], onClose = vi.fn()) {
  const user = userEvent.setup();

  renderPage(<AccountEditorDialog accounts={accounts} onClose={onClose} />);
  await user.type(
    screen.getByLabelText("Mật khẩu của bạn"),
    FAKE_OWNER_PASSWORD,
  );
  await user.click(screen.getByRole("button", { name: "Mở" }));

  return { block: await screen.findByLabelText("Tài khoản"), onClose, user };
}

describe("AccountEditorDialog", () => {
  it("asks for the password first, and says when it is not right", async () => {
    const accounts = await unsold();
    const reveal = vi.spyOn(fakeStockService, "revealAccounts");
    const user = userEvent.setup();

    renderPage(<AccountEditorDialog accounts={accounts} onClose={vi.fn()} />);

    expect(
      screen.getByText("Xem / sửa 4 tài khoản của Claude Max 5x 1 tháng"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mở" })).toBeDisabled();

    await user.type(screen.getByLabelText("Mật khẩu của bạn"), "not-it");
    await user.click(screen.getByRole("button", { name: "Mở" }));

    expect(await screen.findByText("Mật khẩu không đúng.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Tài khoản")).not.toBeInTheDocument();
    expect(reveal).toHaveBeenCalledWith(
      accounts.map((account) => account.id),
      "not-it",
    );
  });

  it("shows every account as a line of the block, in the order they were listed", async () => {
    const accounts = await unsold();
    const { block } = await openBlock(accounts);

    expect(block).toHaveValue(
      [
        "fourth@example.com|pass-4",
        "third@example.com|pass-3",
        "second@example.com|pass-2",
        "owner@example.com|right-secret",
      ].join("\n"),
    );
    expect(screen.getByText("4 dòng")).toBeInTheDocument();
    // The password is gone from the field it was typed into.
    expect(document.body.textContent).not.toContain(FAKE_OWNER_PASSWORD);
  });

  it("has nothing to look at until the block is changed, and a line that is wrong is named", async () => {
    const { block, user } = await openBlock(await unsold());

    expect(screen.getByRole("button", { name: "Xem thay đổi" })).toBeDisabled();

    await user.type(block, "\nno-bar-here");

    expect(
      screen.getByText("Dòng 5 không đúng dạng email|mật khẩu."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Xem thay đổi" })).toBeDisabled();
  });

  it("says what would change before anything does, then does it on confirmation", async () => {
    const accounts = await unsold();
    const edit = vi.spyOn(fakeStockService, "editAccounts");
    const { block, onClose, user } = await openBlock(accounts);

    // One password changes, one line goes, one new line comes (and the line that
    // went is paired with it, being gone from the block).
    await user.clear(block);
    await user.paste(
      [
        "fourth@example.com|pass-4",
        "third@example.com|pass-3-new",
        "second@example.com|pass-2",
        "owner@example.com|right-secret",
        "fifth@example.com|pass-5",
      ].join("\n"),
    );
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));

    expect(await screen.findByText("Xác nhận thay đổi")).toBeInTheDocument();
    expect(screen.getByText(/Đổi email hoặc mật khẩu:/)).toHaveTextContent(
      "Đổi email hoặc mật khẩu: 1",
    );
    expect(screen.getByText(/Thêm mới:/)).toHaveTextContent("Thêm mới: 1");
    expect(screen.getByText(/Xóa khỏi kho:/)).toHaveTextContent(
      "Xóa khỏi kho: 0",
    );
    expect(
      screen.getByText("Trong kho sau khi lưu: 8 tài khoản."),
    ).toBeInTheDocument();
    // Looked at, not done: the stock is as it was.
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith(
      SLUG,
      expect.objectContaining({
        dryRun: true,
        ids: accounts.map((account) => account.id),
      }),
    );
    expect((await fakeStockService.accounts(SLUG)).length).toBe(5);

    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(edit).toHaveBeenLastCalledWith(
      SLUG,
      expect.objectContaining({ dryRun: false }),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã lưu thay đổi", {
      description: "Đổi 1, thêm 1. Trong kho còn 8 tài khoản.",
    });
    expect(
      await fakeStockService.revealAccounts(
        (await fakeStockService.accounts(SLUG)).map((account) => account.id),
        FAKE_OWNER_PASSWORD,
      ),
    ).toHaveLength(6);
  });

  it("warns when lines are taken out, and goes back to the block with it as it was", async () => {
    const { block, user } = await openBlock(await unsold());

    await user.clear(block);
    await user.paste("owner@example.com|right-secret");
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));

    expect(await screen.findByText(/Xóa khỏi kho:/)).toHaveTextContent(
      "Xóa khỏi kho: 3",
    );
    expect(
      screen.getByText(/Tài khoản bị xóa không còn được bán/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Quay lại sửa" }));

    expect(await screen.findByLabelText("Tài khoản")).toHaveValue(
      "owner@example.com|right-secret",
    );
  });

  it("takes every account out when the block is emptied", async () => {
    const { block, user } = await openBlock(await unsold());

    await user.clear(block);
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));

    expect(await screen.findByText(/Xóa khỏi kho:/)).toHaveTextContent(
      "Xóa khỏi kho: 4",
    );
  });

  it("changes nothing and says so when the block comes to the same accounts", async () => {
    const save = vi.spyOn(fakeStockService, "editAccounts");
    const { block, user } = await openBlock(await unsold());

    // The same lines in another order are the same accounts.
    await user.clear(block);
    await user.paste(
      [
        "owner@example.com|right-secret",
        "second@example.com|pass-2",
        "third@example.com|pass-3",
        "fourth@example.com|pass-4",
      ].join("\n"),
    );
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));

    expect(
      await screen.findByText("Không có gì thay đổi."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lưu thay đổi" })).toBeDisabled();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("leaves the dialog open with the server's words when the accounts changed meanwhile", async () => {
    const { block, onClose, user } = await openBlock(await unsold());

    await user.type(block, "\nfifth@example.com|pass-5");
    await user.click(screen.getByRole("button", { name: "Xem thay đổi" }));
    await screen.findByText("Xác nhận thay đổi");
    vi.spyOn(fakeStockService, "editAccounts").mockRejectedValueOnce(
      new ServiceError(
        "Some of these accounts were sold or removed while you were editing. Open them again.",
        422,
        "validation_error",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Some of these accounts were sold or removed while you were editing.",
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("shows an account already sold and leaves it as it is", async () => {
    const sold = (await fakeStockService.accounts(SLUG)).filter(
      (account) => account.order_reference,
    );
    const { block } = await openBlock(sold);

    expect(block).toHaveValue("buyer@example.com|already-sent");
    expect(block).toHaveAttribute("readonly");
    expect(
      screen.queryByRole("button", { name: "Xem thay đổi" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Đóng" })).toBeInTheDocument();
  });

  it("closes and forgets the accounts after five minutes without a keystroke", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const accounts = await unsold();
    const onClose = vi.fn();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    renderPage(<AccountEditorDialog accounts={accounts} onClose={onClose} />);
    await user.type(
      screen.getByLabelText("Mật khẩu của bạn"),
      FAKE_OWNER_PASSWORD,
    );
    await user.click(screen.getByRole("button", { name: "Mở" }));

    const block = await screen.findByLabelText("Tài khoản");

    // A keystroke four minutes in starts the five minutes again.
    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    await user.type(block, " ");
    await act(() => vi.advanceTimersByTimeAsync(4 * 60_000));
    expect(onClose).not.toHaveBeenCalled();

    await act(() => vi.advanceTimersByTimeAsync(61_000));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith("Đã đóng vì lâu không thao tác.");
  });
});
