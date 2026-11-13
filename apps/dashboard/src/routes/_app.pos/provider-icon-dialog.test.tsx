import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProviderIcons from "@/components/provider-icons";
import { useProviderIcons } from "@/components/provider-icons-context";
import {
  disableFakeIcons,
  fakeIconAssignments,
  fakeIconService,
  refuseNextFakeIcon,
  resetFakeIcons,
} from "@/test/fake-icon-service";
import renderPage from "@/test/render-page";

import ProviderIconButton from "./provider-icon-button";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// The bucket is a fake in memory; a test watches what the dialog asks of it.
vi.mock("@/services/icons/icon-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/icons/icon-service")>()),
  iconService: (await import("@/test/fake-icon-service")).fakeIconService,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeIcons();
});

const png = (name = "logo.png", size = 1024) =>
  new File([new ArrayBuffer(size)], name, { type: "image/png" });

/** The button on a provider's card, once the shop's icons are known. */
async function openFor(
  user: ReturnType<typeof userEvent.setup>,
  provider = "ChatGPT",
  verb: "Đổi" | "Chọn" = "Đổi",
) {
  await user.click(
    await screen.findByRole("button", { name: `${verb} icon ${provider}` }),
  );

  return screen.findByRole("dialog", { name: `Icon của ${provider}` });
}

/** Waits until the shop's icons have been read and shown, so "no button" is a decision. */
function iconsRead() {
  const list = vi.spyOn(fakeIconService, "list");

  return async () => {
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => {
      await list.mock.results[0].value;
    });
  };
}

const card = (provider = "ChatGPT", role: "owner" | "cashier" = "owner") =>
  renderPage(
    <ProviderIcons>
      <ProviderIconButton provider={provider} />
    </ProviderIcons>,
    role,
  );

