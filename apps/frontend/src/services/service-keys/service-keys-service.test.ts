import { afterEach, describe, expect, it, vi } from "vitest";

import { ServiceKeysError, serviceKeysService } from "./service-keys-service";

const apiKey = {
  created_at: "2026-11-06T03:00:00Z",
  id: "11111111-1111-4111-8111-111111111111",
  last_four: "xB_E",
  last_used_at: null,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function urlOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("serviceKeysService", () => {
  it("lists the keys and maps them to camelCase", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse([apiKey])));

    await expect(serviceKeysService.list()).resolves.toEqual([
      {
        createdAt: "2026-11-06T03:00:00Z",
        id: "11111111-1111-4111-8111-111111111111",
        lastFour: "xB_E",
        lastUsedAt: null,
      },
    ]);
  });

  it("creates a key and returns the whole key once", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        jsonResponse({ ...apiKey, key: "hw_svc_secret-not-real" }, 201),
      );
    vi.stubGlobal("fetch", fetchMock);

    const created = await serviceKeysService.create();

    expect(created.key).toBe("hw_svc_secret-not-real");
    expect(created.lastFour).toBe("xB_E");
    const request = fetchMock.mock.calls[0][0] as Request;
    expect([request.method, urlOf(request).pathname]).toEqual([
      "POST",
      "/service/keys",
    ]);
  });

  it("revokes a key by its id", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await serviceKeysService.revoke(apiKey.id);

    const request = fetchMock.mock.calls[0][0] as Request;
    expect([request.method, urlOf(request).pathname]).toEqual([
      "DELETE",
      `/service/keys/${apiKey.id}`,
    ]);
  });

  it("reports the API message when a key cannot be created", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            code: "validation_error",
            message:
              "You hold the most service keys allowed. Revoke one first.",
          },
          422,
        ),
      ),
    );

    await expect(serviceKeysService.create()).rejects.toThrow(
      "You hold the most service keys allowed. Revoke one first.",
    );
  });

  it("repeats a call once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse([apiKey]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(serviceKeysService.list()).resolves.toHaveLength(1);
    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual(["/service/keys", "/auth/refresh", "/service/keys"]);
  });

  it("replaces a network failure with the unavailable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const failure = serviceKeysService.list();

    await expect(failure).rejects.toBeInstanceOf(ServiceKeysError);
    await expect(failure).rejects.toThrow(
      "The service key service is unavailable.",
    );
  });
});
