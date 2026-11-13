import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ProviderIcons from "@/components/provider-icons";
import {
  disableFakeIcons,
  fakeIconAssignments,
  fakeIconService,
  refuseNextFakeIcon,
  resetFakeIcons,
} from "@/test/fake-icon-service";
import renderPage from "@/test/render-page";

import ProviderCreateDialog from "./provider-create-dialog";

vi.mock("@/services/icons/icon-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/icons/icon-service")>()),
  iconService: (await import("@/test/fake-icon-service")).fakeIconService,
}));

beforeEach(() => {
  vi.clearAllMocks();
  resetFakeIcons();
});

const png = (name = "logo.png") =>
  new File([new ArrayBuffer(2048)], name, { type: "image/png" });

const KNOWN = ["ChatGPT", "Claude", "Perplexity"];

function open(onContinue = vi.fn(), onClose = vi.fn()) {
  renderPage(
    <ProviderIcons>
      <ProviderCreateDialog
        known={KNOWN}
        onClose={onClose}
        onContinue={onContinue}
      />
    </ProviderIcons>,
  );

  return { onClose, onContinue };
}

const name = () => screen.getByLabelText("Tên nhà cung cấp");
const next = () => screen.getByRole("button", { name: "Tiếp tục" });

describe("ProviderCreateDialog", () => {
  it("cannot go on without a name", async () => {
    open();

    expect(next()).toBeDisabled();

    await userEvent.setup().type(name(), "   ");
    expect(next()).toBeDisabled();

    // Nothing in it that could be a name.
    await userEvent.setup().type(name(), "!!!");
    expect(next()).toBeDisabled();
  });

  it("goes on with the name as it was written, trimmed", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();

    await user.type(name(), "  Midjourney AI ");
    await user.click(next());

    await waitFor(() =>
      expect(onContinue).toHaveBeenCalledWith("Midjourney AI"),
    );
    // No icon was picked, so none was given.
    expect(fakeIconAssignments().map(({ provider }) => provider)).toEqual([
      "chatgpt",
    ]);
  });

  it("goes on with the name when Enter is pressed in it", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();

    await user.type(name(), "Midjourney{Enter}");

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("Midjourney"));
  });

  it("keeps the icon that was picked for the new provider's slug", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();

    await user.type(name(), "Midjourney AI");
    await user.click(
      await screen.findByRole("button", { name: "claude-0f1e2d3c.png" }),
    );
    await user.click(next());

    await waitFor(() =>
      expect(onContinue).toHaveBeenCalledWith("Midjourney AI"),
    );
    expect(fakeIconAssignments()).toContainEqual({
      key: "icons/claude-0f1e2d3c.png",
      provider: "midjourney-ai",
      url: "https://cdn.example.com/icons/claude-0f1e2d3c.png",
    });
  });

  it("puts a new picture in the bucket, named for the provider, and picks it", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();

    await user.type(name(), "Midjourney");
    await user.upload(screen.getByLabelText("Tệp icon"), png());
    expect(
      await screen.findByRole("button", { name: "midjourney-00000800.png" }),
    ).toHaveAttribute("aria-pressed", "true");

    await user.click(next());

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("Midjourney"));
    expect(fakeIconAssignments()).toContainEqual(
      expect.objectContaining({
        key: "icons/midjourney-00000800.png",
        provider: "midjourney",
      }),
    );
  });

  it("will not make a provider the shop already has, under whatever spelling", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();

    await user.type(name(), " perplexity ");

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Đã có nhà cung cấp này.",
    );
    expect(next()).toBeDisabled();

    await user.clear(name());
    await user.type(name(), "Perplexity Pro");

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(next()).toBeEnabled();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("stays where it is, and says why, when the icon could not be kept", async () => {
    const user = userEvent.setup();
    const { onContinue } = open();
    refuseNextFakeIcon("assign", "That is not an icon's name.");

    await user.type(name(), "Midjourney");
    await user.click(
      await screen.findByRole("button", { name: "claude-0f1e2d3c.png" }),
    );
    await user.click(next());

    expect(
      await screen.findByText("That is not an icon's name."),
    ).toBeVisible();
    expect(onContinue).not.toHaveBeenCalled();
  });

  it("is only a name while the bucket is not set up", async () => {
    disableFakeIcons();
    const user = userEvent.setup();
    const list = vi.spyOn(fakeIconService, "list");
    const { onContinue } = open();

    // Wait until the shop's icons were read, so "no icons" is the answer and not a delay.
    await waitFor(() => expect(list).toHaveBeenCalled());
    await user.type(name(), "Midjourney");

    expect(screen.queryByLabelText("Tệp icon")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Tải icon mới" }),
    ).not.toBeInTheDocument();

    await user.click(next());

    await waitFor(() => expect(onContinue).toHaveBeenCalledWith("Midjourney"));
  });

  it("closes with Hủy and changes nothing", async () => {
    const user = userEvent.setup();
    const { onClose, onContinue } = open();

    await user.type(name(), "Midjourney");
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Hủy" }),
    );

    expect(onClose).toHaveBeenCalled();
    expect(onContinue).not.toHaveBeenCalled();
    expect(fakeIconAssignments()).toHaveLength(1);
  });
});
