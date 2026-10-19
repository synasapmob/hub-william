import { afterEach, describe, expect, it, vi } from "vitest";

import { agentService, AgentServiceError } from "./agent-service";

const apiConnection = {
  account_label: "ops@example.com",
  availability_status: "active",
  created_at: "2026-03-05T10:00:00Z",
  id: "connection-1",
  provider: "claude",
  status: "connected",
  updated_at: "2026-03-06T10:00:00Z",
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

describe("agentService session handling", () => {
  it("repeats a call once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse(apiConnection));
    vi.stubGlobal("fetch", fetchMock);

    await expect(agentService.getConnection("connection-1")).resolves.toEqual({
      accountLabel: "ops@example.com",
      authorization: null,
      availabilityStatus: "active",
      createdAt: "2026-03-05T10:00:00Z",
      failureMessage: null,
      id: "connection-1",
      plan: null,
      provider: "claude",
      status: "connected",
      updatedAt: "2026-03-06T10:00:00Z",
      validationUrl: null,
    });
    expect(fetchMock.mock.calls.map(([input]) => pathnameOf(input))).toEqual([
      "/agent-connections/connection-1",
      "/auth/refresh",
      "/agent-connections/connection-1",
    ]);
  });

  it("reports the API message when the session cannot be refreshed", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ code: "unauthorized", message: "Sign in again." }, 401),
      );
    vi.stubGlobal("fetch", fetchMock);

    const failure = agentService.getConnection("connection-1");

    await expect(failure).rejects.toBeInstanceOf(AgentServiceError);
    await expect(failure).rejects.toMatchObject({ message: "Sign in again." });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not refresh the session when listing pools", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockImplementation(async () =>
        jsonResponse({ code: "unauthorized", message: "Sign in first." }, 401),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(agentService.listPools()).rejects.toMatchObject({
      message: "Sign in first.",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("agentService failures", () => {
  it("replaces a network failure with the connection service message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(agentService.listConnections()).rejects.toMatchObject({
      message: "The provider connection service is unavailable.",
    });
  });

  it("keeps the operation specific message for credential refresh", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(
      agentService.refreshConnection("connection-1"),
    ).rejects.toMatchObject({
      message: "The provider credential could not be refreshed.",
    });
  });

  it("keeps the operation specific message for a join request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(
      agentService.requestJoin("pool-1", { reason: "Team", telegram: "@syn" }),
    ).rejects.toMatchObject({ message: "The join request could not be sent." });
  });
});

describe("agentService.connectApiKey", () => {
  it("posts the key to the connect path the catalogue defines", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input);

      expect(await request.json()).toEqual({ api_key: "secret" });

      return jsonResponse({ ...apiConnection, provider: "deepseek" });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      agentService.connectApiKey("deepseek", "secret"),
    ).resolves.toMatchObject({ provider: "deepseek" });
    expect(pathnameOf(fetchMock.mock.calls[0][0])).toBe(
      "/agent-connections/deepseek",
    );
  });
});

describe("agentService.createdLabel", () => {
  it("formats a date in UTC", () => {
    expect(agentService.createdLabel("2026-03-05T23:30:00Z")).toBe(
      "Mar 05, 2026",
    );
  });
});
