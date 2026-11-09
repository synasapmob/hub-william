import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import type { Role } from "@/services/sales/sales-types";
import {
  FAKE_OWNER_PASSWORD,
  fakeStockService,
  fakeStockServiceProducts,
  resetFakeStock,
} from "@/test/fake-stock-service";
import {
  fakeServiceStockService,
  resetFakeServiceStock,
} from "@/test/fake-service-stock-service";
import renderPage from "@/test/render-page";
import slugify from "@/utils/utils.slug";

import PosRoute from "./route";

// The toaster is not rendered here, so a toast is read from the calls made to it.
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
  }),
}));

// The page talks to the server through these services; a test gives them a shop
// in memory instead, and watches what the page asks of them.
vi.mock("@/services/stock/stock-service", async () => {
  const { fakeStockService } = await import("@/test/fake-stock-service");

  return { stockService: fakeStockService };
});

vi.mock("@/services/service-stock/service-stock-service", async () => {
  const { fakeServiceStockService } =
    await import("@/test/fake-service-stock-service");

  return { serviceStockService: fakeServiceStockService };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeStock();
  resetFakeServiceStock();
});

type User = ReturnType<typeof userEvent.setup>;

/** The button that edits a package, found by the package's name. */
const editButton = (title: RegExp) =>
  screen.getByRole("button", { name: title });
/** The row of a package under its provider's card. */
const row = (title: RegExp) => editButton(title).closest("li") as HTMLElement;
/** The names of the options of the list that is open, as a person reads them: the
 *  icon beside each is for the eye. */
const optionNames = () =>
  screen
    .getAllByRole("option")
    .map((option) => option.textContent?.replace(/^[A-Z](?=[A-Z])/, ""));

/** Chooses an agent in the provider popover of the form that is open. */
async function chooseProvider(user: User, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Nhà cung cấp" }));
  await user.click(screen.getByRole("option", { name }));
}

/** Presses the header's "Thêm hàng" and then Telegram, the first step being the kind. */
async function openTelegramForm(user: User) {
  await user.click(screen.getByRole("button", { name: "Thêm hàng" }));
  await user.click(screen.getByRole("button", { name: /^Telegram/ }));
}

/** The card of a provider of the given type, found by its name. */
const providerCard = (name: string, type = "Telegram") =>
  screen
    .getAllByRole("heading", { name })
    .map((heading) => heading.closest("section") as HTMLElement)
    .find((card) => within(card).queryByText(type)) as HTMLElement;
// The agents that have a ticket on sale, in Hub William's own order.
const HUB_WILLIAM_AGENTS = ["ChatGPT", "Claude"];
/** The names of the cards of a type, in the order they are shown. */
const cardNames = (type = "Telegram") =>
  screen
    .queryAllByRole("heading", { level: 2 })
    .filter((heading) =>
      within(heading.closest("section") as HTMLElement).queryByText(type),
    )
    .map((heading) => heading.textContent);
const dialog = () => screen.getByRole("dialog");
const refused = (message: string) =>
  new ServiceError(message, 422, "validation_error");

/** Opens the page once its stock has arrived. */
async function setup(options?: Parameters<typeof userEvent.setup>[0]) {
  const user = userEvent.setup(options);

  renderPage(<PosRoute />);
  await screen.findByRole("button", { name: /Claude Pro 1 tháng/ });

  return user;
}

async function setAdjust(user: User, label: string, value: string) {
  await user.clear(screen.getByLabelText(label));
  await user.type(screen.getByLabelText(label), value);
}

