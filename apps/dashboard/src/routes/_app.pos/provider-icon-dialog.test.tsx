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
) {
  await user.click(
    await screen.findByRole("button", { name: `Đổi icon ${provider}` }),
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
    card("ChatGPT", "cashier");

    // The bucket is set up and the icons are in; it is the role that decides.
    await read();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("C")).toBeVisible();
  });

  it("is only a picture while the bucket is not set up", async () => {
    disableFakeIcons();
    const read = iconsRead();
    card();

    await read();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("C")).toBeVisible();
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
    expect(
      within(dialog).getByRole("button", { name: "Không dùng icon" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("button", { name: "Lưu" })).toBeDisabled();
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

  it("takes the icon away with the choice of none", async () => {
    const user = userEvent.setup();
    card();
    const dialog = await openFor(user);

    await user.click(
      await within(dialog).findByRole("button", { name: "Không dùng icon" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Lưu" }));

    await waitFor(() => expect(fakeIconAssignments()).toEqual([]));
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
