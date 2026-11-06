import { afterEach, describe, expect, it, vi } from "vitest";

import { json } from "@/test/mock-fetch";
import { apiUrl } from "@/utils/utils.api-url";

import { sessionFetch } from "./api-client";

const UNAUTHORIZED = {
  code: "unauthorized",
  message: "Log in to continue.",
};

/** What `fetch` was asked, in order, as `METHOD path`: a request, or a URL and options. */
function asked(spy: ReturnType<typeof vi.spyOn>) {
  return (spy.mock.calls as [Request | string, RequestInit?][]).map(
    ([input, init]) => {
      const method = input instanceof Request ? input.method : init?.method;
      const url = input instanceof Request ? input.url : input;

      return `${method ?? "GET"} ${new URL(url).pathname}`;
    },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sessionFetch", () => {
  it("passes an answer through, and asks once", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(200, { ok: true }));

    const response = await sessionFetch(apiUrl("/dashboard/staff"));

    expect(response.status).toBe(200);
    expect(asked(spy)).toEqual(["GET /dashboard/staff"]);
  });

  it("refreshes the session on a 401 and asks again, with the same body", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(401, UNAUTHORIZED))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(200, { ok: true }));

    const response = await sessionFetch(
      new Request(apiUrl("/dashboard/telegram/orders/AB12/cancel"), {
        body: JSON.stringify({ reason: "x" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    );

    expect(response.status).toBe(200);
    expect(asked(spy)).toEqual([
      "POST /dashboard/telegram/orders/AB12/cancel",
      "POST /auth/refresh",
      "POST /dashboard/telegram/orders/AB12/cancel",
    ]);
    // The second try is the same request, not an empty one.
    expect(await (spy.mock.calls[2][0] as Request).clone().json()).toEqual({
      reason: "x",
    });
    expect((spy.mock.calls[1] as [string, RequestInit])[1].credentials).toBe(
      "include",
    );
  });

  it("leaves the 401 to the caller when the session cannot be refreshed, and does not ask again", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(401, UNAUTHORIZED))
      .mockResolvedValueOnce(json(401, UNAUTHORIZED));

    const response = await sessionFetch(apiUrl("/dashboard/staff"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual(UNAUTHORIZED);
    expect(asked(spy)).toEqual(["GET /dashboard/staff", "POST /auth/refresh"]);
  });

  it("gives up when the refresh cannot be made at all", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(401, UNAUTHORIZED))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));

    expect((await sessionFetch(apiUrl("/dashboard/staff"))).status).toBe(401);
  });

  it("asks only once more: a 401 that outlives a refresh is final", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(401, UNAUTHORIZED))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json(401, UNAUTHORIZED));

    expect((await sessionFetch(apiUrl("/dashboard/staff"))).status).toBe(401);
    expect(asked(spy)).toHaveLength(3);
  });

  it.each([
    ["/auth/login"],
    ["/auth/refresh"],
    ["/auth/register"],
    ["/dashboard/session"],
  ])("does not refresh for %s, whose 401 means what it says", async (path) => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json(401, UNAUTHORIZED));

    const response = await sessionFetch(
      new Request(apiUrl(path), { method: "POST" }),
    );

    expect(response.status).toBe(401);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh between requests that fail together", async () => {
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) => {
        const request = input as Request | string;
        const url = typeof request === "string" ? request : request.url;
        const path = new URL(url).pathname;

        if (path === "/auth/refresh")
          return new Response(null, { status: 204 });

        // Each path fails the first time and answers the second.
        const seen = asked(spy).filter((call) =>
          call.endsWith(` ${path}`),
        ).length;

        return seen === 1 ? json(401, UNAUTHORIZED) : json(200, { path });
      });

    const [first, second] = await Promise.all([
      sessionFetch(apiUrl("/dashboard/staff")),
      sessionFetch(apiUrl("/dashboard/telegram/orders")),
    ]);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(
      asked(spy).filter((call) => call === "POST /auth/refresh"),
    ).toHaveLength(1);
  });
});