describe("PosRoute, the list", () => {
  it("shows one card for each provider, in the shop's order, with every package under it", async () => {
    const list = vi.spyOn(fakeStockService, "list");

    await setup();

    expect(list).toHaveBeenCalledTimes(1);
    expect(cardNames()).toEqual(["ChatGPT", "Claude", "Gemini"]);
    // The packages: a ticket of Hub William's is edited as "Sửa gói …", so it is not one.
    expect(
      screen.getAllByRole("button", { name: /^Sửa (?!gói )/ }),
    ).toHaveLength(7);
    // Each card says what it holds, and what it is.
    expect(providerCard("Claude")).toHaveTextContent("2 gói");
    expect(providerCard("Claude")).toHaveTextContent("10 còn");
    expect(providerCard("ChatGPT")).toHaveTextContent("4 gói");
    expect(providerCard("Claude")).toHaveTextContent("Telegram");
    expect(
      within(providerCard("Claude")).getByRole("button", {
        name: /Claude Pro 1 tháng/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps the order the shop gave, not alphabetical", async () => {
    const shop = fakeStockServiceProducts();
    const of = (provider: string) =>
      shop.filter((item) => item.provider === provider);

    // Gemini's packages come first, then ChatGPT's, then Claude's.
    vi.spyOn(fakeStockService, "list").mockResolvedValue([
      ...of("Gemini"),
      ...of("ChatGPT"),
      ...of("Claude"),
    ]);
    renderPage(<PosRoute />);

    await screen.findAllByRole("button", { name: /^Sửa / });

    expect(cardNames()).toEqual(["Gemini", "ChatGPT", "Claude"]);
  });

  it("edits with an icon button on each package, and not by pressing the row", async () => {
    const user = await setup();

    await user.click(row(/Claude Pro 1 tháng/));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(editButton(/Claude Pro 1 tháng/)).toHaveTextContent("");

    await user.click(editButton(/Claude Pro 1 tháng/));

    expect(dialog()).toHaveTextContent("Sửa Claude Pro 1 tháng");
  });

  it("lists every package of a provider, however many", async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({
      ...structuredClone(
        fakeStockServiceProducts()[3], // Claude Pro
      ),
      plan: `Gói ${index + 1}`,
      slug: `claude-goi-${index + 1}`,
    }));

    vi.spyOn(fakeStockService, "list").mockResolvedValue(many);
    renderPage(<PosRoute />);

    expect(
      await screen.findAllByRole("button", { name: /^Sửa Claude Gói/ }),
    ).toHaveLength(9);
    expect(screen.queryByText(/Xem thêm/)).not.toBeInTheDocument();
    expect(providerCard("Claude")).toHaveTextContent("9 gói");
  });

  it("shows a loading state until the stock arrives", () => {
    vi.spyOn(fakeStockService, "list").mockReturnValue(new Promise(() => {}));

    renderPage(<PosRoute />);

    expect(screen.getByRole("status")).toHaveTextContent("Đang tải kho hàng");
    expect(screen.queryByRole("heading", { level: 2 })).not.toBeInTheDocument();
  });

  it("says why the stock could not be loaded, and tries again on request", async () => {
    const user = userEvent.setup();

    vi.spyOn(fakeStockService, "list").mockRejectedValueOnce(
      new ServiceError("Không kết nối được tới máy chủ.", null, null),
    );
    renderPage(<PosRoute />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Không kết nối được tới máy chủ.",
    );

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(
      await screen.findByRole("button", { name: /Claude Pro 1 tháng/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows how much is left on each package", async () => {
    await setup();

    expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Còn 10");
    expect(row(/ChatGPT Pro 1 tháng/)).toHaveTextContent("Còn 4 · sắp hết");
    expect(row(/Claude Max 5x/)).toHaveTextContent("Hết hàng");
  });

  it("marks a hot package and a hidden one", async () => {
    await setup();

    expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Hot");
    expect(row(/ChatGPT Go 1 tháng/)).toHaveTextContent("Đang ẩn");
  });

  describe("search", () => {
    it("finds a package by name", async () => {
      const user = await setup();

      await user.type(screen.getByLabelText("Tìm hàng"), "claude");

      expect(editButton(/Claude Pro 1 tháng/)).toBeInTheDocument();
      expect(editButton(/Claude Max 5x/)).toBeInTheDocument();
      // A provider with nothing that matches has no card.
      expect(
        screen.queryByRole("heading", { name: "Gemini" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("heading", { name: "ChatGPT" }),
      ).not.toBeInTheDocument();
    });

    it("says so when nothing matches", async () => {
      const user = await setup();

      await user.type(screen.getByLabelText("Tìm hàng"), "khong-co-gi");

      expect(screen.getByText(/Không có hàng nào khớp/)).toBeInTheDocument();
    });
  });

  describe("filter by type", () => {
    const typeFilter = () =>
      screen.getByRole("combobox", { name: "Lọc theo loại" });

    it("starts on every type and offers each", async () => {
      const user = await setup();

      expect(typeFilter()).toHaveTextContent("Mọi loại");

      await user.click(typeFilter());

      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["Mọi loại", "Telegram", "Hub William"]);
    });

    it("keeps the packages on Telegram", async () => {
      const user = await setup();

      await user.click(typeFilter());
      await user.click(screen.getByRole("option", { name: "Telegram" }));

      expect(screen.getAllByRole("button", { name: /^Sửa / })).toHaveLength(7);
    });

    it("shows Hub William's own stock, and no package, for Hub William", async () => {
      const user = await setup();

      await user.click(typeFilter());
      await user.click(screen.getByRole("option", { name: "Hub William" }));

      // Only the agents that have a ticket on sale have a card, in Hub William's
      // own order.
      expect(cardNames("Hub William")).toEqual(HUB_WILLIAM_AGENTS);
      expect(cardNames("Telegram")).toEqual([]);
      expect(
        screen.queryByRole("button", { name: /^Sửa (?!gói )/ }),
      ).not.toBeInTheDocument();
      // Adding is one button, whatever is shown: it first asks which of the two.
      expect(
        screen.getByRole("button", { name: "Thêm hàng" }),
      ).toBeInTheDocument();
    });

    it("shows only the packages for Telegram, and both for every type", async () => {
      const user = await setup();

      expect(cardNames("Hub William")).toEqual(HUB_WILLIAM_AGENTS);
      expect(cardNames("Telegram")).toEqual(["ChatGPT", "Claude", "Gemini"]);

      await user.click(typeFilter());
      await user.click(screen.getByRole("option", { name: "Telegram" }));

      expect(cardNames("Hub William")).toEqual([]);
      expect(cardNames("Telegram")).toEqual(["ChatGPT", "Claude", "Gemini"]);
    });

    it("shows no card at all when nothing is on sale, and still lets a ticket be added from the header", async () => {
      vi.spyOn(fakeServiceStockService, "listings").mockResolvedValue([]);
      const user = await setup();

      await user.click(typeFilter());
      await user.click(screen.getByRole("option", { name: "Hub William" }));

      expect(cardNames("Hub William")).toEqual([]);
      expect(
        screen.getByText("Chưa có hàng nào trong mục này."),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thêm hàng" }),
      ).toBeInTheDocument();
    });
  });
});

describe("PosRoute, adding", () => {
  async function openAdd(options?: Parameters<typeof userEvent.setup>[0]) {
    const user = await setup(options);

    await openTelegramForm(user);

    return user;
  }

  async function fillPackage(user: User, plan = "Pro 2 tháng") {
    await chooseProvider(user, "Claude");
    await user.type(screen.getByLabelText("Tên gói"), plan);
    await user.type(screen.getByLabelText("Giá (₫)"), "879000");
  }

  it("adds a package from a provider's card, with the provider filled in and the cursor on the name", async () => {
    const create = vi.spyOn(fakeStockService, "create");
    const user = await setup();

    await user.click(
      within(providerCard("Claude")).getByRole("button", {
        name: "Thêm gói cho Claude",
      }),
    );

    expect(dialog()).toHaveTextContent("Thêm hàng");
    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveTextContent("Claude");
    expect(screen.getByLabelText("Tên gói")).toHaveFocus();
    expect(screen.getByLabelText("Tên gói")).toHaveValue("");

    await user.type(screen.getByLabelText("Tên gói"), "Pro 2 tháng");
    await user.type(screen.getByLabelText("Giá (₫)"), "879000");
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await screen.findByRole("button", { name: /Claude Pro 2 tháng/ });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ plan: "Pro 2 tháng", provider: "Claude" }),
    );
    expect(
      within(providerCard("Claude")).getByRole("button", {
        name: /Claude Pro 2 tháng/,
      }),
    ).toBeInTheDocument();
  });

  it("starts empty, on the provider, when added from the header", async () => {
    await openAdd();

    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveTextContent("Chọn nhà cung cấp");
    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveFocus();
  });

  it("offers the agents Hub William supports as a fixed list, in its own order", async () => {
    const user = await openAdd();

    await user.click(screen.getByRole("combobox", { name: "Nhà cung cấp" }));

    expect(optionNames()).toEqual([
      "ChatGPT",
      "Gemini",
      "Claude",
      "DeepSeek",
      "Grok",
      "Groq",
    ]);
  });

  it("keeps a provider the shop has under a name that is not one of those, so what it has can be edited", async () => {
    vi.spyOn(fakeStockService, "list").mockResolvedValue([
      ...fakeStockServiceProducts(),
      { ...fakeStockServiceProducts()[0], provider: "Acme", slug: "acme-plus" },
    ]);
    const user = await openAdd();

    await user.click(screen.getByRole("combobox", { name: "Nhà cung cấp" }));

    expect(optionNames()).toEqual([
      "ChatGPT",
      "Gemini",
      "Claude",
      "DeepSeek",
      "Grok",
      "Groq",
      "Acme",
    ]);
  });

  it("cannot be typed into: a provider is chosen, so it cannot be misspelt into a card of its own", async () => {
    await openAdd();

    expect(
      screen.queryByRole("textbox", { name: "Nhà cung cấp" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Nhà cung cấp mới/)).not.toBeInTheDocument();
  });

  it("gives an agent that has no package yet a card of its own once its first is saved", async () => {
    const user = await openAdd();

    await chooseProvider(user, "DeepSeek");
    await user.type(screen.getByLabelText("Tên gói"), "Pro 1 tháng");
    await user.type(screen.getByLabelText("Giá (₫)"), "199000");
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await screen.findByRole("button", { name: /DeepSeek Pro 1 tháng/ });

    // A card of Telegram's, beside the one of Hub William's it already had.
    expect(cardNames()).toEqual(["ChatGPT", "Claude", "Gemini", "DeepSeek"]);
    expect(providerCard("DeepSeek")).toHaveTextContent("1 gói");
  });

  it("opens an empty form for a Telegram package, with no type to choose", async () => {
    await openAdd();

    expect(dialog()).toHaveTextContent("Thêm hàng");
    expect(
      screen.queryByRole("combobox", { name: "Loại hàng" }),
    ).not.toBeInTheDocument();
    expect(dialog()).not.toHaveTextContent("Hub William");
    expect(screen.getByLabelText("Tên gói")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
  });

  it("sends the package to the server, then shows it", async () => {
    const create = vi.spyOn(fakeStockService, "create");
    const user = await openAdd();

    await fillPackage(user);
    await setAdjust(user, "Tồn kho ban đầu", "5");
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await screen.findByRole("button", { name: /Claude Pro 2 tháng/ });

    expect(row(/Claude Pro 2 tháng/)).toHaveTextContent("Còn 5");
    // Under the provider it already has, not in a card of its own.
    expect(cardNames()).toEqual(["ChatGPT", "Claude", "Gemini"]);
    expect(
      within(providerCard("Claude")).getByRole("button", {
        name: /Claude Pro 2 tháng/,
      }),
    ).toBeInTheDocument();
    expect(create).toHaveBeenCalledWith({
      delivers_accounts: false,
      hot: false,
      image_url: "",
      listed: true,
      plan: "Pro 2 tháng",
      price_vnd: 879_000,
      provider: "Claude",
      stock: 5,
      variant: null,
      warranty: "WF",
      warranty_note: null,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Đã thêm Claude Pro 2 tháng");
  });

  it("sends the variant, the warranty and the flags that were chosen", async () => {
    const create = vi.spyOn(fakeStockService, "create");
    const user = await openAdd();

    await chooseProvider(user, "Grok");
    await user.type(screen.getByLabelText("Tên gói"), "Heavy (Gia đình)");
    await user.type(screen.getByLabelText("Giá (₫)"), "100000");
    await user.click(screen.getByRole("combobox", { name: "Bảo hành" }));
    await user.click(screen.getByRole("option", { name: "Bảo hành 7 ngày" }));
    await user.click(screen.getByRole("switch", { name: "Hot" }));
    await user.click(screen.getByRole("switch", { name: "Đang bán" }));
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await screen.findByRole("button", { name: /Grok Heavy \(Gia đình\)/ });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        hot: true,
        listed: false,
        plan: "Heavy",
        variant: "Gia đình",
        warranty: "W7D",
        warranty_note: null,
      }),
    );
  });

  it("says nothing about Telegram when the message is left empty", async () => {
    const user = await openAdd();

    expect(screen.getByLabelText("Tin nhắn Telegram (tùy chọn)")).toHaveValue(
      "",
    );

    const announce = vi.spyOn(fakeStockService, "announce");

    await fillPackage(user);
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.success).toHaveBeenCalledWith("Đã thêm Claude Pro 2 tháng");
    expect(toast.warning).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("treats a message of only spaces as empty", async () => {
    const announce = vi.spyOn(fakeStockService, "announce");
    const user = await openAdd();

    await fillPackage(user);
    await user.type(
      screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
      "   ",
    );
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
    expect(toast.warning).not.toHaveBeenCalled();
    expect(announce).not.toHaveBeenCalled();
  });

  it("has the bot send the message as written once the package is saved, and says where it went", async () => {
    const announce = vi.spyOn(fakeStockService, "announce");
    const create = vi.spyOn(fakeStockService, "create");
    const user = await openAdd();

    await fillPackage(user);
    await user.type(
      screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
      "Hàng mới về",
    );
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Đã thêm Claude Pro 2 tháng", {
        description:
          "Bot đã đăng lên kênh và đang gửi cho 12 người đã bấm Start.",
      }),
    );
    // The button opens the package the server saved.
    expect(announce).toHaveBeenCalledWith("Hàng mới về", "claude-pro-2-thang");
    // The package is saved before anyone is told about it.
    expect(create.mock.invocationCallOrder[0]).toBeLessThan(
      announce.mock.invocationCallOrder[0],
    );
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it.each([
    [
      { audience: 3, channel: false },
      "Bot đang gửi cho 3 người đã bấm Start. Chưa có kênh nào nhận tin.",
    ],
    [
      { audience: 0, channel: false },
      "Bot không có kênh hay chat nào để gửi tới.",
    ],
  ])(
    "reports what the bot reached, nothing more: %j",
    async (reached, text) => {
      vi.spyOn(fakeStockService, "announce").mockResolvedValueOnce(reached);
      const user = await openAdd();

      await fillPackage(user);
      await user.type(
        screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
        "Hàng mới về",
      );
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Đã thêm Claude Pro 2 tháng",
          {
            description: text,
          },
        ),
      );
    },
  );

  it.each([
    [501, "The dashboard is not connected to the Telegram bot."],
    [502, "The Telegram bot did not answer."],
  ])(
    "keeps the saved package and says plainly the message was not sent when the API answers %i",
    async (status, message) => {
      vi.spyOn(fakeStockService, "announce").mockRejectedValueOnce(
        new ServiceError(message, status, null),
      );
      const user = await openAdd();

      await fillPackage(user);
      await user.type(
        screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
        "Hàng mới về",
      );
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(
          "Đã thêm Claude Pro 2 tháng",
          { description: `Tin nhắn Telegram chưa được gửi: ${message}` },
        ),
      );
      // It must not claim a message went out.
      expect(toast.success).not.toHaveBeenCalled();
      expect(
        await screen.findByRole("button", { name: /Claude Pro 2 tháng/ }),
      ).toBeVisible();
    },
  );

  describe("accounts handed out automatically", () => {
    const accountsField = () =>
      screen.getByLabelText("Nạp tài khoản (tùy chọn)");
    const switchOn = (user: User) =>
      user.click(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      );

    it("swaps the stock stepper for a box for the accounts when switched on", async () => {
      const user = await openAdd();

      expect(screen.getByText("Tồn kho ban đầu")).toBeInTheDocument();
      expect(screen.queryByLabelText(/Nạp tài khoản/)).not.toBeInTheDocument();

      await switchOn(user);

      expect(screen.queryByText("Tồn kho ban đầu")).not.toBeInTheDocument();
      expect(accountsField()).toHaveValue("");
    });

    it("makes the package with none and loads the accounts after it is saved", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const load = vi.spyOn(fakeStockService, "loadAccounts");
      const user = await openAdd();

      await fillPackage(user);
      await switchOn(user);
      await user.click(accountsField());
      await user.paste("one@example.test|first\n\n two@example.test | second ");
      expect(screen.getByText("2 tài khoản")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(load).toHaveBeenCalledWith(
          "claude-pro-2-thang",
          "one@example.test|first\n\n two@example.test | second",
        ),
      );
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({ delivers_accounts: true, stock: 0 }),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Đã thêm Claude Pro 2 tháng",
          { description: "Trong kho còn 2 tài khoản." },
        ),
      );
      // The accounts are not kept: the box is gone with the form.
      expect(screen.queryByLabelText(/Nạp tài khoản/)).not.toBeInTheDocument();
    });

    it("loads nothing when no account was typed", async () => {
      const load = vi.spyOn(fakeStockService, "loadAccounts");
      const user = await openAdd();

      await fillPackage(user);
      await switchOn(user);
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() => expect(toast.success).toHaveBeenCalled());
      expect(load).not.toHaveBeenCalled();
    });

    it("names the line that is wrong without quoting it, and will not save", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const user = await openAdd();

      await fillPackage(user);
      await switchOn(user);
      await user.click(accountsField());
      await user.paste("good@example.test|fine\nsecret-line-without-a-bar");

      expect(
        screen.getByText("Dòng 2 không đúng dạng email|mật khẩu."),
      ).toBeInTheDocument();
      // The message names the line and says nothing of what it holds.
      expect(screen.getByText(/^Dòng 2/).textContent).not.toContain(
        "secret-line",
      );
      expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
      expect(create).not.toHaveBeenCalled();
    });

    it("says so and sends no restock message when the accounts did not go in", async () => {
      vi.spyOn(fakeStockService, "loadAccounts").mockRejectedValueOnce(
        new ServiceError("Loading accounts needs a key.", 501, "not_available"),
      );
      const announce = vi.spyOn(fakeStockService, "announce");
      const user = await openAdd();

      await fillPackage(user);
      await switchOn(user);
      await user.click(accountsField());
      await user.paste("one@example.test|first");
      await user.type(
        screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
        "Hàng mới về",
      );
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(toast.warning).toHaveBeenCalledWith(
          "Đã thêm Claude Pro 2 tháng",
          {
            description: expect.stringContaining(
              "Chưa nạp được tài khoản: Loading accounts needs a key.",
            ),
          },
        ),
      );
      expect(announce).not.toHaveBeenCalled();
    });
  });

  describe("the warranty note", () => {
    const noteField = () =>
      screen.getByLabelText("Ghi chú bảo hành (tùy chọn)");

    it("is saved with the new package, as written", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const user = await openAdd();

      await fillPackage(user);
      await user.type(noteField(), "  Bảo hành login check 1 tiếng  ");
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            warranty_note: "Bảo hành login check 1 tiếng",
          }),
        ),
      );
    });

    it("keeps the line breaks, blank lines and spacing it was typed with, and trims only its ends", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const user = await openAdd();

      await fillPackage(user);
      await user.click(noteField());
      await user.paste("\n Dòng một\n\n  Dòng ba   có dấu cách\n\n");
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({
            warranty_note: "Dòng một\n\n  Dòng ba   có dấu cách",
          }),
        ),
      );
    });

    it("counts what is typed in characters, line breaks included, as the server does", async () => {
      const user = await openAdd();

      await fillPackage(user);
      await user.click(noteField());
      await user.paste("ab\ncd");

      expect(screen.getByText("5/200")).toBeInTheDocument();

      await user.clear(noteField());
      // An emoji is one character, though JavaScript counts it as two.
      await user.paste("😀".repeat(200));

      expect(screen.getByText("200/200")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Thêm" })).toBeEnabled();
    });

    it("asks for the standard note when it is left empty", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const user = await openAdd();

      await fillPackage(user);
      await user.click(screen.getByRole("button", { name: "Thêm" }));

      await waitFor(() =>
        expect(create).toHaveBeenCalledWith(
          expect.objectContaining({ warranty_note: null }),
        ),
      );
    });

    it("cannot be longer than 200 characters, and says so", async () => {
      const create = vi.spyOn(fakeStockService, "create");
      const user = await openAdd();

      await fillPackage(user);
      await user.click(noteField());
      await user.paste("a".repeat(201));

      expect(screen.getByText("201/200")).toBeInTheDocument();
      expect(
        screen.getByText("Ghi chú bảo hành dài tối đa 200 ký tự."),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
      expect(create).not.toHaveBeenCalled();
    });
  });

  it("sends no message when the package could not be saved", async () => {
    const announce = vi.spyOn(fakeStockService, "announce");

    vi.spyOn(fakeStockService, "create").mockRejectedValueOnce(
      refused("That product already exists."),
    );

    const user = await openAdd();

    await fillPackage(user);
    await user.type(
      screen.getByLabelText("Tin nhắn Telegram (tùy chọn)"),
      "Hàng mới về",
    );
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(announce).not.toHaveBeenCalled();
  });

  it("refuses a package whose slug already exists, before asking the server", async () => {
    const create = vi.spyOn(fakeStockService, "create");
    const user = await openAdd();

    await chooseProvider(user, "Claude");
    await user.type(screen.getByLabelText("Tên gói"), "Pro 1 tháng");
    await user.type(screen.getByLabelText("Giá (₫)"), "459000");

    expect(screen.getByText("Đã có gói này rồi.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the form open, with what was typed, when the server refuses", async () => {
    vi.spyOn(fakeStockService, "create").mockRejectedValueOnce(
      new ServiceError("That product already exists.", 409, "already_exists"),
    );
    const user = await openAdd();

    await fillPackage(user);
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Không lưu được", {
        description: "That product already exists.",
      }),
    );
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByLabelText("Tên gói")).toHaveValue("Pro 2 tháng");
    expect(screen.getByRole("button", { name: "Thêm" })).toBeEnabled();

    // Sent again, it goes through.
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    expect(
      await screen.findByRole("button", { name: /Claude Pro 2 tháng/ }),
    ).toBeInTheDocument();
  });

  it("cannot be sent twice while it is on its way", async () => {
    let finish: () => void = () => {};
    const create = vi.spyOn(fakeStockService, "create").mockReturnValueOnce(
      new Promise((resolve) => {
        finish = () =>
          resolve({
            hot: false,
            image_url: "",
            listed: true,
            on_hand: 0,
            plan: "Pro 2 tháng",
            price_vnd: 879_000,
            provider: "Claude",
            reserved: 0,
            slug: "claude-pro-2-thang",
            type: "telegram",
            variant: null,
            warranty: "WF",
            warranty_note: null,
            delivers_accounts: false,
          });
      }),
    );
    const user = await openAdd();

    await fillPackage(user);
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();

    finish();
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(create).toHaveBeenCalledTimes(1);
  });

  it.each(["1000000001", "-1", "abc"])(
    "refuses the price %s",
    async (price) => {
      const user = await openAdd();

      await chooseProvider(user, "Grok");
      await user.type(screen.getByLabelText("Tên gói"), "Heavy");
      await user.type(screen.getByLabelText("Giá (₫)"), price);

      expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
    },
  );

  it("refuses a starting stock above 1,000,000 or below zero", async () => {
    const user = await openAdd();

    await chooseProvider(user, "Grok");
    await user.type(screen.getByLabelText("Tên gói"), "Heavy");
    await user.type(screen.getByLabelText("Giá (₫)"), "100000");
    await setAdjust(user, "Tồn kho ban đầu", "1000001");

    expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();

    await setAdjust(user, "Tồn kho ban đầu", "-1");

    expect(screen.getByRole("button", { name: "Thêm" })).toBeDisabled();
  });
});

