import { afterEach, describe, expect, it, vi } from "vitest";

import authService from "./auth";

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("authService.session", () => {
  it("uses the refresh cookie when the expired access cookie is absent", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const pathname = new URL(request.url).pathname;

      if (pathname === "/auth/session")
        return new Response(null, { status: 204 });
      if (pathname === "/auth/refresh") {
        return jsonResponse({
          user: {
            id: "user-1",
            recovery_email: null,
            username: "syn",
          },
        });
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.session()).resolves.toEqual({
      id: "user-1",
      recoveryEmail: null,
      username: "syn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(
        ([input]) =>
          new URL(input instanceof Request ? input.url : String(input))
            .pathname,
      ),
    ).toEqual(["/auth/session", "/auth/refresh"]);
  });

  it("stays signed out when neither session cookie is valid", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);
      const pathname = new URL(request.url).pathname;

      if (pathname === "/auth/session")
        return new Response(null, { status: 204 });
      if (pathname === "/auth/refresh") {
        return jsonResponse({ message: "No active session." }, 401);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(authService.session()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
