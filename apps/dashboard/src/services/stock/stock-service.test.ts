import { afterEach, describe, expect, it, vi } from "vitest";

import type { TelegramProduct } from "@/services/sales/sales-types";

import {
  imageIdOf,
  imageUrl,
  stockService,
  type StockInput,
} from "./stock-service";

const IMAGE_ID = "3f2b8c1e-6d4a-4b7e-9a10-2c5d7e8f9a0b";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

const API_PRODUCT = {
  available: 10,
  hot: true,
  image_id: IMAGE_ID,
  listed: true,
  on_hand: 12,
  plan: "Pro 1 tháng",
  price_vnd: 459_000,
  provider: "Claude",
  reserved: 2,
  slug: "claude-pro-1-thang",
  variant: null,
  warranty: "WF",
  warranty_note: null,
  guide: null,
  delivers_accounts: false,
};

const PRODUCT: TelegramProduct = {
  hot: true,
  image_url: imageUrl(IMAGE_ID),
  listed: true,
  on_hand: 12,
  plan: "Pro 1 tháng",
  price_vnd: 459_000,
  provider: "Claude",
  reserved: 2,
  slug: "claude-pro-1-thang",
  type: "telegram",
  variant: null,
  warranty: "WF",
  warranty_note: null,
  guide: null,
  delivers_accounts: false,
};

const INPUT: StockInput = {
  delivers_accounts: false,
  hot: true,
  image_url: imageUrl(IMAGE_ID),
  listed: true,
  plan: "Pro 1 tháng",
  price_vnd: 459_000,
  provider: "Claude",
  variant: null,
  warranty: "WF",
  warranty_note: null,
  guide: null,
};

function answer(response: Response | Error) {
  const spy = vi.spyOn(globalThis, "fetch");

  if (response instanceof Error) spy.mockRejectedValueOnce(response);
  else spy.mockResolvedValueOnce(response);

  return spy;
}

/** The request `fetch` was given, whether as a `Request` or as a URL and options. */
async function sent(spy: ReturnType<typeof answer>) {
  const [first, init] = spy.mock.calls[0] as [Request | string, RequestInit?];
  const request = first instanceof Request ? first : undefined;

  return {
    body: request
      ? await request.clone().text()
      : (init?.body as BodyInit | null | undefined),
    contentType:
      request?.headers.get("content-type") ??
      new Headers(init?.headers).get("content-type"),
    credentials: request?.credentials ?? init?.credentials,
    method: request?.method ?? init?.method,
    path: new URL(request?.url ?? (first as string)).pathname,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a picture's address", () => {
  it("is made from its id and read back from the address", () => {
    expect(imageUrl(IMAGE_ID)).toBe(
      `http://localhost:8080/dashboard/images/${IMAGE_ID}`,
    );
    expect(imageIdOf(imageUrl(IMAGE_ID))).toBe(IMAGE_ID);
  });

  it("is not read from an address that is not one of the shop's", () => {
    expect(imageIdOf("")).toBeNull();
    expect(imageIdOf("blob:uploaded-claude.png")).toBeNull();
    expect(imageIdOf("https://picsum.photos/400/300?random=1")).toBeNull();
    expect(
      imageIdOf("http://localhost:8080/dashboard/images/not-an-id"),
    ).toBeNull();
  });
});

