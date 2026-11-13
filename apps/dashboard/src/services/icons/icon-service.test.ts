import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceError } from "@/services/api/api-client";

import { iconService } from "./icon-service";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

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
  const url = new URL(request?.url ?? (first as string));

  return {
    body: request
      ? await request.clone().text()
      : (init?.body as BodyInit | null | undefined),
    contentType:
      request?.headers.get("content-type") ??
      new Headers(init?.headers).get("content-type"),
    credentials: request?.credentials ?? init?.credentials,
    method: request?.method ?? init?.method,
    path: url.pathname,
    search: url.search,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("iconService.list", () => {
  it("answers whether the bucket is set up and which icon each provider shows", async () => {
    const assignments = [
      {
        key: "icons/claude-1a2b3c4d.png",
        provider: "claude",
        url: "https://cdn.example.com/icons/claude-1a2b3c4d.png",
      },
    ];
    const spy = answer(json(200, { assignments, enabled: true }));

    await expect(iconService.list()).resolves.toEqual({
      assignments,
      enabled: true,
    });
    expect(await sent(spy)).toMatchObject({
      credentials: "include",
      method: "GET",
      path: "/dashboard/icons",
    });
  });

  it("says so when it could not be read", async () => {
    answer(json(500, { code: "internal", message: "Something broke." }));

    await expect(iconService.list()).rejects.toMatchObject({
      message: "Something broke.",
      status: 500,
    });
  });
});

describe("iconService.library", () => {
  it("answers the icons in the bucket", async () => {
    const icons = [
      {
        key: "icons/a.png",
        size: 12,
        url: "https://cdn.example.com/icons/a.png",
      },
    ];
    const spy = answer(json(200, { icons }));

    await expect(iconService.library()).resolves.toEqual(icons);
    expect((await sent(spy)).path).toBe("/dashboard/icons/library");
  });

  it("passes on that the bucket is not set up", async () => {
    answer(
      json(501, {
        code: "not_available",
        message: "Icon storage is not set up.",
      }),
    );

    await expect(iconService.library()).rejects.toMatchObject({
      message: "Icon storage is not set up.",
      status: 501,
    });
  });
});

describe("iconService.upload", () => {
  it("sends the picture, named for the provider, and answers its key", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "logo.png", {
      type: "image/png",
    });
    const spy = answer(
      json(201, { key: "icons/chat-gpt-01020304.png", url: "https://x/y" }),
    );

    await expect(iconService.upload(file, "Chat GPT")).resolves.toBe(
      "icons/chat-gpt-01020304.png",
    );

    const request = await sent(spy);
    expect(request).toMatchObject({
      contentType: "application/octet-stream",
      credentials: "include",
      method: "POST",
      path: "/dashboard/icons",
      search: "?name=Chat%20GPT",
    });
  });

  it("gives the API's reason when it refuses the picture", async () => {
    answer(
      json(422, {
        code: "validation_error",
        message: "An icon must be a PNG, JPEG, GIF or WebP file.",
      }),
    );

    const error = await iconService
      .upload(new File(["x"], "a.svg"), "Claude")
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ServiceError);
    expect(error).toMatchObject({
      message: "An icon must be a PNG, JPEG, GIF or WebP file.",
      status: 422,
    });
  });

  it("falls back to a plain message when the answer has no reason", async () => {
    answer(new Response("", { status: 413 }));

    await expect(
      iconService.upload(new File(["x"], "a.png"), "Claude"),
    ).rejects.toMatchObject({
      message: "Không tải được icon lên.",
      status: 413,
    });
  });
});

describe("iconService.assign", () => {
  it("sends the icon's name for the provider's slug", async () => {
    const spy = answer(
      json(200, { key: "icons/a.png", provider: "claude", url: "https://x/a" }),
    );

    await iconService.assign("claude", "icons/a.png");

    const request = await sent(spy);
    expect(request).toMatchObject({
      method: "PUT",
      path: "/dashboard/icons/providers/claude",
    });
    expect(JSON.parse(request.body as string)).toEqual({ key: "icons/a.png" });
  });

  it("says it could not reach the server when it cannot", async () => {
    answer(new TypeError("Failed to fetch"));

    await expect(
      iconService.assign("claude", "icons/a.png"),
    ).rejects.toMatchObject({
      message: "Không kết nối được tới máy chủ.",
    });
  });
});

describe("iconService.remove", () => {
  it("deletes the icon by its name in the bucket and answers who showed it", async () => {
    const spy = answer(
      json(200, {
        cleared: ["chatgpt", "claude"],
        key: "icons/claude-0f1e2d3c.png",
      }),
    );

    await expect(
      iconService.remove("icons/claude-0f1e2d3c.png"),
    ).resolves.toEqual(["chatgpt", "claude"]);

    expect(await sent(spy)).toMatchObject({
      method: "DELETE",
      path: "/dashboard/icons/claude-0f1e2d3c.png",
    });
  });

  it("passes on why the bucket would not", async () => {
    answer(
      json(502, {
        code: "provider_unavailable",
        message: "The icon storage did not answer. Try again in a moment.",
      }),
    );

    await expect(iconService.remove("icons/a.png")).rejects.toMatchObject({
      message: "The icon storage did not answer. Try again in a moment.",
      status: 502,
    });
  });
});
