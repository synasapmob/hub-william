import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";
import {
  fakeAgentConnectionService,
  resetFakeAgentConnections,
} from "@/test/fake-agent-connection-service";
import {
  fakeServiceStockService,
  resetFakeServiceStock,
} from "@/test/fake-service-stock-service";
import { resetFakeStock } from "@/test/fake-stock-service";
import renderPage from "@/test/render-page";

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

vi.mock("@/services/agent-connection/agent-connection-service", async () => {
  const { fakeAgentConnectionService } =
    await import("@/test/fake-agent-connection-service");

  return { agentConnectionService: fakeAgentConnectionService };
});

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetFakeStock();
  resetFakeServiceStock();
  resetFakeAgentConnections();
  popup = fakePopup();
  // jsdom opens no windows: a test gives the page one, or none.
  open = vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
});

type User = ReturnType<typeof userEvent.setup>;

/** The window the provider's sign-in opens in, as far as the page can touch it. */
function fakePopup() {
  return {
    close: vi.fn(),
    location: { replace: vi.fn() },
    opener: window as Window | null,
  };
}

let popup = fakePopup();
let open: ReturnType<typeof vi.spyOn>;

const MAX = "Claude Max · 7 ngày";
const PRO = "Claude Pro · 3 ngày";
const PLUS = "ChatGPT Plus · 30 ngày";
const CALLBACK = "http://localhost:1455/auth/callback?code=abc&state=xyz";

/** The card of an agent of Hub William's, found by its name. */
const card = (name: string) =>
  screen
    .getAllByRole("heading", { level: 2, name })
    .map((heading) => heading.closest("section") as HTMLElement)
    .find((candidate) =>
      within(candidate).queryByText("Hub William"),
    ) as HTMLElement;
/** The names of the cards of Hub William's, in the order they are shown. */
const cardNames = () =>
  screen
    .queryAllByRole("heading", { level: 2 })
    .filter((heading) =>
      within(heading.closest("section") as HTMLElement).queryByText(
        "Hub William",
      ),
    )
    .map((heading) => heading.textContent);
const edit = (name: string) =>
  screen.getByRole("button", { name: `Sửa gói ${name}` });
const dialog = () => screen.getByRole("dialog");
/** The names of the options of the list that is open, as a person reads them. */
const optionNames = () =>
  screen
    .getAllByRole("option")
    .map((option) => option.textContent?.replace(/^[A-Z](?=[A-Z])/, ""));

/** Opens the page once its tickets have arrived. */
async function setup() {
  const user = userEvent.setup();

  renderPage(<PosRoute />);
  await screen.findByRole("button", { name: `Sửa gói ${MAX}` });

  return user;
}

/** Opens the form that puts an account on sale, from the header's "Thêm hàng". */
async function openAddFromHeader(user: User) {
  await user.click(screen.getByRole("button", { name: "Thêm hàng" }));
  await user.click(screen.getByRole("button", { name: /^Hub William/ }));
}

async function chooseProvider(user: User, name: string) {
  await user.click(screen.getByRole("combobox", { name: "Nhà cung cấp" }));
  await user.click(screen.getByRole("option", { name }));
}

const verifyButton = () =>
  screen.getByRole("button", { name: /^Verify( lại)?$/ });
const addButton = () => screen.getByRole("button", { name: "Thêm" });

/** Connects DeepSeek with a key and verifies it, which is the shortest way through. */
async function verifyDeepseek(user: User) {
  await openAddFromHeader(user);
  await chooseProvider(user, "DeepSeek");
  await user.type(
    screen.getByLabelText("API key DeepSeek"),
    "fake-not-a-secret",
  );
  await user.click(verifyButton());
  await screen.findByText(/Đã verify/);
}

