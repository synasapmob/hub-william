import { afterEach, describe, expect, it, vi } from "vitest";

import playgroundService from "./index";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function streamResponse() {
  return new Response(
    'data: {"type":"response.output_text.delta","delta":"Hello"}\n\ndata: {"type":"response.completed"}\n\n',
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("session-backed Playground requests", () => {
  it("reports a missing Playground API as an availability error", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: "not_found", message: "Missing route" },
            { status: 404 },
          ),
        ),
    );
    await expect(
      playgroundService.models(
        "chatgpt",
        "selected-account",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Playground is temporarily unavailable");
  });

  it("preserves a 403 error instead of claiming pool access was lost", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { code: "forbidden", message: "This request was blocked." },
            { status: 403 },
          ),
        ),
    );
    await expect(
      playgroundService.chat({
        connectionId: "selected-account",
        provider: "chatgpt",
        model: "model",
        messages: [{ role: "user", content: "Hello" }],
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toThrow("This request was blocked.");
  });

  it("shows the Google reason from a nested Gemini 403 response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json(
          {
            error: {
              code: 403,
              message: "This Google project cannot use the selected model.",
              status: "PERMISSION_DENIED",
            },
          },
          { status: 403 },
        ),
      ),
    );
    await expect(
      playgroundService.chat({
        connectionId: "selected-gemini-account",
        provider: "gemini",
        model: "gemini-3.8-flash-medium",
        messages: [{ role: "user", content: "Hello" }],
        signal: new AbortController().signal,
        onDelta: vi.fn(),
      }),
    ).rejects.toThrow("This Google project cannot use the selected model.");
  });

  it("refreshes an expired Hub session once and sends no gateway credential", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.fn(async (request: Request) => {
      requests.push(request);
      if (requests.length === 1)
        return Response.json(
          { code: "unauthorized", message: "Log in" },
          { status: 401 },
        );
      if (new URL(request.url).pathname === "/auth/refresh")
        return Response.json({ user: { id: "user", username: "member" } });
      return streamResponse();
    });
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    await playgroundService.chat({
      connectionId: "selected-account",
      provider: "chatgpt",
      model: "model",
      messages: [{ role: "user", content: "Hi" }],
      signal: new AbortController().signal,
      onDelta,
    });
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/playground/chat",
      "/auth/refresh",
      "/playground/chat",
    ]);
    expect(
      requests.every(
        (request) =>
          request.credentials === "include" &&
          !request.headers.has("Authorization"),
      ),
    ).toBe(true);
    expect(onDelta).toHaveBeenCalledWith("Hello");
  });

  it("streams ChatGPT deltas before completion when the provider omits Content-Type", async () => {
    let streamController!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(body));
    vi.stubGlobal("fetch", fetchMock);
    const onDelta = vi.fn();
    const response = playgroundService.chat({
      connectionId: "selected-account",
      provider: "chatgpt",
      model: "gpt-5.6-sol",
      messages: [{ role: "user", content: "Hello" }],
      signal: new AbortController().signal,
      onDelta,
    });
    streamController.enqueue(
      new TextEncoder().encode(
        'event: response.output_text.delta\ndata: {"delta":"Hello"}\n\n',
      ),
    );
    await vi.waitFor(() => expect(onDelta).toHaveBeenCalledWith("Hello"));
    streamController.enqueue(
      new TextEncoder().encode("event: response.completed\ndata: {}\n\n"),
    );
    streamController.close();
    await response;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not retry upstream unauthorized errors or failed streams", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          { error: { message: "Upstream expired" } },
          { status: 401 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      connectionId: "selected-account",
      provider: "deepseek" as const,
      model: "model",
      messages: [{ role: "user" as const, content: "Hi" }],
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    };
    await expect(playgroundService.chat(options)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledOnce();
    fetchMock
      .mockClear()
      .mockResolvedValue(
        new Response(
          'data: {"type":"response.output_text.delta","delta":"Partial"}\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    await expect(playgroundService.chat(options)).rejects.toThrow(
      "before the response completed",
    );
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