describe("the icon of a provider's card", () => {
  it("is a button for staff who manage stock, when the bucket is set up", async () => {
    card();

    expect(
      await screen.findByRole("button", { name: "Đổi icon ChatGPT" }),
    ).toBeVisible();
  });

  it("is only a picture for a role that may not manage stock", async () => {
    const read = iconsRead();
    const { container } = card("ChatGPT", "cashier");

    // The bucket is set up and the icons are in; it is the role that decides.
    await read();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("is only a picture while the bucket is not set up", async () => {
    disableFakeIcons();
    const read = iconsRead();
    const { container } = card();

    await read();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(container.querySelector("svg")).toBeInTheDocument();
  });

  it("finds a provider's icon by its slug, however the shop wrote the name", async () => {
    function Reader({ provider }: { provider: string }) {
      return <p>{useProviderIcons().iconOf(provider)?.key ?? "none"}</p>;
    }

    renderPage(
      <ProviderIcons>
        <Reader provider=" ChatGPT " />

        <Reader provider="claude" />
      </ProviderIcons>,
    );

    expect(await screen.findByText("icons/chatgpt-ba7816bf.png")).toBeVisible();
    expect(screen.getByText("none")).toBeVisible();
  });
});

describe("choosing an icon", () => {
  it("lists what the bucket holds, with the provider's icon picked", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);

    const current = await within(dialog).findByRole("button", {
      name: "chatgpt-ba7816bf.png",
    });
    expect(current).toHaveAttribute("aria-pressed", "true");
    expect(
      within(dialog).getByRole("button", { name: "claude-0f1e2d3c.png" }),
    ).toHaveAttribute("aria-pressed", "false");
    // A provider has an icon: there is no choice of none to take it away with.
    expect(
      within(dialog).queryByRole("button", { name: "Không dùng icon" }),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  it("wraps onto as many lines as the icons need, and scrolls when there are many", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });

    expect(within(dialog).getByRole("list")).toHaveClass(
      "flex-wrap",
      "overflow-y-auto",
    );
  });

  it("gives an icon to a provider that has none, and the button says to choose one", async () => {
    const user = userEvent.setup();
    card("Perplexity");

    const dialog = await openFor(user, "Perplexity", "Chọn");
    const save = within(dialog).getByRole("button", { name: "Lưu" });

    // Nothing is picked, and nothing can be saved until something is.
    expect(save).toBeDisabled();
    await user.click(
      await within(dialog).findByRole("button", {
        name: "claude-0f1e2d3c.png",
      }),
    );
    expect(save).toBeEnabled();
    await user.click(save);

    await waitFor(() =>
      expect(fakeIconAssignments()).toContainEqual(
        expect.objectContaining({
          key: "icons/claude-0f1e2d3c.png",
          provider: "perplexity",
        }),
      ),
    );
  });

  it("says there is nothing to pick from when the bucket is empty", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });
    const emptied = vi.spyOn(fakeIconService, "library").mockResolvedValue([]);

    // Asked again: the bucket now has none.
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));
    await openFor(user);

    expect(
      await screen.findByText(
        "Chưa có icon nào trong bucket. Tải icon mới lên để chọn.",
      ),
    ).toBeVisible();
    emptied.mockRestore();
  });

  it("gives the provider another icon once saved, and not before", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);

    await user.click(
      await within(dialog).findByRole("button", {
        name: "claude-0f1e2d3c.png",
      }),
    );
    expect(fakeIconAssignments()[0].key).toBe("icons/chatgpt-ba7816bf.png");

    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    await waitFor(() =>
      expect(fakeIconAssignments()).toEqual([
        {
          key: "icons/claude-0f1e2d3c.png",
          provider: "chatgpt",
          url: "https://cdn.example.com/icons/claude-0f1e2d3c.png",
        },
      ]),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã đổi icon của ChatGPT");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("changes nothing when it is closed with Hủy", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);

    await user.click(
      await within(dialog).findByRole("button", {
        name: "claude-0f1e2d3c.png",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Hủy" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(fakeIconAssignments()[0].key).toBe("icons/chatgpt-ba7816bf.png");
  });

  it("reports a refusal and stays open", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    refuseNextFakeIcon("assign", "That is not an icon's name.");

    await user.click(
      await within(dialog).findByRole("button", {
        name: "claude-0f1e2d3c.png",
      }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    expect(
      await within(dialog).findByText("That is not an icon's name."),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("says so when the bucket could not be read, and reads it again on request", async () => {
    const user = userEvent.setup();
    refuseNextFakeIcon("library", "The icon storage did not answer.");
    card();
    const dialog = await openFor(user);

    expect(
      await within(dialog).findByText("Không tải được danh sách icon."),
    ).toBeVisible();

    await user.click(within(dialog).getByRole("button", { name: "Thử lại" }));

    expect(
      await within(dialog).findByRole("button", {
        name: "claude-0f1e2d3c.png",
      }),
    ).toBeVisible();
  });
});

describe("uploading an icon", () => {
  it("puts a picture in the bucket and picks it, to be saved with Lưu", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);

    await user.upload(within(dialog).getByLabelText("Tệp icon"), png());

    const added = await within(dialog).findByRole("button", {
      name: "chatgpt-00000400.png",
    });
    expect(added).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeEnabled();
    // The bucket has it, the provider does not show it yet.
    expect(fakeIconAssignments()[0].key).toBe("icons/chatgpt-ba7816bf.png");
  });

  it("refuses what is not a PNG, JPEG, GIF or WebP before sending it", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const upload = vi.spyOn(fakeIconService, "upload");
    card();
    const dialog = await openFor(user);

    await user.upload(
      within(dialog).getByLabelText("Tệp icon"),
      new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
    );

    expect(
      await within(dialog).findByText("Chỉ nhận ảnh PNG, JPEG, GIF hoặc WebP."),
    ).toBeVisible();
    expect(upload).not.toHaveBeenCalled();
  });

  it("refuses a picture over 256 KB before sending it", async () => {
    const user = userEvent.setup();
    const upload = vi.spyOn(fakeIconService, "upload");
    card();
    const dialog = await openFor(user);

    await user.upload(
      within(dialog).getByLabelText("Tệp icon"),
      png("big.png", 256 * 1024 + 1),
    );

    expect(
      await within(dialog).findByText("Icon nặng tối đa 256 KB."),
    ).toBeVisible();
    expect(upload).not.toHaveBeenCalled();
  });

  it("reports why the API refused a picture", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    refuseNextFakeIcon("upload", "The icon storage did not answer.");

    await user.upload(within(dialog).getByLabelText("Tệp icon"), png());

    expect(
      await within(dialog).findByText("The icon storage did not answer."),
    ).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeDisabled();
  });
});