describe("stockService.list", () => {
  it("answers the packages as the pages use them, with their pictures addressed", async () => {
    const spy = answer(
      json(200, {
        products: [
          API_PRODUCT,
          { ...API_PRODUCT, image_id: null, slug: "x", variant: "Gia đình" },
        ],
      }),
    );

    const products = await stockService.list();

    expect(products[0]).toEqual(PRODUCT);
    expect(products[1]).toMatchObject({
      image_url: "",
      slug: "x",
      variant: "Gia đình",
    });
    expect((await sent(spy)).path).toBe("/dashboard/telegram/products");
    expect((await sent(spy)).credentials).toBe("include");
  });

  it("answers the guide the shop wrote, and null when it wrote none", async () => {
    answer(
      json(200, {
        products: [
          { ...API_PRODUCT, guide: "Đăng nhập bằng email được gửi." },
          { ...API_PRODUCT, slug: "plain", guide: null },
          // A server that leaves the field out, as it does when there is no guide.
          Object.fromEntries(
            Object.entries(API_PRODUCT).filter(([key]) => key !== "guide"),
          ),
        ],
      }),
    );

    const products = await stockService.list();

    expect(products.map((product) => product.guide)).toEqual([
      "Đăng nhập bằng email được gửi.",
      null,
      null,
    ]);
  });

  it("answers the shop's own warranty note, and null when the product has the standard one", async () => {
    answer(
      json(200, {
        products: [
          { ...API_PRODUCT, warranty_note: "Không bảo hành đổi trả" },
          { ...API_PRODUCT, slug: "plain", warranty_note: null },
          // A server that leaves the field out, as it does for the standard note.
          Object.fromEntries(
            Object.entries(API_PRODUCT).filter(
              ([key]) => key !== "warranty_note",
            ),
          ),
        ],
      }),
    );

    const products = await stockService.list();

    expect(products.map((product) => product.warranty_note)).toEqual([
      "Không bảo hành đổi trả",
      null,
      null,
    ]);
  });

  it("raises the API's message when it refuses", async () => {
    answer(json(403, { code: "forbidden", message: "You may not." }));

    await expect(stockService.list()).rejects.toMatchObject({
      code: "forbidden",
      message: "You may not.",
      status: 403,
    });
  });

  it("says the server cannot be reached when it cannot", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(stockService.list()).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
    });
  });
});

describe("stockService.create", () => {
  it("sends the fields, the first count and the picture's id", async () => {
    const spy = answer(json(201, API_PRODUCT));

    expect(await stockService.create({ ...INPUT, stock: 12 })).toEqual(PRODUCT);

    const request = await sent(spy);

    expect(request).toMatchObject({
      method: "POST",
      path: "/dashboard/telegram/products",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      available: 12,
      hot: true,
      image_id: IMAGE_ID,
      listed: true,
      plan: "Pro 1 tháng",
      price_vnd: 459_000,
      provider: "Claude",
      variant: null,
      warranty: "WF",
      // No note of the shop's own asks the server for the standard one.
      warranty_note: "",
      // No guide asks the server to clear it.
      guide: "",
      delivers_accounts: false,
    });
  });

  it("sends the warranty note the shop wrote", async () => {
    const spy = answer(json(201, API_PRODUCT));

    await stockService.create({
      ...INPUT,
      stock: 1,
      warranty_note: "Không bảo hành đổi trả",
    });

    expect(JSON.parse((await sent(spy)).body as string).warranty_note).toBe(
      "Không bảo hành đổi trả",
    );
  });

  it("sends no picture for an address that is not one of the shop's", async () => {
    const spy = answer(json(201, API_PRODUCT));

    await stockService.create({
      ...INPUT,
      image_url: "blob:somewhere",
      stock: 1,
    });

    expect(JSON.parse((await sent(spy)).body as string).image_id).toBeNull();
  });

  it("raises the message of a product that already exists", async () => {
    answer(
      json(409, {
        code: "already_exists",
        message: "That product already exists.",
      }),
    );

    await expect(
      stockService.create({ ...INPUT, stock: 1 }),
    ).rejects.toMatchObject({
      code: "already_exists",
      message: "That product already exists.",
      status: 409,
    });
  });
});

describe("stockService.loadAccounts", () => {
  it("posts the block to the package and answers the counts, nothing else", async () => {
    const spy = answer(json(200, { added: 2, available: 5, duplicates: 1 }));

    const loaded = await stockService.loadAccounts(
      "claude-pro-1-thang",
      "one@example.test|first\ntwo@example.test|second",
    );

    const request = await sent(spy);

    expect(request).toMatchObject({
      credentials: "include",
      method: "POST",
      path: "/dashboard/telegram/products/claude-pro-1-thang/accounts",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      accounts: "one@example.test|first\ntwo@example.test|second",
    });
    expect(loaded).toEqual({ added: 2, available: 5, duplicates: 1 });
  });

  it("raises the API's own words when it refuses", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "That package does not hand out accounts.",
      }),
    );

    await expect(
      stockService.loadAccounts("claude-pro-1-thang", "a@example.test|x"),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "That package does not hand out accounts.",
      status: 422,
    });
  });
});

