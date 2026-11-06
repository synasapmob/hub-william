import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ServiceKeyTestError,
  serviceKeyTestService,
} from "./service-key-test-service";

const options = {
  key: "hw_svc_fake-key-for-a-test-0123456789",
  message: "Hello, how are you?",
  model: "deepseek-flash",
  origin: "https://hub.example.test/api",
  provider: "deepseek" as const,
};

function stream(...records: string[]) {
  return new Response(records.join(""), {
    headers: { "Content-Type": "text/event-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("serviceKeyTestService", () => {
  it("sends the key alone, without the session cookie, and streams the answer", async () => {
    const fetchMock = vi
      .fn<(input: string, init: RequestInit) => Promise<Response>>()
      .mockResolvedValue(
        stream(
          'data: {"type":"response.output_text.delta","delta":"I am "}\n\n',
          'data: {"type":"response.output_text.delta","delta":"fine."}\n\n',
          'data: {"type":"response.completed","response":{}}\n\n',
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();

    const result = await serviceKeyTestService.run({
      ...options,
      onDelta,
      signal: new AbortController().signal,
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hub.example.test/api/gateway/deepseek/responses");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("omit");
    expect(init.headers).toEqual({
      Authorization: "Bearer hw_svc_fake-key-for-a-test-0123456789",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: "deepseek-flash",
      stream: true,
    });
    expect(onDelta.mock.calls.map(([text]) => text).join("")).toBe(
      "I am fine.",
    );
    expect(result.status).toBe(200);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it.each([
    [401, { code: "invalid_gateway_key", message: "Provide an active key." }],
    [402, { code: "insufficient_balance", message: "Insufficient balance." }],
    [422, { code: "validation_error", message: "Not on the price list." }],
  ])("reports the gateway's message for HTTP %i", async (status, payload) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(Response.json(payload, { status })),
    );

    const failure = serviceKeyTestService.run({
      ...options,
      onDelta: vi.fn(),
      signal: new AbortController().signal,
    });

    await expect(failure).rejects.toBeInstanceOf(ServiceKeyTestError);
    await expect(failure).rejects.toMatchObject({
      message: payload.message,
      status,
    });
  });

  it("reads an agent's own error shape, and falls back to a sentence for a status", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(
            { error: { message: "Rate limited." } },
            { status: 429 },
          ),
        )
        .mockResolvedValueOnce(new Response("not json", { status: 502 })),
    );

    await expect(
      serviceKeyTestService.run({
        ...options,
        onDelta: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ message: "Rate limited." });
    await expect(
      serviceKeyTestService.run({
        ...options,
        onDelta: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      message: "The service has no capacity for this agent right now.",
    });
  });

  it("says the gateway could not be reached on a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));

    await expect(
      serviceKeyTestService.run({
        ...options,
        onDelta: vi.fn(),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ message: "The gateway could not be reached." });
  });
});
