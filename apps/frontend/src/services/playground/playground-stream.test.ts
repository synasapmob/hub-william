import { describe, expect, it, vi } from "vitest";

import readPlaygroundStream from "./playground-stream";
import type { PlaygroundProviderId } from "./index";

function stream(text: string, chunkSize = 1) {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.length; offset += chunkSize)
        controller.enqueue(bytes.slice(offset, offset + chunkSize));
      controller.close();
    },
  });
}

function read(provider: PlaygroundProviderId, text: string) {
  let output = "";
  const result = readPlaygroundStream({
    provider,
    stream: stream(text),
    signal: new AbortController().signal,
    onDelta: (delta) => {
      output += delta;
    },
  });
  return { result, output: () => output };
}

describe("Playground native event streams", () => {
  it.each<PlaygroundProviderId>(["chatgpt", "grok", "deepseek"])(
    "decodes split UTF-8 and CRLF Responses events for %s",
    async (provider) => {
      const turn = read(
        provider,
        'event: response.output_text.delta\r\ndata: {"delta":"Xin chào 👋"}\r\n\r\nevent: response.completed\r\ndata: {}\r\n\r\n',
      );
      await turn.result;
      expect(turn.output()).toBe("Xin chào 👋");
    },
  );

  it("combines multiline data and ignores reasoning deltas", async () => {
    const turn = read(
      "chatgpt",
      'data: {"type":"response.reasoning_text.delta","delta":"private reasoning"}\n\ndata: {"type":"response.output_text.delta",\ndata: "delta":"Visible"}\n\ndata: {"type":"response.completed"}\n\n',
    );
    await turn.result;
    expect(turn.output()).toBe("Visible");
  });

  it.each(["response.failed", "response.incomplete"])(
    "does not mark %s as success",
    async (event) => {
      const turn = read(
        "deepseek",
        `data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: {"type":"${event}"}\n\n`,
      );
      await expect(turn.result).rejects.toThrow("incomplete");
      expect(turn.output()).toBe("Partial");
    },
  );

  it("requires a protocol completion event rather than EOF or DONE", async () => {
    const turn = read(
      "grok",
      'data: {"type":"response.output_text.delta","delta":"Partial"}\n\ndata: [DONE]\n\n',
    );
    await expect(turn.result).rejects.toThrow("before the response completed");
  });

  it("renders Claude visible text and waits for its stop reason", async () => {
    const turn = read(
      "claude",
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-opus-5-5","stop_reason":null}}\n\nevent: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\nevent: ping\ndata: {"type":"ping"}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hidden"}}\n\nevent: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    await turn.result;
    expect(turn.output()).toBe("Hello");
  });

  it("marks Claude output limits as incomplete", async () => {
    const turn = read(
      "claude",
      'event: message_delta\ndata: {"delta":{"stop_reason":"max_tokens"}}\n\nevent: message_stop\ndata: {}\n\n',
    );
    await expect(turn.result).rejects.toThrow("max_tokens");
  });

  it("keeps a Claude refusal as a completed response", async () => {
    const turn = read(
      "claude",
      'event: message_start\ndata: {"type":"message_start","message":{"content":[]}}\n\nevent: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"refusal"}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    );
    await turn.result;
    expect(turn.output()).toBe("Claude declined this request.");
  });

  it("decodes Gemini visible parts while excluding thought content", async () => {
    const turn = read(
      "gemini",
      'data: {"candidates":[{"index":0,"content":{"parts":[{"text":"hidden","thought":true},{"text":"Hello"}]}}]}\n\ndata: {"candidates":[{"index":0,"finishReason":"STOP"}]}\n\n',
    );
    await turn.result;
    expect(turn.output()).toBe("Hello");
  });

  it.each(["MAX_TOKENS", "SAFETY"])(
    "reports Gemini %s termination",
    async (finishReason) => {
      const turn = read(
        "gemini",
        `data: {"candidates":[{"finishReason":"${finishReason}"}]}\n\n`,
      );
      await expect(turn.result).rejects.toThrow(finishReason);
    },
  );

  it("reports malformed events and provider errors", async () => {
    await expect(
      read("chatgpt", "data: {not json}\n\n").result,
    ).rejects.toThrow("unreadable");
    await expect(
      read(
        "claude",
        'event: error\ndata: {"error":{"message":"Overloaded"}}\n\n',
      ).result,
    ).rejects.toThrow("Overloaded");
  });

  it("surfaces a non-streaming provider error instead of a completion error", async () => {
    const turn = read(
      "chatgpt",
      '{"error":{"message":"This model is unavailable for this account."}}',
    );
    await expect(turn.result).rejects.toThrow(
      "This model is unavailable for this account.",
    );
    expect(turn.output()).toBe("");
  });

  it("cancels a hanging stream when the user stops", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const result = readPlaygroundStream({
      provider: "chatgpt",
      stream: new ReadableStream({ cancel }),
      signal: controller.signal,
      onDelta: vi.fn(),
    });
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: "AbortError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("finishes after the terminal event without waiting for a server to close", async () => {
    const cancel = vi.fn();
    await readPlaygroundStream({
      provider: "chatgpt",
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"type":"response.output_text.delta","delta":"Hi"}\n\ndata: {"type":"response.completed"}\n\n',
            ),
          );
        },
        cancel,
      }),
      signal: new AbortController().signal,
      onDelta: vi.fn(),
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
});