describe("stockService.accounts", () => {
  it("lists the accounts of a package, hidden as the API hides them", async () => {
    const spy = answer(
      json(200, {
        accounts: [
          {
            email_hint: "s***@example.test",
            id: "account-1",
            loaded_at: "2026-11-08T09:00:00Z",
            loaded_by: "minhanh",
            order_reference: null,
            sold_at: null,
          },
        ],
      }),
    );

    const accounts = await stockService.accounts("claude-pro-1-thang");

    expect(await sent(spy)).toMatchObject({
      credentials: "include",
      method: "GET",
      path: "/dashboard/telegram/products/claude-pro-1-thang/accounts",
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].email_hint).toBe("s***@example.test");
  });

  it("is keyed under the stock, so a change to the stock refreshes it", () => {
    expect(stockService.accountsKey("claude-pro-1-thang")).toEqual([
      ...stockService.queryKey,
      "accounts",
      "claude-pro-1-thang",
    ]);
  });
});

describe("stockService.searchAccounts", () => {
  const PAGE = {
    accounts: [],
    counts: { all: 3, sold: 1, unsold: 2 },
    total: 1,
  };

  it("asks for a page of accounts with the filters it was given", async () => {
    const spy = answer(json(200, PAGE));

    const page = await stockService.searchAccounts({
      page: 2,
      product: "claude-pro-1-thang",
      query: "  abc123  ",
      status: "sold",
    });

    const request = await sent(spy);
    const [first] = spy.mock.calls[0] as [Request | string];
    const url = new URL(first instanceof Request ? first.url : first);

    expect(request).toMatchObject({ credentials: "include", method: "GET" });
    expect(request.path).toBe("/dashboard/telegram/accounts");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      page: "2",
      page_size: "20",
      product: "claude-pro-1-thang",
      q: "abc123",
      status: "sold",
    });
    expect(page).toEqual(PAGE);
  });

  it("leaves a filter out when it is not set", async () => {
    const spy = answer(json(200, PAGE));

    await stockService.searchAccounts({
      page: 1,
      product: null,
      query: "   ",
      status: "all",
    });

    const [first] = spy.mock.calls[0] as [Request | string];
    const url = new URL(first instanceof Request ? first.url : first);

    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("page_size")).toBe("20");
    expect(url.searchParams.has("product")).toBe(false);
    expect(url.searchParams.has("q")).toBe(false);
    expect(url.searchParams.has("status")).toBe(false);
  });
});

describe("stockService.removeAccount", () => {
  it("deletes the account and answers the count now", async () => {
    const spy = answer(json(200, { available: 3 }));

    expect(await stockService.removeAccount("account-1")).toBe(3);
    expect(await sent(spy)).toMatchObject({
      method: "DELETE",
      path: "/dashboard/telegram/accounts/account-1",
    });
  });
});

describe("stockService.revealAccounts", () => {
  it("sends the password with the accounts wanted and answers their lines in order", async () => {
    const spy = answer(
      json(200, {
        accounts: [
          { account: "two@example.test|b", id: "account-2" },
          { account: "one@example.test|a", id: "account-1" },
        ],
      }),
    );

    expect(
      await stockService.revealAccounts(
        ["account-2", "account-1"],
        "my-password",
      ),
    ).toEqual([
      { account: "two@example.test|b", id: "account-2" },
      { account: "one@example.test|a", id: "account-1" },
    ]);

    const request = await sent(spy);

    expect(request).toMatchObject({
      credentials: "include",
      method: "POST",
      path: "/dashboard/telegram/accounts/reveal",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      ids: ["account-2", "account-1"],
      password: "my-password",
    });
  });

  it("raises the API's refusal with its status, so the page can say what it means", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "That password is not right.",
      }),
    );

    await expect(
      stockService.revealAccounts(["account-1"], "wrong"),
    ).rejects.toMatchObject({ code: "validation_error", status: 422 });
  });
});