describe("PosRoute, editing", () => {
  async function openEdit(title: RegExp) {
    const user = await setup();

    await user.click(editButton(title));

    return user;
  }

  /** The fields of Claude Pro as the page sends them on an edit. */
  const claudePro = {
    delivers_accounts: false,
    hot: true,
    image_url: "https://picsum.photos/400/300?random=4",
    listed: true,
    plan: "Pro 1 tháng",
    price_vnd: 459_000,
    provider: "Claude",
    variant: null,
    warranty: "WF",
    warranty_note: null,
  };

  it("starts on the first field", async () => {
    await openEdit(/Claude Pro 1 tháng/);

    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveFocus();
  });

  it("opens a card with the form already filled in", async () => {
    await openEdit(/Claude Pro 1 tháng/);

    expect(dialog()).toHaveTextContent("Sửa Claude Pro 1 tháng");
    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveTextContent("Claude");
    expect(screen.getByLabelText("Tên gói")).toHaveValue("Pro 1 tháng");
    expect(screen.getByLabelText("Giá (₫)")).toHaveValue("459000");
    expect(screen.getByRole("switch", { name: "Đang bán" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Hot" })).toBeChecked();
    expect(
      screen.getByText(/Trong kho 12, đang giữ chỗ 2/),
    ).toBeInTheDocument();
  });

  describe("stock", () => {
    it("saves the fields, then puts the difference in stock", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "10");

      expect(
        screen.getByText(/Sau khi lưu: 22 trong kho, bán được 20/),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Còn 20"),
      );
      expect(update).toHaveBeenCalledWith("claude-pro-1-thang", claudePro);
      expect(changeStock).toHaveBeenCalledWith("claude-pro-1-thang", 10);
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        changeStock.mock.invocationCallOrder[0],
      );
      expect(toast.success).toHaveBeenCalledWith("Đã lưu Claude Pro 1 tháng");
    });

    it("takes stock away", async () => {
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "-5");

      expect(
        screen.getByText(/Sau khi lưu: 7 trong kho, bán được 5/),
      ).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Còn 5"),
      );
      expect(changeStock).toHaveBeenCalledWith("claude-pro-1-thang", -5);
    });

    it("leaves the count alone when only a field changed", async () => {
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.clear(screen.getByLabelText("Giá (₫)"));
      await user.type(screen.getByLabelText("Giá (₫)"), "399000");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(changeStock).not.toHaveBeenCalled();
      expect(row(/Claude Pro 1 tháng/)).toHaveTextContent(/399\.000/);
    });

    it("steps the amount by one with the buttons", async () => {
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(screen.getByRole("button", { name: "Tăng 1" }));
      await user.click(screen.getByRole("button", { name: "Tăng 1" }));
      await user.click(screen.getByRole("button", { name: "Giảm 1" }));

      expect(screen.getByLabelText("Thêm hoặc bớt tồn kho")).toHaveValue("1");
    });

    it("refuses, before asking the server, to take more than there is", async () => {
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "-12");

      expect(screen.getByRole("button", { name: "Lưu" })).toBeEnabled();

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "-13");

      expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
      expect(screen.getByText(/không thể xuống dưới 0/)).toBeInTheDocument();
      expect(changeStock).not.toHaveBeenCalled();
    });

    it("refuses to add more than 100,000 in one go, or a fraction", async () => {
      const user = await openEdit(/Claude Pro 1 tháng/);

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "100001");

      expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();

      await setAdjust(user, "Thêm hoặc bớt tồn kho", "2.5");

      expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
    });

    it("says why when the server refuses the change, and shows what did land", async () => {
      vi.spyOn(fakeStockService, "changeStock").mockRejectedValueOnce(
        refused("That takes out more units than there are in stock."),
      );
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.clear(screen.getByLabelText("Giá (₫)"));
      await user.type(screen.getByLabelText("Giá (₫)"), "399000");
      await setAdjust(user, "Thêm hoặc bớt tồn kho", "-5");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không lưu được", {
          description: "That takes out more units than there are in stock.",
        }),
      );
      // The form stays open to be fixed...
      expect(dialog()).toBeInTheDocument();
      // ...and the price, which did land, shows on the package behind it.
      await waitFor(() =>
        expect(
          screen
            .getByRole("button", { hidden: true, name: /Claude Pro 1 tháng/ })
            .closest("li"),
        ).toHaveTextContent(/399\.000/),
      );
    });
  });

  describe("fields", () => {
    it("renames a package and keeps its slug", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.clear(screen.getByLabelText("Tên gói"));
      await user.type(screen.getByLabelText("Tên gói"), "Pro 12 tháng");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      expect(
        await screen.findByRole("button", { name: /Claude Pro 12 tháng/ }),
      ).toBeInTheDocument();
      expect(update).toHaveBeenCalledWith(
        "claude-pro-1-thang",
        expect.objectContaining({ plan: "Pro 12 tháng" }),
      );
      expect(
        screen.queryByRole("button", { name: /Claude Pro 1 tháng/ }),
      ).not.toBeInTheDocument();
    });

    it("takes a package off sale", async () => {
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(screen.getByRole("switch", { name: "Đang bán" }));
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Đang ẩn"),
      );
    });

    it("leaves the item alone, and asks the server nothing, when closed without saving", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.clear(screen.getByLabelText("Tên gói"));
      await user.type(screen.getByLabelText("Tên gói"), "Đổi tên");
      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(editButton(/Claude Pro 1 tháng/)).toBeInTheDocument();
      expect(update).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });

  describe("accounts handed out automatically", () => {
    it("shows on the list which packages hand them out", async () => {
      await setup();

      expect(row(/Claude Max 5x/)).toHaveTextContent("Giao tự động");
      expect(row(/Claude Pro 1 tháng/)).not.toHaveTextContent("Giao tự động");
    });

    it("has no stepper, a switch that holds while accounts are left, and says how many", async () => {
      await openEdit(/Claude Max 5x/);

      const delivers = screen.getByRole("switch", {
        name: "Giao tài khoản tự động",
      });

      expect(delivers).toBeChecked();
      // Accounts not sold are dealt with before the package stops handing them out.
      expect(delivers).toBeDisabled();
      expect(
        screen.getByText(/Còn 4 tài khoản chưa bán\. Xóa hết/),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Thêm hoặc bớt tồn kho"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByLabelText("Nạp thêm tài khoản (tùy chọn)"),
      ).toHaveValue("");
      expect(
        screen.getByText(/Trong kho 4 tài khoản chưa bán/),
      ).toBeInTheDocument();
    });

    it("loads more accounts and leaves the count to them", async () => {
      const load = vi.spyOn(fakeStockService, "loadAccounts");
      const change = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Claude Max 5x/);

      await user.click(screen.getByLabelText("Nạp thêm tài khoản (tùy chọn)"));
      await user.paste("one@example.test|first\ntwo@example.test|second");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(load).toHaveBeenCalledWith(
          "claude-max-5x-1-thang",
          "one@example.test|first\ntwo@example.test|second",
        ),
      );
      expect(change).not.toHaveBeenCalled();
      await waitFor(() =>
        expect(row(/Claude Max 5x/)).toHaveTextContent("Còn 2"),
      );
    });

    it("offers the switch on a package that does not hand out accounts, off, with its stepper", async () => {
      await openEdit(/Claude Pro 1 tháng/);

      expect(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      ).not.toBeChecked();
      expect(
        screen.queryByLabelText(/Nạp thêm tài khoản/),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Thêm hoặc bớt tồn kho")).toBeInTheDocument();
    });

    it("sits in one row with the switches for selling and for hot, in that order", async () => {
      await openEdit(/Claude Pro 1 tháng/);

      expect(
        screen.getAllByRole("switch").map((control) => control.id),
      ).toEqual(["stock-listed", "stock-hot", "stock-delivers"]);
      expect(
        screen.getByRole("switch", { name: "Đang bán" }).closest("div")
          ?.parentElement,
      ).toBe(
        screen
          .getByRole("switch", { name: "Giao tài khoản tự động" })
          .closest("div")?.parentElement,
      );
    });

    it("turns an ordinary package into one that hands out accounts, and says what happens to its count", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const accounts = vi.spyOn(fakeStockService, "accounts");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      );

      // The stepper gives way to the box for accounts, and the hand-set count is
      // said to go.
      expect(
        screen.queryByText("Thêm hoặc bớt tồn kho"),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Nạp tài khoản (tùy chọn)")).toHaveValue("");
      expect(
        screen.getByText(/Gói đang có 12 gõ tay, con số này sẽ mất/),
      ).toBeInTheDocument();
      // It holds no accounts yet, so there is no list to ask for.
      expect(accounts).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Giao tự động"),
      );
      expect(update).toHaveBeenCalledWith("claude-pro-1-thang", {
        ...claudePro,
        delivers_accounts: true,
      });
      // The server sets the count; none is moved by hand. It holds no account yet,
      // so it is sold out until some are loaded.
      expect(changeStock).not.toHaveBeenCalled();
      expect(row(/Claude Pro 1 tháng/)).toHaveTextContent("Hết hàng");
    });

    it("loads the accounts typed in straight after the package is made to hand them out", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const load = vi.spyOn(fakeStockService, "loadAccounts");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      );
      await user.click(screen.getByLabelText("Nạp tài khoản (tùy chọn)"));
      await user.paste("one@example.test|first\ntwo@example.test|second");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(load).toHaveBeenCalledWith(
          "claude-pro-1-thang",
          "one@example.test|first\ntwo@example.test|second",
        ),
      );
      expect(update.mock.invocationCallOrder[0]).toBeLessThan(
        load.mock.invocationCallOrder[0],
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Đã lưu Claude Pro 1 tháng",
          { description: "Trong kho còn 2 tài khoản." },
        ),
      );
    });

    it("lets a package with no account left go back to a count of its own", async () => {
      await fakeStockService.create({
        delivers_accounts: true,
        hot: false,
        image_url: "",
        listed: true,
        plan: "Empty Pack",
        price_vnd: 50_000,
        provider: "Claude",
        stock: 0,
        variant: null,
        warranty: "NW",
        warranty_note: null,
      });

      const slug = slugify("Claude", "Empty Pack", null);
      const update = vi.spyOn(fakeStockService, "update");
      const changeStock = vi.spyOn(fakeStockService, "changeStock");
      const user = await openEdit(/Empty Pack/);
      const delivers = screen.getByRole("switch", {
        name: "Giao tài khoản tự động",
      });

      expect(delivers).toBeChecked();
      expect(delivers).toBeEnabled();

      await user.click(delivers);

      expect(
        screen.getByText(/Gói sẽ về tồn kho gõ tay, bắt đầu từ 0/),
      ).toBeInTheDocument();
      await setAdjust(user, "Thêm hoặc bớt tồn kho", "7");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() => expect(row(/Empty Pack/)).toHaveTextContent("Còn 7"));
      expect(update).toHaveBeenCalledWith(
        slug,
        expect.objectContaining({ delivers_accounts: false }),
      );
      expect(changeStock).toHaveBeenCalledWith(slug, 7);
      expect(row(/Empty Pack/)).not.toHaveTextContent("Giao tự động");
    });

    it("keeps the form open with the server's words when it will not turn the package", async () => {
      vi.spyOn(fakeStockService, "update").mockRejectedValueOnce(
        new ServiceError(
          "Buyers have orders open for this package. Try again once they have paid or run out.",
          422,
          "validation_error",
        ),
      );
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      );
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không lưu được", {
          description:
            "Buyers have orders open for this package. Try again once they have paid or run out.",
        }),
      );
      // Still open, with the switch as it was set, to be fixed or given up.
      expect(
        screen.getByRole("switch", { name: "Giao tài khoản tự động" }),
      ).toBeChecked();
    });
  });

  describe("the warranty note", () => {
    const noteField = () =>
      screen.getByLabelText("Ghi chú bảo hành (tùy chọn)");

    it("is empty on a package that carries the standard note", async () => {
      await openEdit(/Claude Pro 1 tháng/);

      expect(noteField()).toHaveValue("");
    });

    it("shows the note a package carries", async () => {
      await openEdit(/Gemini Advanced/);

      expect(noteField()).toHaveValue("Không bảo hành đổi trả");
    });

    it("shows a note with its line breaks and blank lines as it was written, and sends it back untouched", async () => {
      const written =
        "Bảo hành 30 ngày\n\n  - Đổi tài khoản khác\n- Không hoàn tiền   sau 7 ngày";
      const gemini = fakeStockServiceProducts().find(
        (product) => product.provider === "Gemini",
      )!;
      await fakeStockService.update(gemini.slug, {
        delivers_accounts: gemini.delivers_accounts,
        hot: gemini.hot,
        image_url: gemini.image_url,
        listed: gemini.listed,
        plan: gemini.plan,
        price_vnd: gemini.price_vnd,
        provider: gemini.provider,
        variant: gemini.variant,
        warranty: gemini.warranty,
        warranty_note: written,
      });
      const update = vi.spyOn(fakeStockService, "update");
      const user = await openEdit(/Gemini Advanced/);

      expect(noteField()).toHaveValue(written);

      await user.clear(screen.getByLabelText("Giá (₫)"));
      await user.type(screen.getByLabelText("Giá (₫)"), "99000");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          gemini.slug,
          expect.objectContaining({ warranty_note: written }),
        ),
      );
    });

    it("goes back with the form when only something else is edited", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const user = await openEdit(/Gemini Advanced/);

      await user.clear(screen.getByLabelText("Giá (₫)"));
      await user.type(screen.getByLabelText("Giá (₫)"), "99000");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          "gemini-advanced-1-thang-gia-dinh",
          expect.objectContaining({
            price_vnd: 99_000,
            warranty_note: "Không bảo hành đổi trả",
          }),
        ),
      );
    });

    it("asks for the standard note back when it is cleared", async () => {
      const update = vi.spyOn(fakeStockService, "update");
      const user = await openEdit(/Gemini Advanced/);

      await user.clear(noteField());
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(update).toHaveBeenCalledWith(
          "gemini-advanced-1-thang-gia-dinh",
          expect.objectContaining({ warranty_note: null }),
        ),
      );
    });
  });

  describe("the Telegram message", () => {
    const field = () => screen.getByLabelText("Tin nhắn Telegram (tùy chọn)");

    it("starts empty on an item that is opened for editing", async () => {
      await openEdit(/Claude Pro 1 tháng/);

      expect(field()).toHaveValue("");
      expect(screen.getByText(/Để trống thì không gửi gì/)).toBeInTheDocument();
    });

    it("is sent after an edit as well, with the text as written", async () => {
      const announce = vi.spyOn(fakeStockService, "announce");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.clear(screen.getByLabelText("Giá (₫)"));
      await user.type(screen.getByLabelText("Giá (₫)"), "399000");
      await user.type(field(), "Giảm giá Claude Pro còn 399.000 ₫");
      await user.click(screen.getByRole("button", { name: "Lưu" }));

      await waitFor(() =>
        expect(announce).toHaveBeenCalledWith(
          "Giảm giá Claude Pro còn 399.000 ₫",
          "claude-pro-1-thang",
        ),
      );
      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Đã lưu Claude Pro 1 tháng",
          { description: expect.stringContaining("Bot đã đăng lên kênh") },
        ),
      );
    });

    it("counts the characters once something is written", async () => {
      const user = await openEdit(/Claude Pro 1 tháng/);

      expect(screen.queryByText(/\/4096$/)).not.toBeInTheDocument();

      await user.type(field(), "Xin chào");

      expect(screen.getByText("8/4096")).toBeInTheDocument();
    });

    it("allows 4,096 characters and refuses one more", async () => {
      const user = await openEdit(/Claude Pro 1 tháng/);

      fireEvent.change(field(), { target: { value: "a".repeat(4096) } });

      expect(screen.getByText("4096/4096")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Lưu" })).toBeEnabled();

      fireEvent.change(field(), { target: { value: "a".repeat(4097) } });

      expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
      expect(screen.getByText(/dài tối đa 4096 ký tự/)).toBeInTheDocument();

      await user.clear(field());

      expect(screen.getByRole("button", { name: "Lưu" })).toBeEnabled();
    });
  });

  describe("deleting", () => {
    it("removes a package on the server after confirming", async () => {
      const remove = vi.spyOn(fakeStockService, "remove");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(screen.getByRole("button", { name: "Xóa hàng" }));

      expect(dialog()).toHaveTextContent("Xóa Claude Pro 1 tháng?");

      await user.click(within(dialog()).getByRole("button", { name: "Xóa" }));

      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /Claude Pro 1 tháng/ }),
        ).not.toBeInTheDocument(),
      );
      expect(remove).toHaveBeenCalledWith("claude-pro-1-thang");
      expect(toast).toHaveBeenCalledWith("Đã xóa Claude Pro 1 tháng");
    });

    it("keeps the package, and asks nothing, when the owner backs out", async () => {
      const remove = vi.spyOn(fakeStockService, "remove");
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(screen.getByRole("button", { name: "Xóa hàng" }));
      await user.click(screen.getByRole("button", { name: "Giữ lại" }));

      expect(editButton(/Claude Pro 1 tháng/)).toBeInTheDocument();
      expect(remove).not.toHaveBeenCalled();
    });

    it("says why when the server will not remove it, and keeps the package", async () => {
      vi.spyOn(fakeStockService, "remove").mockRejectedValueOnce(
        refused("Buyers have orders open for this product. Hide it instead."),
      );
      const user = await openEdit(/Claude Pro 1 tháng/);

      await user.click(screen.getByRole("button", { name: "Xóa hàng" }));
      await user.click(within(dialog()).getByRole("button", { name: "Xóa" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không xóa được", {
          description:
            "Buyers have orders open for this product. Hide it instead.",
        }),
      );
      expect(editButton(/Claude Pro 1 tháng/)).toBeInTheDocument();
    });

    it("offers no delete when adding", async () => {
      const user = await setup();

      await user.click(screen.getByRole("button", { name: "Thêm hàng" }));

      expect(
        screen.queryByRole("button", { name: "Xóa hàng" }),
      ).not.toBeInTheDocument();
    });
  });
});