describe("PosRoute, Hub William's tickets", () => {
  it("asks the server for the tickets once, and shows a card for each agent that has some, in Hub William's order", async () => {
    const listings = vi.spyOn(fakeServiceStockService, "listings");

    await setup();

    expect(listings).toHaveBeenCalledTimes(1);
    expect(cardNames()).toEqual(["ChatGPT", "Claude"]);
    expect(card("Claude")).toHaveTextContent("2 gói");
    expect(card("ChatGPT")).toHaveTextContent("1 gói");
    expect(card("Claude")).toHaveTextContent(MAX);
    expect(card("Claude")).toHaveTextContent(PRO);
    expect(card("ChatGPT")).toHaveTextContent(PLUS);
  });

  it("has no card for an agent with nothing on sale", async () => {
    await setup();

    // (Telegram has cards for some of these; Hub William's has none.)
    for (const name of ["Gemini", "DeepSeek", "Grok", "Groq"])
      expect(cardNames()).not.toContain(name);
  });

  it("says how long a ticket lasts, what it has left and what it costs", async () => {
    await setup();

    const row = edit(MAX).closest("li") as HTMLElement;

    expect(row).toHaveTextContent(MAX);
    expect(row).toHaveTextContent(
      "7 ngày · 5-hour limit 80% left · Weekly limit 50% left",
    );
    expect(row).toHaveTextContent("$4.00");
    expect((edit(PLUS).closest("li") as HTMLElement).textContent).toContain(
      "$9.99",
    );
  });

  it("says nothing of the quota for a ticket whose provider does not say", async () => {
    await setup();

    const row = edit(PRO).closest("li") as HTMLElement;

    expect(row).toHaveTextContent("3 ngày");
    expect(row).not.toHaveTextContent("limit");
  });

  it("marks a ticket that is switched off", async () => {
    await setup();

    expect(edit(PRO).closest("li")).toHaveTextContent("Đang ẩn");
    expect(edit(MAX).closest("li")).not.toHaveTextContent("Đang ẩn");
  });

  it.each([
    ["needs_reconnect", "Cần kết nối lại"],
    ["disconnected", "Account đã gỡ"],
  ] as const)("says why a ticket is %s", async (status, label) => {
    const [first, ...rest] = await fakeServiceStockService.listings();

    vi.spyOn(fakeServiceStockService, "listings").mockResolvedValue([
      { ...first, status },
      ...rest,
    ]);
    await setup();

    expect(edit(MAX).closest("li")).toHaveTextContent(label);
  });

  it("says why the tickets could not be loaded, and tries again on request", async () => {
    const listings = vi
      .spyOn(fakeServiceStockService, "listings")
      .mockRejectedValueOnce(new ServiceError("The API is down.", 500, "x"));
    const user = userEvent.setup();

    renderPage(<PosRoute />);

    expect(await screen.findByText("The API is down.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Thử lại" }));

    expect(
      await screen.findByRole("button", { name: `Sửa gói ${MAX}` }),
    ).toBeInTheDocument();
    expect(listings).toHaveBeenCalledTimes(2);
  });

  describe("search", () => {
    const search = () => screen.getByRole("searchbox", { name: "Tìm hàng" });

    it.each([
      ["a name", "Pro", [PRO]],
      ["an agent", "chatgpt", [PLUS]],
      ["the name of the account", "Shop ChatGPT", [PLUS]],
      ["a plan", "Max", [MAX]],
    ])("finds a ticket by %s", async (_, typed, found) => {
      const user = await setup();

      await user.type(search(), typed);

      for (const name of [MAX, PRO, PLUS])
        if (found.includes(name)) expect(edit(name)).toBeInTheDocument();
        else
          expect(
            screen.queryByRole("button", { name: `Sửa gói ${name}` }),
          ).not.toBeInTheDocument();
    });

    it("leaves only the agents it found something in", async () => {
      const user = await setup();

      await user.type(search(), "ChatGPT Plus");

      expect(cardNames()).toEqual(["ChatGPT"]);
    });
  });
});