describe("deleting an icon", () => {
  /** The icon of a provider is shown by ChatGPT only; Claude's is not used. */
  const trash = (name: string) =>
    screen.getByRole("button", { name: `Xóa icon ${name}` });

  it("asks first, and says who shows the icon and that they lose it", async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(fakeIconService, "remove");
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });

    await user.click(trash("chatgpt-ba7816bf.png"));

    const confirm = await screen.findByRole("dialog", {
      name: "Xóa icon này?",
    });
    expect(confirm).toHaveTextContent("đang được dùng bởi ChatGPT");
    expect(confirm).toHaveTextContent("phải chọn icon khác");
    expect(confirm).toHaveTextContent("không hoàn tác được");
    expect(remove).not.toHaveBeenCalled();
  });

  it("says when nobody shows the icon", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });

    await user.click(trash("claude-0f1e2d3c.png"));

    expect(
      await screen.findByRole("dialog", { name: "Xóa icon này?" }),
    ).toHaveTextContent("Chưa nhà cung cấp nào dùng icon này.");
  });

  it("deletes the icon once confirmed, and the providers that showed it lose it", async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(fakeIconService, "remove");
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });

    await user.click(trash("chatgpt-ba7816bf.png"));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "Xóa icon này?" }),
      ).getByRole("button", { name: "Xóa icon" }),
    );

    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("icons/chatgpt-ba7816bf.png"),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã xóa icon");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "chatgpt-ba7816bf.png" }),
      ).not.toBeInTheDocument(),
    );
    expect(fakeIconAssignments()).toEqual([]);
    // The one that was picked is gone, so nothing is picked and there is nothing to save.
    expect(
      within(
        screen.getByRole("dialog", { name: "Icon của ChatGPT" }),
      ).getByRole("button", { name: "Lưu" }),
    ).toBeDisabled();
  });

  it("deletes nothing when it is not confirmed", async () => {
    const user = userEvent.setup();
    const remove = vi.spyOn(fakeIconService, "remove");
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });

    await user.click(trash("chatgpt-ba7816bf.png"));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "Xóa icon này?" }),
      ).getByRole("button", { name: "Hủy" }),
    );

    expect(remove).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Xóa icon này?" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "chatgpt-ba7816bf.png" }),
    ).toBeVisible();
    expect(fakeIconAssignments()).toHaveLength(1);
  });

  it("says why when it could not, and keeps the icon", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);
    await within(dialog).findByRole("button", { name: "claude-0f1e2d3c.png" });
    refuseNextFakeIcon("remove", "The icon storage did not answer.");

    await user.click(trash("claude-0f1e2d3c.png"));
    await user.click(
      within(
        await screen.findByRole("dialog", { name: "Xóa icon này?" }),
      ).getByRole("button", { name: "Xóa icon" }),
    );

    expect(
      await screen.findByText("The icon storage did not answer."),
    ).toBeVisible();
    expect(screen.getByRole("dialog", { name: "Xóa icon này?" })).toBeVisible();
    // Behind the question, which hides the form from a reader while it is open.
    expect(
      screen.getByRole("button", { hidden: true, name: "claude-0f1e2d3c.png" }),
    ).toBeInTheDocument();
  });
});