describe("PosRoute, the image", () => {
  // A package has no picture to choose: the provider's own icon is what shows, on
  // its card and everywhere the dashboard names it.
  it("has no picture to choose, upload or pick from, when adding", async () => {
    const user = await setup();

    await openTelegramForm(user);

    expect(
      within(dialog()).queryByRole("img", { name: "Ảnh hàng" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog()).queryByRole("button", { name: "Thêm ảnh mới" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog()).queryByLabelText("Chọn tệp ảnh"),
    ).not.toBeInTheDocument();
    expect(
      within(dialog()).queryByRole("button", { name: /^Ảnh \d+$/ }),
    ).not.toBeInTheDocument();
    expect(within(dialog()).queryByText("Ảnh")).not.toBeInTheDocument();
  });

  it("has none when editing either, even for a package that has a picture", async () => {
    const user = await setup();

    await user.click(editButton(/Claude Pro 1 tháng/));

    expect(dialog()).toHaveTextContent("Sửa Claude Pro 1 tháng");
    expect(
      within(dialog()).queryByRole("img", { name: "Ảnh hàng" }),
    ).not.toBeInTheDocument();
    expect(
      within(dialog()).queryByRole("button", {
        name: "Dùng lại ảnh mặc định",
      }),
    ).not.toBeInTheDocument();
  });

  it("sends no picture for a new package", async () => {
    const create = vi.spyOn(fakeStockService, "create");
    const user = await setup();

    await openTelegramForm(user);
    await chooseProvider(user, "DeepSeek");
    await user.type(screen.getByLabelText("Tên gói"), "Pro 1 tháng");
    await user.type(screen.getByLabelText("Giá (₫)"), "199000");
    await user.click(screen.getByRole("button", { name: "Thêm" }));

    await screen.findByRole("button", { name: /DeepSeek Pro 1 tháng/ });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ image_url: "", provider: "DeepSeek" }),
    );
  });

  it("leaves the picture a package already has as it is when the package is edited", async () => {
    const update = vi.spyOn(fakeStockService, "update");
    const user = await setup();

    await user.click(editButton(/Claude Pro 1 tháng/));
    await user.clear(screen.getByLabelText("Tên gói"));
    await user.type(screen.getByLabelText("Tên gói"), "Pro 12 tháng");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        "claude-pro-1-thang",
        expect.objectContaining({
          image_url: "https://picsum.photos/400/300?random=4",
          plan: "Pro 12 tháng",
        }),
      ),
    );
  });
});