describe("stockService.editAccounts", () => {
  it("sends the block with the accounts it was made from, and whether it is only a check", async () => {
    const spy = answer(
      json(200, {
        added: 1,
        available: 4,
        changed: 2,
        duplicates: 0,
        removed: 3,
      }),
    );

    expect(
      await stockService.editAccounts("claude-pro-1-thang", {
        accounts: "one@example.test|a\ntwo@example.test|b",
        dryRun: true,
        ids: ["account-1", "account-2"],
      }),
    ).toEqual({
      added: 1,
      available: 4,
      changed: 2,
      duplicates: 0,
      removed: 3,
    });

    const request = await sent(spy);

    expect(request).toMatchObject({
      credentials: "include",
      method: "PUT",
      path: "/dashboard/telegram/products/claude-pro-1-thang/accounts",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      accounts: "one@example.test|a\ntwo@example.test|b",
      dry_run: true,
      ids: ["account-1", "account-2"],
    });
  });

  it("raises the API's refusal, so the page can say what it means", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message:
          "Some of these accounts were sold or removed while you were editing.",
      }),
    );

    await expect(
      stockService.editAccounts("claude-pro-1-thang", {
        accounts: "",
        dryRun: false,
        ids: ["account-1"],
      }),
    ).rejects.toMatchObject({ code: "validation_error", status: 422 });
  });
});

describe("stockService.updateAccount", () => {
  it("sends only what changes and answers the email as a list shows it", async () => {
    const spy = answer(json(200, { email_hint: "n***@example.test" }));

    expect(
      await stockService.updateAccount("account-1", { password: "new-pass" }),
    ).toBe("n***@example.test");

    const request = await sent(spy);

    expect(request).toMatchObject({
      credentials: "include",
      method: "PUT",
      path: "/dashboard/telegram/accounts/account-1",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      password: "new-pass",
    });
  });

  it("raises the API's refusal, so the page can say what it means", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "That account is already in stock for this package.",
      }),
    );

    await expect(
      stockService.updateAccount("account-1", { email: "other@example.test" }),
    ).rejects.toMatchObject({ code: "validation_error", status: 422 });
  });
});

describe("stockService.create, for a package that hands out accounts", () => {
  it("says so, with none in stock", async () => {
    const spy = answer(json(201, { ...API_PRODUCT, delivers_accounts: true }));

    const created = await stockService.create({
      ...INPUT,
      delivers_accounts: true,
      stock: 0,
    });

    expect(JSON.parse((await sent(spy)).body as string)).toMatchObject({
      available: 0,
      delivers_accounts: true,
    });
    expect(created.delivers_accounts).toBe(true);
  });
});

describe("stockService.update", () => {
  it("sends the guide the shop wrote", async () => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.update("claude-pro-1-thang", {
      ...INPUT,
      guide: "Đăng nhập bằng email được gửi.",
    });

    expect(JSON.parse((await sent(spy)).body as string).guide).toBe(
      "Đăng nhập bằng email được gửi.",
    );
  });

  it("sends an empty guide to clear it", async () => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.update("claude-pro-1-thang", INPUT);

    expect(JSON.parse((await sent(spy)).body as string).guide).toBe("");
  });

  it("sends the warranty note the shop wrote", async () => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.update("claude-pro-1-thang", {
      ...INPUT,
      warranty_note: "Bảo hành login check 1 tiếng",
    });

    expect(JSON.parse((await sent(spy)).body as string).warranty_note).toBe(
      "Bảo hành login check 1 tiếng",
    );
  });

  it("sends an empty note to go back to the standard one", async () => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.update("claude-pro-1-thang", INPUT);

    expect(JSON.parse((await sent(spy)).body as string).warranty_note).toBe("");
  });

  it("puts the fields on the package, named by its slug and nothing else", async () => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.update("claude-pro-1-thang", {
      ...INPUT,
      plan: "Pro 12 tháng",
    });

    const request = await sent(spy);

    expect(request).toMatchObject({
      method: "PUT",
      path: "/dashboard/telegram/products/claude-pro-1-thang",
    });
    expect(JSON.parse(request.body as string)).toEqual({
      delivers_accounts: false,
      hot: true,
      image_id: IMAGE_ID,
      listed: true,
      plan: "Pro 12 tháng",
      price_vnd: 459_000,
      provider: "Claude",
      variant: null,
      warranty: "WF",
      // No note of the shop's own asks the server for the standard one.
      warranty_note: "",
      // No guide asks the server to clear it.
      guide: "",
    });
  });
});