describe("PosRoute, editing a ticket", () => {
  it("opens filled in, with the account behind it and what it had left", async () => {
    const user = await setup();

    await user.click(edit(MAX));

    expect(dialog()).toHaveTextContent(`Sửa ${MAX}`);
    expect(screen.getByLabelText("Tên gói")).toHaveValue(MAX);
    expect(screen.getByLabelText("Hạn dùng (ngày)")).toHaveValue("7");
    expect(screen.getByLabelText("Giá ($)")).toHaveValue("4");
    expect(screen.getByRole("switch", { name: "Đang bán" })).toBeChecked();
    expect(dialog()).toHaveTextContent("Shop Claude · Max");
    expect(dialog()).toHaveTextContent("@minhanh");
    expect(dialog()).toHaveTextContent("5-hour limit: 80% left (resets in 2h)");
    expect(dialog()).toHaveTextContent("Weekly limit: 50% left");
    expect(dialog()).toHaveTextContent("Đọc lúc");
  });

  it("says when the provider does not say what an account has left", async () => {
    const user = await setup();

    await user.click(edit(PRO));

    expect(dialog()).toHaveTextContent("Nhà cung cấp không cho đọc quota");
    expect(screen.getByRole("switch", { name: "Đang bán" })).not.toBeChecked();
  });

  it("saves the name, the days and the price, and shows them", async () => {
    const update = vi.spyOn(fakeServiceStockService, "updateListing");
    const user = await setup();

    await user.click(edit(MAX));
    await user.clear(screen.getByLabelText("Tên gói"));
    await user.type(screen.getByLabelText("Tên gói"), "Claude Max rẻ");
    await user.clear(screen.getByLabelText("Hạn dùng (ngày)"));
    await user.type(screen.getByLabelText("Hạn dùng (ngày)"), "14");
    await user.clear(screen.getByLabelText("Giá ($)"));
    await user.type(screen.getByLabelText("Giá ($)"), "9.99");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    expect(
      await screen.findByRole("button", { name: "Sửa gói Claude Max rẻ" }),
    ).toBeInTheDocument();
    expect(update).toHaveBeenCalledWith("listing-claude-max", {
      days: 14,
      listed: true,
      name: "Claude Max rẻ",
      price_micro: 9_990_000,
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(toast.success).toHaveBeenCalledWith("Đã lưu Claude Max rẻ");
    expect(card("Claude")).toHaveTextContent("14 ngày");
    expect(card("Claude")).toHaveTextContent("$9.99");
  });

  it("switches a ticket off, and then it says it is hidden", async () => {
    const user = await setup();

    await user.click(edit(MAX));
    await user.click(screen.getByRole("switch", { name: "Đang bán" }));
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() =>
      expect(edit(MAX).closest("li")).toHaveTextContent("Đang ẩn"),
    );
  });

  it("says next to the field what is wrong, and cannot be saved", async () => {
    const user = await setup();

    await user.click(edit(MAX));

    const save = () => screen.getByRole("button", { name: "Lưu" });

    await user.clear(screen.getByLabelText("Hạn dùng (ngày)"));
    await user.type(screen.getByLabelText("Hạn dùng (ngày)"), "0");

    expect(screen.getByText("Từ 1 đến 365 ngày.")).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(screen.getByLabelText("Hạn dùng (ngày)"));
    await user.type(screen.getByLabelText("Hạn dùng (ngày)"), "7");
    await user.clear(screen.getByLabelText("Giá ($)"));
    await user.type(screen.getByLabelText("Giá ($)"), "4.005");

    expect(
      screen.getByText("Từ $0.01 đến $10,000, tối đa 2 số lẻ."),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await user.clear(screen.getByLabelText("Giá ($)"));
    await user.type(screen.getByLabelText("Giá ($)"), "4");
    await user.clear(screen.getByLabelText("Tên gói"));

    expect(screen.getByText("Tên từ 1 đến 80 ký tự.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it("keeps the dialog, with what was typed, when the server refuses", async () => {
    vi.spyOn(fakeServiceStockService, "updateListing").mockRejectedValue(
      new ServiceError("The requested resource was not found.", 404, "x"),
    );
    const user = await setup();

    await user.click(edit(MAX));
    await user.clear(screen.getByLabelText("Tên gói"));
    await user.type(screen.getByLabelText("Tên gói"), "Tên mới");
    await user.click(screen.getByRole("button", { name: "Lưu" }));

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Không lưu được gói", {
        description: "The requested resource was not found.",
      }),
    );
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByLabelText("Tên gói")).toHaveValue("Tên mới");
  });

  it("asks the server nothing when closed without saving", async () => {
    const update = vi.spyOn(fakeServiceStockService, "updateListing");
    const user = await setup();

    await user.click(edit(MAX));
    await user.clear(screen.getByLabelText("Tên gói"));
    await user.click(screen.getByRole("button", { name: "Hủy" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
    expect(card("Claude")).toHaveTextContent(MAX);
  });

  describe("taking it off sale", () => {
    it("asks first, and then takes it off, leaving the account as it was", async () => {
      const remove = vi.spyOn(fakeServiceStockService, "removeListing");
      const user = await setup();

      await user.click(edit(MAX));
      await user.click(screen.getByRole("button", { name: "Gỡ khỏi bán" }));

      expect(dialog()).toHaveTextContent(`Gỡ ${MAX} khỏi bán?`);
      expect(dialog()).toHaveTextContent("Account vẫn còn nguyên");
      expect(remove).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Gỡ" }));

      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: `Sửa gói ${MAX}` }),
        ).not.toBeInTheDocument(),
      );
      expect(remove).toHaveBeenCalledWith("listing-claude-max");
      expect(toast).toHaveBeenCalledWith(`Đã gỡ ${MAX} khỏi bán`);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(card("Claude")).toHaveTextContent("1 gói");
    });

    it("leaves an agent no card once its last ticket is gone", async () => {
      const user = await setup();

      await user.click(edit(PLUS));
      await user.click(screen.getByRole("button", { name: "Gỡ khỏi bán" }));
      await user.click(screen.getByRole("button", { name: "Gỡ" }));

      await waitFor(() => expect(cardNames()).toEqual(["Claude"]));
    });

    it("keeps it when the seller backs out", async () => {
      const remove = vi.spyOn(fakeServiceStockService, "removeListing");
      const user = await setup();

      await user.click(edit(MAX));
      await user.click(screen.getByRole("button", { name: "Gỡ khỏi bán" }));
      await user.click(screen.getByRole("button", { name: "Giữ lại" }));

      expect(dialog()).toHaveTextContent(`Sửa ${MAX}`);
      expect(remove).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(card("Claude")).toHaveTextContent(MAX);
    });

    it("says why when the server will not, and keeps the ticket", async () => {
      vi.spyOn(fakeServiceStockService, "removeListing").mockRejectedValue(
        new ServiceError("The requested resource was not found.", 404, "x"),
      );
      const user = await setup();

      await user.click(edit(MAX));
      await user.click(screen.getByRole("button", { name: "Gỡ khỏi bán" }));
      await user.click(screen.getByRole("button", { name: "Gỡ" }));

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Không gỡ được gói khỏi bán", {
          description: "The requested resource was not found.",
        }),
      );
      expect(dialog()).toBeInTheDocument();
      expect(toast).not.toHaveBeenCalled();

      await user.click(screen.getByRole("button", { name: "Giữ lại" }));
      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(card("Claude")).toHaveTextContent(MAX);
    });
  });
});

