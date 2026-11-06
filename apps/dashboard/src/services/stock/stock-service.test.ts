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
};

const INPUT: StockInput = {
  hot: true,
  image_url: imageUrl(IMAGE_ID),
  listed: true,
  plan: "Pro 1 tháng",
  price_vnd: 459_000,
  provider: "Claude",
  variant: null,
  warranty: "WF",
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
    });
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

describe("stockService.update", () => {
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
      hot: true,
      image_id: IMAGE_ID,
      listed: true,
      plan: "Pro 12 tháng",
      price_vnd: 459_000,
      provider: "Claude",
      variant: null,
      warranty: "WF",
    });
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
