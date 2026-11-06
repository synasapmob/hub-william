import { afterEach, describe, expect, it, vi } from "vitest";

import {
  gatewayKeysService,
  GatewayKeyServiceError,
} from "./gateway-keys-service";

const apiKey = {
  created_at: "2026-03-05T10:00:00Z",
  id: "key-1",
  last_four: "a1b2",
  last_used_at: null,
};

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

function pathnameOf(input: RequestInfo | URL) {
  return new URL(input instanceof Request ? input.url : String(input)).pathname;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("gatewayKeysService", () => {
  it("repeats a call once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse([apiKey]));
    vi.stubGlobal("fetch", fetchMock);

    await expect(gatewayKeysService.list()).resolves.toEqual([
      {
        createdAt: "2026-03-05T10:00:00Z",
        id: "key-1",
        lastFour: "a1b2",
        lastUsedAt: null,
      },
    ]);
    expect(fetchMock.mock.calls.map(([input]) => pathnameOf(input))).toEqual([
      "/gateway-keys",
      "/auth/refresh",
      "/gateway-keys",
    ]);
  });

  it("reports the API message when the request is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(
            { code: "forbidden", message: "Key limit reached." },
            403,
          ),
        ),
    );

    const failure = gatewayKeysService.create();

    await expect(failure).rejects.toBeInstanceOf(GatewayKeyServiceError);
    await expect(failure).rejects.toMatchObject({
      message: "Key limit reached.",
    });
  });

  it("replaces a network failure with the unavailable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(gatewayKeysService.revoke("key-1")).rejects.toMatchObject({
      message: "The gateway key service is unavailable.",
    });
  });

  it("keeps an organization's keys under the organization's own endpoints", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse([apiKey]))
      .mockResolvedValueOnce(
        jsonResponse({ ...apiKey, key: "hw_org_once-only-secret" }, 201),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      gatewayKeysService.listForOrganization("org-1"),
    ).resolves.toHaveLength(1);
    await expect(
      gatewayKeysService.createForOrganization("org-1"),
    ).resolves.toMatchObject({
      key: "hw_org_once-only-secret",
      lastFour: "a1b2",
    });
    await gatewayKeysService.revokeForOrganization("org-1", "key-1");

    expect(
      fetchMock.mock.calls.map(([input, init]) => {
        const request = input instanceof Request ? input : null;
        return `${init?.method ?? request?.method ?? "GET"} ${pathnameOf(input)}`;
      }),
    ).toEqual([
      "GET /organizations/org-1/gateway-keys",
      "POST /organizations/org-1/gateway-keys",
      "DELETE /organizations/org-1/gateway-keys/key-1",
    ]);
  });

  it("reports the API message when an organization key is refused", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(async () =>
          jsonResponse(
            { code: "forbidden", message: "You are not in this organization." },
            403,
          ),
        ),
    );

    await expect(
      gatewayKeysService.createForOrganization("org-1"),
    ).rejects.toMatchObject({ message: "You are not in this organization." });
  });
});