describe("PosRoute, the accounts in stock", () => {
  /** Opens the edit form of the package that hands out accounts, as `role`. */
  async function openAccounts(role: Role = "owner") {
    const user = userEvent.setup();

    renderPage(<PosRoute />, role);
    await user.click(
      await screen.findByRole("button", { name: /Claude Max 5x/ }),
    );
    await screen.findByText("Tài khoản trong kho");

    return user;
  }

  const passwordField = () => screen.getByLabelText(/Mật khẩu của bạn/);

  /** Types the owner's password and opens the accounts into the box. */
  async function unlock(user: ReturnType<typeof userEvent.setup>) {
    await user.type(passwordField(), FAKE_OWNER_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Hiện" }));

    return screen.findByLabelText("Tài khoản trong kho");
  }

  it("asks the owner for their password and shows nothing of the accounts until then", async () => {
    await openAccounts();

    expect(screen.getByText("1 chưa bán · 1 đã bán")).toBeInTheDocument();
    expect(passwordField()).toBeInTheDocument();
    // No list of hidden emails, no buttons for one account at a time.
    expect(screen.queryByText("o***@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /tài khoản o\*\*\*@example\.com/ }),
    ).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("right-secret");
    expect(document.body.textContent).not.toContain("already-sent");
  });

  it("shows the accounts not sold as the lines email|password once the password is right, and says when it is wrong", async () => {
    const reveal = vi.spyOn(fakeStockService, "revealAccounts");
    const user = await openAccounts();

    await user.type(passwordField(), "not-it");
    await user.click(screen.getByRole("button", { name: "Hiện" }));

    expect(await screen.findByText("Mật khẩu không đúng.")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("right-secret");

    await user.clear(passwordField());

    const block = await unlock(user);

    // The one sold is not in it.
    expect(block).toHaveValue("owner@example.com|right-secret");
    expect(screen.getByText("1 dòng · 1 đã bán")).toBeInTheDocument();
    expect(reveal).toHaveBeenLastCalledWith(
      ["account-unsold"],
      FAKE_OWNER_PASSWORD,
    );
    // The box for adding gives way to the block, which can add too.
    expect(
      screen.queryByLabelText("Nạp thêm tài khoản (tùy chọn)"),
    ).not.toBeInTheDocument();
    // The password is not left in the field.
    expect(document.body.textContent).not.toContain(FAKE_OWNER_PASSWORD);
  });

  it("saves the package alone when the block is left as it was", async () => {
    const edit = vi.spyOn(fakeStockService, "editAccounts");
    const update = vi.spyOn(fakeStockService, "update");
    const user = await openAccounts();

    await unlock(user);
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(edit).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalledWith("Đã lưu Claude Max 5x 1 tháng");
  });

  it("says what a changed block would do before it does anything, then saves the package and the accounts", async () => {
    const edit = vi.spyOn(fakeStockService, "editAccounts");
    const update = vi.spyOn(fakeStockService, "update");
    const user = await openAccounts();
    const block = await unlock(user);

    await user.clear(block);
    await user.paste(
      "owner@example.com|new-secret\nsecond@example.com|second-pass",
    );
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    // Looked at, not done.
    expect(await screen.findByText("Xác nhận thay đổi")).toBeInTheDocument();
    expect(screen.getByText(/Đổi email hoặc mật khẩu:/)).toHaveTextContent(
      "Đổi email hoặc mật khẩu: 1",
    );
    expect(screen.getByText(/Thêm mới:/)).toHaveTextContent("Thêm mới: 1");
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenLastCalledWith(
      "claude-max-5x-1-thang",
      expect.objectContaining({ dryRun: true, ids: ["account-unsold"] }),
    );
    expect(update).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    await waitFor(() =>
      expect(edit).toHaveBeenLastCalledWith("claude-max-5x-1-thang", {
        accounts:
          "owner@example.com|new-secret\nsecond@example.com|second-pass",
        dryRun: false,
        ids: ["account-unsold"],
      }),
    );
    // The package first, then its accounts.
    expect(update.mock.invocationCallOrder[0]).toBeLessThan(
      edit.mock.invocationCallOrder[1],
    );
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Đã lưu Claude Max 5x 1 tháng",
        {
          description: "Đổi 1, thêm 1. Trong kho còn 5 tài khoản.",
        },
      ),
    );
    // Nothing of the accounts stays on the page.
    expect(document.body.textContent).not.toContain("new-secret");
  });

  it("goes back to the block as it was left when the summary is not confirmed", async () => {
    const update = vi.spyOn(fakeStockService, "update");
    const user = await openAccounts();
    const block = await unlock(user);

    await user.clear(block);
    await user.paste("owner@example.com|changed");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    await screen.findByText("Xác nhận thay đổi");
    await user.click(screen.getByRole("button", { name: "Quay lại sửa" }));

    expect(screen.queryByText("Xác nhận thay đổi")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Tài khoản trong kho")).toHaveValue(
      "owner@example.com|changed",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("takes an account out of stock by deleting its line, with a warning, once confirmed", async () => {
    const user = await openAccounts();
    const block = await unlock(user);

    await user.clear(block);
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(await screen.findByText(/Xóa khỏi kho:/)).toHaveTextContent(
      "Xóa khỏi kho: 1",
    );
    expect(
      screen.getByText(/Tài khoản bị xóa không còn được bán/),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Đã lưu Claude Max 5x 1 tháng",
        {
          description: "Xóa 1. Trong kho còn 3 tài khoản.",
        },
      ),
    );
  });

  it("names the line that is wrong without quoting it, and does not let it be saved", async () => {
    const user = await openAccounts();
    const block = await unlock(user);

    await user.type(block, "\nno-bar-here");

    expect(
      screen.getByText("Dòng 2 không đúng dạng email|mật khẩu."),
    ).not.toHaveTextContent("no-bar-here");
    expect(screen.getByRole("button", { name: "Lưu" })).toBeDisabled();
  });

  it("keeps the form open and the block as it was when the accounts changed meanwhile", async () => {
    const user = await openAccounts();
    const block = await unlock(user);

    await user.clear(block);
    await user.paste("owner@example.com|changed");
    await user.click(screen.getByRole("button", { name: "Lưu" }));
    await screen.findByText("Xác nhận thay đổi");
    vi.spyOn(fakeStockService, "editAccounts").mockRejectedValueOnce(
      new ServiceError(
        "Some of these accounts were sold or removed while you were editing. Open them again.",
        422,
        "validation_error",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Lưu thay đổi" }));

    // The package is saved either way; the accounts are said not to be.
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        "Đã lưu Claude Max 5x 1 tháng",
        {
          description: expect.stringContaining(
            "Chưa lưu được thay đổi của tài khoản",
          ),
        },
      ),
    );
  });

  it("hides the accounts again and forgets them when the form is left alone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    try {
      const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

      renderPage(<PosRoute />);
      await user.click(
        await screen.findByRole("button", { name: /Claude Max 5x/ }),
      );
      await screen.findByText("Tài khoản trong kho");
      expect(await unlock(user)).toHaveValue("owner@example.com|right-secret");

      await act(() => vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000));

      expect(document.body.textContent).not.toContain("right-secret");
      // Back at the question, with the form still open.
      expect(passwordField()).toHaveValue("");
      expect(toast).toHaveBeenCalledWith(
        "Đã ẩn tài khoản vì lâu không thao tác.",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers only the box for adding to a package that holds no account not sold", async () => {
    await fakeStockService.create({
      delivers_accounts: true,
      hot: false,
      image_url: "",
      listed: true,
      plan: "Empty Pack",
      price_vnd: 50_000,
      provider: "Claude",
      stock: 0,
      variant: null,
      warranty: "NW",
      warranty_note: null,
    });
    const user = userEvent.setup();

    renderPage(<PosRoute />);
    await user.click(await screen.findByRole("button", { name: /Empty Pack/ }));

    expect(
      await screen.findByText("Chưa có tài khoản nào chưa bán."),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText(/Mật khẩu của bạn/)).not.toBeInTheDocument();
    expect(
      screen.getByLabelText("Nạp thêm tài khoản (tùy chọn)"),
    ).toBeInTheDocument();
  });

  it.each(["manager", "stock-keeper"] as const)(
    "lists the accounts to a %s with the email hidden, whether each is sold and who loaded it, and never a password or a way to open one",
    async (role: Role) => {
      await openAccounts(role);

      expect(screen.getByText("o***@example.com")).toBeInTheDocument();
      expect(
        screen.getByText("Chưa bán · nạp bởi minhanh"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Đã bán · đơn ABC123DEF456 · nạp bởi ducthinh"),
      ).toBeInTheDocument();
      expect(screen.getByText("1 chưa bán · 1 đã bán")).toBeInTheDocument();
      expect(
        screen.queryByLabelText(/Mật khẩu của bạn/),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Xem( \/ sửa)? tài khoản/ }),
      ).not.toBeInTheDocument();
      expect(document.body.textContent).not.toContain("right-secret");
      expect(document.body.textContent).not.toContain("already-sent");
    },
  );

  it("is not shown for a package that does not hand them out", async () => {
    const user = userEvent.setup();

    renderPage(<PosRoute />);
    await user.click(
      await screen.findByRole("button", { name: /Claude Pro 1 tháng/ }),
    );

    expect(screen.queryByText("Tài khoản trong kho")).not.toBeInTheDocument();
  });

  it("lets a manager take an unsold one out after a second press, and offers no way to take a sold one out", async () => {
    const user = await openAccounts("manager");

    expect(
      screen.queryByRole("button", { name: "Xóa tài khoản b***@example.com" }),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Xóa tài khoản o***@example.com" }),
    );
    // One press only asks.
    expect(screen.getByText("o***@example.com")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Xóa thật" }));

    await waitFor(() =>
      expect(screen.queryByText("o***@example.com")).not.toBeInTheDocument(),
    );
    expect(toast.success).toHaveBeenCalledWith("Đã xóa tài khoản", {
      description: "Trong kho còn 3 tài khoản.",
    });
  });
});

describe("PosRoute, who may open it", () => {
  it.each(["owner", "manager", "stock-keeper"] as const)(
    "is open to a %s",
    async (role: Role) => {
      renderPage(<PosRoute />, role);

      expect(
        await screen.findByRole("button", { name: /Claude Pro 1 tháng/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Thêm hàng" }),
      ).toBeInTheDocument();
    },
  );

  it("is closed to a cashier, and the stock is never even asked for", () => {
    const list = vi.spyOn(fakeStockService, "list");

    renderPage(<PosRoute />, "cashier");

    expect(
      screen.getByText("Trang này không dành cho vai trò của bạn"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Thêm hàng" }),
    ).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });
});