describe("PosRoute, putting an account on sale", () => {
  it("asks first whether it is a Telegram package or Hub William's, and opens Hub William's form", async () => {
    const user = await setup();

    await user.click(screen.getByRole("button", { name: "Thêm hàng" }));

    expect(
      within(dialog()).getByRole("button", { name: /^Telegram/ }),
    ).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("không dùng chung số lượng");

    await user.click(screen.getByRole("button", { name: /^Hub William/ }));

    expect(
      within(dialog()).getByRole("heading", { name: "Thêm hàng Hub William" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Tên gói")).not.toBeInTheDocument();
  });

  it("starts with an agent to choose from a fixed list, 7 days, and no price", async () => {
    const user = await setup();

    await openAddFromHeader(user);

    expect(
      screen.getByRole("combobox", { name: "Nhà cung cấp" }),
    ).toHaveTextContent("Chọn nhà cung cấp");
    expect(screen.getByLabelText("Hạn dùng (ngày)")).toHaveValue("7");
    expect(screen.getByLabelText("Giá ($)")).toHaveValue("");
    // Nothing to connect until there is an agent to connect.
    expect(
      screen.queryByRole("button", { name: /^Verify/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Lấy link đăng nhập" }),
    ).not.toBeInTheDocument();
    expect(addButton()).toBeDisabled();

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

  it("starts on the agent when added from its card", async () => {
    const user = await setup();

    await user.click(
      within(card("Claude")).getByRole("button", {
        name: "Thêm gói cho Claude",
      }),
    );

    expect(
      screen.getByRole("combobox", {
        name: "Nhnhà cung cấp".replace("Nhnhà", "Nhà"),
      }),
    ).toHaveTextContent("Claude");
    // Its own way in is there at once, with no heading to say so.
    expect(
      screen.getByRole("button", { name: "Lấy link đăng nhập" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Kết nối account/)).not.toBeInTheDocument();
  });

  describe("connecting and verifying the account", () => {
    it("connects DeepSeek with a key, hides the key, and shows what was verified", async () => {
      const connect = vi.spyOn(fakeAgentConnectionService, "connectKey");
      const verify = vi.spyOn(fakeServiceStockService, "verify");
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "DeepSeek");

      expect(screen.getByLabelText("API key DeepSeek")).toHaveAttribute(
        "type",
        "password",
      );
      expect(verifyButton()).toBeDisabled();

      await user.type(
        screen.getByLabelText("API key DeepSeek"),
        "fake-not-a-secret",
      );
      await user.click(verifyButton());

      expect(await screen.findByText(/Đã verify/)).toBeInTheDocument();
      expect(connect).toHaveBeenCalledWith("deepseek", "fake-not-a-secret");
      expect(verify).toHaveBeenCalledWith("connection-deepseek-1");
      expect(dialog()).toHaveTextContent("Đã verify · Account mới · Plus");
      expect(dialog()).toHaveTextContent(
        "Nhà cung cấp không cho đọc quota, hoặc chưa đọc được lúc này.",
      );
      expect(
        screen.queryByLabelText("API key DeepSeek"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Verify lại" }),
      ).toBeInTheDocument();
    });

    it("signs in to Claude at the provider and takes the address that comes back", async () => {
      const start = vi.spyOn(fakeAgentConnectionService, "start");
      const complete = vi.spyOn(fakeAgentConnectionService, "complete");
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "Claude");
      await user.click(
        screen.getByRole("button", { name: "Lấy link đăng nhập" }),
      );

      expect(start).toHaveBeenCalledWith("claude");
      // The sign-in is in a window of its own; the link only opens it again.
      expect(
        await screen.findByRole("link", {
          name: "Mở lại trang đăng nhập Claude",
        }),
      ).toHaveAttribute("href", "https://auth.example/claude/login");
      expect(verifyButton()).toBeDisabled();
      // One line: an address does not need a box that grows.
      expect(screen.getByLabelText("Callback URL").tagName).toBe("INPUT");

      await user.click(screen.getByLabelText("Callback URL"));
      await user.paste(CALLBACK);
      await user.click(verifyButton());

      expect(await screen.findByText(/Đã verify/)).toBeInTheDocument();
      expect(complete).toHaveBeenCalledWith("connection-claude-1", CALLBACK);
      // Claude says what the account has left.
      expect(dialog()).toHaveTextContent(
        "5-hour limit: 90% left (resets in 4h)",
      );
    });

    describe("the window the provider's sign-in opens in", () => {
      it("opens in the click itself, before the sign-in has started, and is sent to the provider afterwards", async () => {
        let finish: () => void = () => {};
        // What the fake does, taken before the test replaces it.
        const real = fakeAgentConnectionService.start.bind(
          fakeAgentConnectionService,
        );
        const start = vi.spyOn(fakeAgentConnectionService, "start");

        start.mockImplementation(
          (provider) =>
            new Promise((resolve) => {
              finish = () => resolve(real(provider));
            }),
        );
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "Claude");
        await user.click(
          screen.getByRole("button", { name: "Lấy link đăng nhập" }),
        );

        // Opened at once, blank, in a window of its own: a window opened after the
        // server had answered would be taken for a popup nobody asked for.
        expect(open).toHaveBeenCalledWith(
          "about:blank",
          "hub-william-agent-connect",
          "popup,width=720,height=820",
        );
        expect(popup.location.replace).not.toHaveBeenCalled();
        expect(popup.opener).toBeNull();

        finish();

        await waitFor(() =>
          expect(popup.location.replace).toHaveBeenCalledWith(
            "https://auth.example/claude/login",
          ),
        );
        expect(popup.close).not.toHaveBeenCalled();
      });

      it("opens for a sign-in with a code as well", async () => {
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "Grok");
        await user.click(
          screen.getByRole("button", { name: "Lấy mã đăng nhập" }),
        );

        await waitFor(() =>
          expect(popup.location.replace).toHaveBeenCalledWith(
            "https://auth.example/grok/login",
          ),
        );
        expect(screen.getByText("ABCD-1234")).toBeInTheDocument();
      });

      it("is not opened for a key, which has nothing to sign in to", async () => {
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "DeepSeek");
        await user.type(
          screen.getByLabelText("API key DeepSeek"),
          "fake-not-a-secret",
        );
        await user.click(verifyButton());
        await screen.findByText(/Đã verify/);

        expect(open).not.toHaveBeenCalled();
      });

      it("says so when the browser will not open it, and starts nothing", async () => {
        open.mockReturnValue(null);
        const start = vi.spyOn(fakeAgentConnectionService, "start");
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "Claude");
        await user.click(
          screen.getByRole("button", { name: "Lấy link đăng nhập" }),
        );

        expect(toast.error).toHaveBeenCalledWith(
          "Trình duyệt chặn cửa sổ đăng nhập",
          { description: "Cho phép popup cho dashboard rồi bấm lại." },
        );
        expect(start).not.toHaveBeenCalled();
        // And it can be tried again.
        expect(
          screen.getByRole("button", { name: "Lấy link đăng nhập" }),
        ).toBeEnabled();
      });

      it("is closed again when the sign-in could not be started", async () => {
        vi.spyOn(fakeAgentConnectionService, "start").mockRejectedValue(
          new ServiceError("Slow down.", 429, "too_many_requests"),
        );
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "Claude");
        await user.click(
          screen.getByRole("button", { name: "Lấy link đăng nhập" }),
        );

        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "Không bắt đầu kết nối được",
            { description: "Slow down." },
          ),
        );
        expect(popup.close).toHaveBeenCalledTimes(1);
        expect(popup.location.replace).not.toHaveBeenCalled();
        expect(screen.queryByLabelText("Callback URL")).not.toBeInTheDocument();
      });

      it("is closed again, and the connection let go, when the provider gives no page to sign in at", async () => {
        const real = await fakeAgentConnectionService.start("claude");

        vi.spyOn(fakeAgentConnectionService, "start").mockResolvedValue({
          ...real,
          authorization: null,
        });
        const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
        const user = await setup();

        await openAddFromHeader(user);
        await chooseProvider(user, "Claude");
        await user.click(
          screen.getByRole("button", { name: "Lấy link đăng nhập" }),
        );

        await waitFor(() =>
          expect(toast.error).toHaveBeenCalledWith(
            "Nhà cung cấp không trả về trang đăng nhập",
          ),
        );
        expect(popup.close).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledWith(real.id);
        expect(screen.queryByLabelText("Callback URL")).not.toBeInTheDocument();
      });
    });

    it("says so when the address pasted back is not right, and lets it be pasted again", async () => {
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "ChatGPT");
      await user.click(
        screen.getByRole("button", { name: "Lấy link đăng nhập" }),
      );
      await user.click(await screen.findByLabelText("Callback URL"));
      await user.paste("http://localhost:1455/auth/callback");
      await user.click(verifyButton());

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Chưa kết nối được", {
          description:
            "The callback URL does not contain an authorization code.",
        }),
      );
      expect(screen.queryByText(/Đã verify/)).not.toBeInTheDocument();

      await user.clear(screen.getByLabelText("Callback URL"));
      await user.click(screen.getByLabelText("Callback URL"));
      await user.paste(CALLBACK);
      await user.click(verifyButton());

      expect(await screen.findByText(/Đã verify/)).toBeInTheDocument();
    });

    it("finishes a sign-in with a code by itself, once the person has signed in", async () => {
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "Grok");
      await user.click(
        screen.getByRole("button", { name: "Lấy mã đăng nhập" }),
      );

      expect(await screen.findByText("ABCD-1234")).toBeInTheDocument();
      expect(screen.getByText("Đang chờ bạn đăng nhập…")).toBeInTheDocument();
      expect(verifyButton()).toBeDisabled();

      // The fake answers connected the first time it is asked, after a second.
      expect(
        await screen.findByText(/Đã verify/, {}, { timeout: 4000 }),
      ).toBeInTheDocument();
    });

    it("says why a key the provider does not accept did not connect, and lets another be tried", async () => {
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "DeepSeek");
      await user.type(screen.getByLabelText("API key DeepSeek"), "bad-key");
      await user.click(verifyButton());

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Chưa kết nối được", {
          description: "The provider did not accept that key.",
        }),
      );
      expect(screen.queryByText(/Đã verify/)).not.toBeInTheDocument();

      await user.clear(screen.getByLabelText("API key DeepSeek"));
      await user.type(screen.getByLabelText("API key DeepSeek"), "good-key");
      await user.click(verifyButton());

      expect(await screen.findByText(/Đã verify/)).toBeInTheDocument();
    });

    it("tells the seller why verifying did not pass, and verifies again without connecting again", async () => {
      const connect = vi.spyOn(fakeAgentConnectionService, "connectKey");
      vi.spyOn(fakeServiceStockService, "verify").mockRejectedValueOnce(
        new ServiceError(
          "The deepseek account did not answer a test request: the provider answered 401",
          502,
          "provider_unavailable",
        ),
      );
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "DeepSeek");
      await user.type(screen.getByLabelText("Giá ($)"), "5");
      await user.type(
        screen.getByLabelText("API key DeepSeek"),
        "fake-not-a-secret",
      );
      await user.click(verifyButton());

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith("Verify không qua", {
          description:
            "The deepseek account did not answer a test request: the provider answered 401",
        }),
      );
      expect(screen.queryByText(/Đã verify/)).not.toBeInTheDocument();
      expect(addButton()).toBeDisabled();

      // The account is connected; only the check is asked again.
      await user.click(verifyButton());

      expect(await screen.findByText(/Đã verify/)).toBeInTheDocument();
      expect(connect).toHaveBeenCalledTimes(1);
    });
  });

  describe("adding", () => {
    it("cannot be added until the account is verified, and the days and price are valid", async () => {
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "DeepSeek");
      await user.type(screen.getByLabelText("Giá ($)"), "5");

      expect(addButton()).toBeDisabled();

      await user.type(
        screen.getByLabelText("API key DeepSeek"),
        "fake-not-a-secret",
      );
      await user.click(verifyButton());
      await screen.findByText(/Đã verify/);

      expect(addButton()).toBeEnabled();

      await user.clear(screen.getByLabelText("Giá ($)"));

      expect(addButton()).toBeDisabled();

      await user.type(screen.getByLabelText("Giá ($)"), "5");
      await user.clear(screen.getByLabelText("Hạn dùng (ngày)"));
      await user.type(screen.getByLabelText("Hạn dùng (ngày)"), "366");

      expect(screen.getByText("Từ 1 đến 365 ngày.")).toBeInTheDocument();
      expect(addButton()).toBeDisabled();
    });

    it("says next to the price what is wrong with it", async () => {
      const user = await setup();

      await openAddFromHeader(user);
      await user.type(screen.getByLabelText("Giá ($)"), "4.005");

      expect(
        screen.getByText("Từ $0.01 đến $10,000, tối đa 2 số lẻ."),
      ).toBeInTheDocument();
    });

    it("puts the ticket on sale named after what was verified, and gives its agent a card", async () => {
      const add = vi.spyOn(fakeServiceStockService, "addListing");
      const user = await setup();

      await verifyDeepseek(user);
      await user.clear(screen.getByLabelText("Hạn dùng (ngày)"));
      await user.type(screen.getByLabelText("Hạn dùng (ngày)"), "14");
      await user.type(screen.getByLabelText("Giá ($)"), "5.50");
      await user.click(addButton());

      expect(
        await screen.findByRole("button", {
          name: "Sửa gói DeepSeek Plus · 14 ngày",
        }),
      ).toBeInTheDocument();
      expect(add).toHaveBeenCalledWith("connection-deepseek-1", {
        days: 14,
        name: "DeepSeek Plus · 14 ngày",
        price_micro: 5_500_000,
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(toast.success).toHaveBeenCalledWith(
        "Đã thêm DeepSeek Plus · 14 ngày lên bán",
        {
          description:
            "$5.50 · 14 ngày. Ai mua sẽ nhận một key chỉ chạy trên account này.",
        },
      );
      expect(cardNames()).toEqual(["ChatGPT", "Claude", "DeepSeek"]);
      expect(card("DeepSeek")).toHaveTextContent("1 gói");
    });

    it("keeps the account that was connected, and does not let it go, once it is on sale", async () => {
      const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
      const user = await setup();

      await verifyDeepseek(user);
      await user.type(screen.getByLabelText("Giá ($)"), "5");
      await user.click(addButton());
      await screen.findByRole("button", {
        name: "Sửa gói DeepSeek Plus · 7 ngày",
      });

      expect(disconnect).not.toHaveBeenCalled();
    });

    it("keeps the form, with the account verified, when the server refuses", async () => {
      vi.spyOn(fakeServiceStockService, "addListing").mockRejectedValue(
        new ServiceError(
          "That account is on sale already, or sold to a customer whose ticket has not ended.",
          409,
          "already_exists",
        ),
      );
      const user = await setup();

      await verifyDeepseek(user);
      await user.type(screen.getByLabelText("Giá ($)"), "5");
      await user.click(addButton());

      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledWith(
          "Không thêm được hàng Hub William",
          {
            description:
              "That account is on sale already, or sold to a customer whose ticket has not ended.",
          },
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(dialog()).toBeInTheDocument();
      expect(screen.getByText(/Đã verify/)).toBeInTheDocument();
      expect(screen.getByLabelText("Giá ($)")).toHaveValue("5");
      expect(addButton()).toBeEnabled();
    });

    it("cannot be sent twice, nor closed, while it is on its way", async () => {
      let finish: () => void = () => {};
      const add = vi.spyOn(fakeServiceStockService, "addListing");

      add.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () =>
              resolve({
                account_label: null,
                created_at: "2026-11-06T12:00:00+07:00",
                days: 7,
                id: "listing-new",
                listed: true,
                name: "DeepSeek Plus · 7 ngày",
                plan: null,
                price_micro: 5_000_000,
                provider: "deepseek",
                quota: [],
                quota_captured_at: null,
                seller: null,
                status: "for_sale",
              });
          }),
      );
      const user = await setup();

      await verifyDeepseek(user);
      await user.type(screen.getByLabelText("Giá ($)"), "5");
      await user.click(addButton());

      expect(addButton()).toBeDisabled();
      expect(screen.getByRole("button", { name: "Hủy" })).toBeDisabled();

      await user.keyboard("{Escape}");

      expect(dialog()).toBeInTheDocument();

      finish();

      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(add).toHaveBeenCalledTimes(1);
    });
  });

  describe("an account that was connected here and is not put on sale", () => {
    it("is let go when the form is closed", async () => {
      const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
      const user = await setup();

      await verifyDeepseek(user);
      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledWith("connection-deepseek-1");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("is let go too when a sign-in was started and never finished", async () => {
      const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "Claude");
      await user.click(
        screen.getByRole("button", { name: "Lấy link đăng nhập" }),
      );
      await screen.findByLabelText("Callback URL");
      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(disconnect).toHaveBeenCalledWith("connection-claude-1");
    });

    it("is not asked about when nothing was connected", async () => {
      const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
      const user = await setup();

      await openAddFromHeader(user);
      await chooseProvider(user, "Claude");
      await user.click(screen.getByRole("button", { name: "Hủy" }));

      expect(disconnect).not.toHaveBeenCalled();
    });

    it("is let go, and verified no more, when another agent is chosen", async () => {
      const disconnect = vi.spyOn(fakeAgentConnectionService, "disconnect");
      const user = await setup();

      await verifyDeepseek(user);
      await chooseProvider(user, "Groq");

      expect(disconnect).toHaveBeenCalledWith("connection-deepseek-1");
      expect(screen.queryByText(/Đã verify/)).not.toBeInTheDocument();
      expect(screen.getByLabelText("API key Groq")).toHaveValue("");
      expect(addButton()).toBeDisabled();
    });
  });
});

describe("PosRoute, who may sell", () => {
  it("never asks for the tickets of a cashier", () => {
    const listings = vi.spyOn(fakeServiceStockService, "listings");

    renderPage(<PosRoute />, "cashier");

    expect(
      screen.getByText("Trang này không dành cho vai trò của bạn"),
    ).toBeInTheDocument();
    expect(listings).not.toHaveBeenCalled();
  });

  it.each(["manager", "stock-keeper"] as const)(
    "lets a %s put an account on sale",
    async (role) => {
      renderPage(<PosRoute />, role);

      expect(
        await screen.findByRole("button", { name: `Sửa gói ${MAX}` }),
      ).toBeInTheDocument();
      expect(
        within(card("Claude")).getByRole("button", {
          name: "Thêm gói cho Claude",
        }),
      ).toBeInTheDocument();
    },
  );
});