describe("stockService.update, making a package hand out accounts", () => {
  it("sends the flag with the other fields, and answers the count the server set", async () => {
    const spy = answer(
      json(200, { ...API_PRODUCT, delivers_accounts: true, on_hand: 0 }),
    );

    const converted = await stockService.update("claude-pro-1-thang", {
      ...INPUT,
      delivers_accounts: true,
    });

    expect(JSON.parse((await sent(spy)).body as string).delivers_accounts).toBe(
      true,
    );
    expect(converted).toMatchObject({ delivers_accounts: true, on_hand: 0 });
  });

  it("raises the server's words when it will not", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "This package still holds accounts that are not sold.",
      }),
    );

    await expect(
      stockService.update("claude-pro-1-thang", INPUT),
    ).rejects.toMatchObject({ code: "validation_error", status: 422 });
  });
});

describe("stockService.changeStock", () => {
  it.each([10, -5])("sends a change of %i", async (delta) => {
    const spy = answer(json(200, API_PRODUCT));

    await stockService.changeStock("claude-pro-1-thang", delta);

    const request = await sent(spy);

    expect(request).toMatchObject({
      method: "POST",
      path: "/dashboard/telegram/products/claude-pro-1-thang/stock",
    });
    expect(JSON.parse(request.body as string)).toEqual({ delta });
  });

  it("raises the message of a change the server will not make", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "That takes out more units than there are in stock.",
      }),
    );

    await expect(
      stockService.changeStock("claude-pro-1-thang", -99),
    ).rejects.toMatchObject({
      message: "That takes out more units than there are in stock.",
      status: 422,
    });
  });
});

describe("stockService.remove", () => {
  it("deletes the package", async () => {
    const spy = answer(new Response(null, { status: 204 }));

    await stockService.remove("claude-pro-1-thang");

    expect(await sent(spy)).toMatchObject({
      method: "DELETE",
      path: "/dashboard/telegram/products/claude-pro-1-thang",
    });
  });

  it("raises the reason when buyers still have it in an order", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "Buyers have orders open for this product. Hide it instead.",
      }),
    );

    await expect(
      stockService.remove("claude-pro-1-thang"),
    ).rejects.toMatchObject({
      message: "Buyers have orders open for this product. Hide it instead.",
    });
  });
});

describe("stockService.announce", () => {
  it("posts the text for the bot to send, and answers where it went", async () => {
    const spy = answer(json(200, { audience: 12, channel: true }));

    const announced = await stockService.announce("Hàng mới về");

    const request = await sent(spy);

    expect(request.method).toBe("POST");
    expect(request.path).toBe("/dashboard/telegram/announcements");
    expect(JSON.parse(String(request.body))).toEqual({ text: "Hàng mới về" });
    expect(request.credentials).toBe("include");
    expect(announced).toEqual({ audience: 12, channel: true });
  });

  it("names the package the button opens when it is given one", async () => {
    const spy = answer(json(200, { audience: 12, channel: true }));

    await stockService.announce("20% off ChatGPT Business", "chatgpt-business");

    const request = await sent(spy);

    expect(JSON.parse(String(request.body))).toEqual({
      product: "chatgpt-business",
      text: "20% off ChatGPT Business",
    });
  });

  it.each([
    [
      501,
      "not_available",
      "The dashboard is not connected to the Telegram bot.",
    ],
    [502, "provider_unavailable", "The Telegram bot did not answer."],
    [422, "validation_error", "A Telegram message is at most 4096 characters."],
  ])(
    "fails with the API's own words when it answers %i",
    async (status, code, message) => {
      answer(json(status, { code, message }));

      await expect(stockService.announce("Hàng mới về")).rejects.toMatchObject({
        code,
        message,
        status,
      });
    },
  );

  it("fails clearly when the server cannot be reached", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(stockService.announce("Hàng mới về")).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
      status: null,
    });
  });
});
