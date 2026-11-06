import { afterEach, describe, expect, it, vi } from "vitest";

import {
  serviceUsageService,
  ServiceUsageError,
} from "./service-usage-service";

const apiUsage = {
  breakdown: [
    {
      completed_requests: 2,
      gateway_key_id: "key-1",
      key_last_four: "a1b2",
      known_cached_tokens: 4,
      known_input_tokens: 150,
      known_output_tokens: 30,
      model: "gpt-test",
      provider: "chatgpt",
      requests: 3,
      spent_micro: 1_500_000,
      token_known_requests: 3,
    },
    {
      completed_requests: 1,
      gateway_key_id: null,
      key_last_four: null,
      known_cached_tokens: 0,
      known_input_tokens: 0,
      known_output_tokens: 0,
      model: null,
      provider: "claude",
      requests: 1,
      spent_micro: 0,
      token_known_requests: 0,
    },
  ],
  completed_requests: 3,
  daily_usage: [
    {
      date: "2026-11-05",
      known_total_tokens: 180,
      requests: 4,
      token_known_requests: 3,
    },
  ],
  known_cached_tokens: 4,
  known_input_tokens: 150,
  known_output_tokens: 30,
  period_days: 7,
  requests: 4,
  spent_micro: 1_500_000,
  token_known_requests: 3,
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

describe("serviceUsageService", () => {
  it("asks for the chosen period and maps the response to camelCase", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValue(jsonResponse(apiUsage));
    vi.stubGlobal("fetch", fetchMock);

    const usage = await serviceUsageService.usage({ days: 7 });

    const requested = urlOf(fetchMock.mock.calls[0][0]);
    expect(requested.pathname).toBe("/service/usage");
    expect(requested.searchParams.get("days")).toBe("7");
    expect(usage).toMatchObject({
      completedRequests: 3,
      dailyUsage: [
        {
          date: "2026-11-05",
          knownTotalTokens: 180,
          requests: 4,
          tokenKnownRequests: 3,
        },
      ],
      knownInputTokens: 150,
      knownOutputTokens: 30,
      periodDays: 7,
      requests: 4,
      spentMicro: 1_500_000,
      tokenKnownRequests: 3,
    });
    expect(usage.breakdown).toEqual([
      {
        completedRequests: 2,
        gatewayKeyId: "key-1",
        keyLastFour: "a1b2",
        knownCachedTokens: 4,
        knownInputTokens: 150,
        knownOutputTokens: 30,
        model: "gpt-test",
        provider: "chatgpt",
        requests: 3,
        spentMicro: 1_500_000,
        tokenKnownRequests: 3,
      },
      {
        completedRequests: 1,
        gatewayKeyId: null,
        keyLastFour: null,
        knownCachedTokens: 0,
        knownInputTokens: 0,
        knownOutputTokens: 0,
        model: null,
        provider: "claude",
        requests: 1,
        spentMicro: 0,
        tokenKnownRequests: 0,
      },
    ]);
  });

  it("repeats the call once after refreshing an expired session", async () => {
    const fetchMock = vi
      .fn<(input: RequestInfo | URL) => Promise<Response>>()
      .mockResolvedValueOnce(jsonResponse({ code: "unauthorized" }, 401))
      .mockResolvedValueOnce(jsonResponse({ user: { id: "user-1" } }))
      .mockResolvedValueOnce(jsonResponse(apiUsage));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      serviceUsageService.usage({ days: 30 }),
    ).resolves.toMatchObject({ requests: 4 });
    expect(
      fetchMock.mock.calls.map(([input]) => urlOf(input).pathname),
    ).toEqual(["/service/usage", "/auth/refresh", "/service/usage"]);
  });

  it("reports the API message when the request is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () =>
        jsonResponse(
          {
            code: "validation_error",
            message: "days must be between 1 and 365.",
          },
          422,
        ),
      ),
    );

    await expect(serviceUsageService.usage({ days: 0 })).rejects.toThrow(
      "days must be between 1 and 365.",
    );
  });

  it("replaces a network failure with the unavailable message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    const failure = serviceUsageService.usage({ days: 30 });

    await expect(failure).rejects.toBeInstanceOf(ServiceUsageError);
    await expect(failure).rejects.toThrow("The usage service is unavailable.");
  });
});
