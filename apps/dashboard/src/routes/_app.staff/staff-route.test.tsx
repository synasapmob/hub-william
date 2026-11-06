import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import { fakeStaffService, resetFakeStaff } from "@/test/fake-staff-service";
import { money } from "@/test/format-money";
import renderPage from "@/test/render-page";

import StaffRoute from "./route";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// The page talks to the server through this service; a test gives it a team in
// memory instead, and watches what the page asks of it.
vi.mock("@/services/staff/staff-service", async () => {
  const { fakeStaffService } = await import("@/test/fake-staff-service");

  return { staffService: fakeStaffService };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeStaff();
});

const refused = (message: string) =>
  new ServiceError(message, 422, "validation_error");

/** Opens the page, as the owner, once the team has arrived. */
async function setup() {
  const user = userEvent.setup();

  renderPage(<StaffRoute />);
  await screen.findByText("quocbao");

  return user;
}

describe("StaffRoute", () => {
  it.each(["manager", "cashier", "stock-keeper"] as const)(
    "is closed to a %s, with a way back to a page they can open, and asks the server for nothing",
    (role) => {
      const list = vi.spyOn(fakeStaffService, "list");

      renderPage(<StaffRoute />, role);

      expect(
        screen.getByText("Trang này không dành cho vai trò của bạn"),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: /^Về / })).toBeInTheDocument();
      expect(screen.queryByText("Thêm nhân viên")).not.toBeInTheDocument();
      expect(list).not.toHaveBeenCalled();
    },
  );

  it("lists the team from the server, with what each did today and when they were last on", async () => {
    await setup();

    const manager = screen.getByText("quocbao").closest("tr") as HTMLElement;
    const stockKeeper = screen
      .getByText("ducthinh")
      .closest("tr") as HTMLElement;

    expect(manager).toHaveTextContent("1 đơn");
    expect(manager).toHaveTextContent(money(459_000));
    expect(manager).toHaveTextContent("14:12 05/11");
    // An account that has never signed in has no time to show.
    expect(stockKeeper).toHaveTextContent("Chưa đăng nhập");
    expect(screen.getByText("Quyền theo vai trò")).toBeInTheDocument();
  });

  it("shows a loading state, then why the team could not be loaded, and tries again", async () => {
    const user = userEvent.setup();
    const list = vi
      .spyOn(fakeStaffService, "list")
      .mockRejectedValueOnce(new ServiceError("Máy chủ đang bận.", 503, null));

    renderPage(<StaffRoute />);

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải nhân viên");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Máy chủ đang bận.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(await screen.findByText("quocbao")).toBeVisible();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("shows each account's username as it was registered, without an @ or a display name", async () => {
    await setup();

    expect(screen.getByText("thuha")).toBeInTheDocument();
    expect(screen.queryByText("@thuha")).not.toBeInTheDocument();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("marks the signed-in account as the viewer's own", async () => {
    await setup();

    expect(
      screen.getByText(/^minhanh/).closest("tr") as HTMLElement,
    ).toHaveTextContent("minhanh (bạn)");
  });

  describe("the last owner", () => {
    it("has a role that cannot be changed and cannot be removed", async () => {
      await setup();

      expect(
        screen.queryByRole("combobox", { name: "Vai trò của minhanh" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Xóa minhanh" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText(/^minhanh/).closest("tr") as HTMLElement,
      ).toHaveTextContent("Chủ shop");
    });

    it("is not removable by the viewer even when the server does not lock them", async () => {
      vi.spyOn(fakeStaffService, "list").mockResolvedValue([
        {
          id: "account-owner",
          last_active_at: null,
          locked: false,
          orders_today: 0,
          revenue_today_vnd: 0,
          role: "manager",
          username: "minhanh",
        },
        {
          id: "account-cashier",
          last_active_at: null,
          locked: false,
          orders_today: 0,
          revenue_today_vnd: 0,
          role: "cashier",
          username: "thuha",
        },
      ]);

      renderPage(<StaffRoute />);
      await screen.findByText("thuha");

      // Nobody removes themselves; the server refuses it as well.
      expect(
        screen.queryByRole("button", { name: "Xóa minhanh" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Xóa thuha" }),
      ).toBeInTheDocument();
    });
  });

  describe("changing a role", () => {
    it("offers every role that can be given, the owner's too", async () => {
      const user = await setup();

      await user.click(
        screen.getByRole("combobox", { name: "Vai trò của thuha" }),
      );

      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["Chủ shop", "Quản lý", "Thu ngân", "Thủ kho"]);
    });

    it("makes another member an owner, which frees the one who was the last", async () => {
      const changeRole = vi.spyOn(fakeStaffService, "changeRole");
      const user = await setup();

      expect(
        screen.queryByRole("combobox", { name: "Vai trò của minhanh" }),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("combobox", { name: "Vai trò của thuha" }),
      );
      await user.click(screen.getByRole("option", { name: "Chủ shop" }));

      await waitFor(() =>
        expect(changeRole).toHaveBeenCalledWith("account-cashier", "owner"),
      );
      // With two owners neither is the last, so the first one's role can change now.
      expect(
        await screen.findByRole("combobox", { name: "Vai trò của minhanh" }),
      ).toHaveTextContent("Chủ shop");
      // Nobody removes themselves; the other owner may be removed.
      expect(
        screen.queryByRole("button", { name: "Xóa minhanh" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Xóa thuha" }),
      ).toBeInTheDocument();
    });

    it("says why when the server will not take the owner role from the last owner", async () => {
      vi.spyOn(fakeStaffService, "list").mockResolvedValue([
        {
          id: "account-owner",
          last_active_at: null,
          locked: false,
          orders_today: 0,
          revenue_today_vnd: 0,
          role: "owner",
          username: "minhanh",
        },
        {
          id: "account-cashier",
          last_active_at: null,
          locked: false,
          orders_today: 0,
          revenue_today_vnd: 0,
          role: "cashier",
          username: "thuha",
        },
      ]);
      vi.spyOn(fakeStaffService, "changeRole").mockRejectedValue(
        new ServiceError(
          "The shop needs at least one owner: make another account an owner first.",
          422,
          "validation_error",
        ),
      );
      const user = userEvent.setup();

      renderPage(<StaffRoute />);
      await screen.findByText("thuha");
      await user.click(
        screen.getByRole("combobox", { name: "Vai trò của minhanh" }),
      );
      await user.click(screen.getByRole("option", { name: "Thu ngân" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không đổi được vai trò", {
          description:
            "The shop needs at least one owner: make another account an owner first.",
        }),
      );
    });

    it("asks the server, then says what the role is now", async () => {
      const changeRole = vi.spyOn(fakeStaffService, "changeRole");
      const user = await setup();

      await user.click(
        screen.getByRole("combobox", { name: "Vai trò của thuha" }),
      );
      await user.click(screen.getByRole("option", { name: "Quản lý" }));

      await waitFor(() =>
        expect(changeRole).toHaveBeenCalledWith("account-cashier", "manager"),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith("thuha giờ là quản lý"),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Vai trò của thuha" }),
        ).toHaveTextContent("Quản lý"),
      );
    });

    it("says why when the server refuses, and keeps the role it had", async () => {
      vi.spyOn(fakeStaffService, "changeRole").mockRejectedValueOnce(
        refused("You cannot change that account."),
      );
      const user = await setup();

      await user.click(
        screen.getByRole("combobox", { name: "Vai trò của thuha" }),
      );
      await user.click(screen.getByRole("option", { name: "Quản lý" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không đổi được vai trò", {
          description: "You cannot change that account.",
        }),
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(
        screen.getByRole("combobox", { name: "Vai trò của thuha" }),
      ).toHaveTextContent("Thu ngân");
    });
  });

  describe("removing a member", () => {
    it("takes the member off the team after confirming", async () => {
      const remove = vi.spyOn(fakeStaffService, "remove");
      const user = await setup();

      await user.click(screen.getByRole("button", { name: "Xóa thuha" }));

      const dialog = screen.getByRole("dialog");

      expect(dialog).toHaveTextContent("Xóa thuha?");
      expect(dialog).toHaveTextContent("thuha không vào được dashboard");

      await user.click(within(dialog).getByRole("button", { name: "Xóa" }));

      await waitFor(() =>
        expect(remove).toHaveBeenCalledWith("account-cashier"),
      );
      await waitFor(() =>
        expect(screen.queryByText("thuha")).not.toBeInTheDocument(),
      );
      expect(screen.getByText("quocbao")).toBeInTheDocument();
      expect(toast).toHaveBeenCalledWith("Đã xóa thuha");
    });

    it("keeps the member when backing out", async () => {
      const remove = vi.spyOn(fakeStaffService, "remove");
      const user = await setup();

      await user.click(screen.getByRole("button", { name: "Xóa thuha" }));
      await user.click(screen.getByRole("button", { name: "Giữ lại" }));

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.getByText("thuha")).toBeInTheDocument();
      expect(remove).not.toHaveBeenCalled();
    });

    it("keeps the dialog and says why when the server refuses", async () => {
      vi.spyOn(fakeStaffService, "remove").mockRejectedValueOnce(
        refused("You cannot remove yourself."),
      );
      const user = await setup();

      await user.click(screen.getByRole("button", { name: "Xóa thuha" }));
      await user.click(
        within(screen.getByRole("dialog")).getByRole("button", { name: "Xóa" }),
      );

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không xóa được", {
          description: "You cannot remove yourself.",
        }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(screen.getByText("thuha")).toBeInTheDocument();
    });
  });

  describe("adding a member", () => {
    async function openAdd() {
      const user = await setup();

      await user.click(screen.getByRole("button", { name: "Thêm nhân viên" }));

      return { user, dialog: screen.getByRole("dialog") };
    }

    it("asks for the username of the account they registered, and a role, but no name", async () => {
      const { dialog } = await openAdd();

      expect(within(dialog).getByLabelText("Username")).toBeInTheDocument();
      expect(
        within(dialog).getByRole("combobox", { name: "Vai trò" }),
      ).toBeInTheDocument();
      expect(within(dialog).queryByLabelText("Tên")).not.toBeInTheDocument();
      expect(dialog).not.toHaveTextContent(/Telegram/);
    });

    it("needs a valid username", async () => {
      const { user, dialog } = await openAdd();
      const add = within(dialog).getByRole("button", { name: "Thêm" });

      expect(add).toBeDisabled();

      await user.type(within(dialog).getByLabelText("Username"), "an");

      expect(add).toBeDisabled();

      // Three characters are enough, as for any account.
      await user.type(within(dialog).getByLabelText("Username"), "b");

      expect(add).toBeEnabled();
    });

    it.each(["an binh", "@anbinh", "an.binh"])(
      "refuses the username %j",
      async (username) => {
        const { user, dialog } = await openAdd();

        // Pasted, since typing a space at the end is dropped as the field trims.
        await user.click(within(dialog).getByLabelText("Username"));
        await user.paste(username);

        expect(
          within(dialog).getByRole("button", { name: "Thêm" }),
        ).toBeDisabled();
      },
    );

    it("refuses a username that is already on the team, ignoring case", async () => {
      const add = vi.spyOn(fakeStaffService, "add");
      const { user, dialog } = await openAdd();

      await user.type(within(dialog).getByLabelText("Username"), "ThuHa");

      expect(
        within(dialog).getByText(/đã có trong danh sách/),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByRole("button", { name: "Thêm" }),
      ).toBeDisabled();
      expect(add).not.toHaveBeenCalled();
    });

    it("adds the account as a cashier unless told otherwise", async () => {
      const add = vi.spyOn(fakeStaffService, "add");
      const { user, dialog } = await openAdd();

      await user.type(within(dialog).getByLabelText("Username"), "anbinh_01");
      await user.click(within(dialog).getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(add).toHaveBeenCalledWith("anbinh_01", "cashier"),
      );
      expect(await screen.findByText("anbinh_01")).toBeInTheDocument();
      expect(
        screen.getByRole("combobox", { name: "Vai trò của anbinh_01" }),
      ).toHaveTextContent("Thu ngân");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith("Đã thêm anbinh_01", {
        description: "Đăng nhập bằng tài khoản anbinh_01 với vai trò thu ngân.",
      });
    });

    it("adds the account with the role chosen", async () => {
      const add = vi.spyOn(fakeStaffService, "add");
      const { user, dialog } = await openAdd();

      await user.type(within(dialog).getByLabelText("Username"), "kimlien");
      await user.click(
        within(dialog).getByRole("combobox", { name: "Vai trò" }),
      );
      await user.click(screen.getByRole("option", { name: "Thủ kho" }));
      await user.click(within(dialog).getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(add).toHaveBeenCalledWith("kimlien", "stock-keeper"),
      );
    });

    it("says in a toast that no account has that username, and keeps the dialog to fix it", async () => {
      const { user, dialog } = await openAdd();

      await user.type(within(dialog).getByLabelText("Username"), "nobody_here");
      await user.click(within(dialog).getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không thêm được nhân viên", {
          description: "No account has that username.",
        }),
      );
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(within(dialog).getByLabelText("Username")).toHaveValue(
        "nobody_here",
      );
      expect(
        within(dialog).getByRole("button", { name: "Thêm" }),
      ).toBeEnabled();
      expect(toast.success).not.toHaveBeenCalled();
    });

    it("says in a toast that the account is staff already, when the list was behind", async () => {
      const { user, dialog } = await openAdd();

      // Another owner added them a moment ago: this list does not know yet.
      vi.spyOn(fakeStaffService, "list").mockResolvedValue([]);
      await user.type(within(dialog).getByLabelText("Username"), "kimlien");
      await fakeStaffService.add("kimlien", "cashier");
      await user.click(within(dialog).getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không thêm được nhân viên", {
          description: "That account is already staff.",
        }),
      );
    });

    it("offers every role, the owner's too, and adds an owner", async () => {
      const add = vi.spyOn(fakeStaffService, "add");
      const { user, dialog } = await openAdd();

      await user.type(within(dialog).getByLabelText("Username"), "kimlien");
      await user.click(
        within(dialog).getByRole("combobox", { name: "Vai trò" }),
      );

      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["Chủ shop", "Quản lý", "Thu ngân", "Thủ kho"]);

      await user.click(screen.getByRole("option", { name: "Chủ shop" }));
      await user.click(within(dialog).getByRole("button", { name: "Thêm" }));

      await waitFor(() => expect(add).toHaveBeenCalledWith("kimlien", "owner"));
    });
  });
});
