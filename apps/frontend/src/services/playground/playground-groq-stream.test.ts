import { describe, expect, it, vi } from "vitest";
import playgroundService from "./index";
import readGroqStream from "./playground-groq-stream";

const encode = (value: unknown) =>
  new TextEncoder().encode(`data: ${JSON.stringify(value)}\r\n\r\n`);

describe("Groq voice event stream", () => {
  it.each(["", " ", ".", "...?!", "… — 。！？", "🎵"])(
    "silently discards %j before any rows/audio and cancels the response",
    async (text) => {
      const cancel = vi.fn();
      const onEvent = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          // Even if BOT output already arrived in the same network chunk.
          const records = [
            { type: "transcript", text },
            { type: "delta", text: "Unwanted greeting" },
            { type: "audio", audio: btoa("wave") },
          ].map(encode);
          const bytes = new Uint8Array(
            records.reduce((sum, item) => sum + item.length, 0),
          );
          let offset = 0;
          for (const record of records) {
            bytes.set(record, offset);
            offset += record.length;
          }
          controller.enqueue(bytes);
        },
        cancel,
      });
      await expect(
        readGroqStream({
          stream,
          signal: new AbortController().signal,
          onEvent,
        }),
      ).resolves.toBeNull();
      expect(onEvent).not.toHaveBeenCalled();
      expect(cancel).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
    },
  );

  it.each(["I", "Hi!", "Ừ", "你好", "はい", "١", "2"])(
    "preserves short speech %j",
    async (text) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const event of [
            { type: "transcript", text },
            { type: "delta", text: "Hello" },
            { type: "audio", audio: btoa("wave") },
            { type: "done" },
          ])
            controller.enqueue(encode(event));
          controller.close();
        },
      });
      await expect(
        readGroqStream({ stream, signal: new AbortController().signal }),
      ).resolves.toMatchObject({ transcript: text, reply: "Hello" });
    },
  );

  it("exposes split UTF-8 deltas before audio or completion and cancels the reader on interruption", async () => {
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    const canceled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        writer = controller;
      },
      cancel: canceled,
    });
    const controller = new AbortController();
    const onEvent = vi.fn();
    const reading = readGroqStream({
      stream,
      signal: controller.signal,
      onEvent,
    });
    const rejected = expect(reading).rejects.toMatchObject({
      name: "AbortError",
    });
    writer.enqueue(encode({ type: "transcript", text: "Hello" }));
    const delta = encode({ type: "delta", text: "Chào bạn" });
    for (const byte of delta) writer.enqueue(new Uint8Array([byte]));
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(2));
    expect(onEvent).toHaveBeenLastCalledWith({
      type: "delta",
      text: "Chào bạn",
    });
    controller.abort();
    await rejected;
    expect(canceled).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  });

  it("consumes the authenticated streaming transport and only completes after audio and done", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of [
              { type: "transcript", text: "Hello" },
              { type: "delta", text: "Hi " },
              { type: "delta", text: "there" },
              { type: "audio", audio: btoa("wave") },
              { type: "done" },
            ])
              controller.enqueue(encode(event));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
    );
    try {
      const onEvent = vi.fn();
      const result = await playgroundService.groqTurn({
        connectionId: "chosen",
        model: "openai/gpt-oss-20b",
        transcript: "Hello",
        messages: [],
        signal: new AbortController().signal,
        onEvent,
      });
      expect(result).toEqual({
        transcript: "Hello",
        reply: "Hi there",
        audio: [btoa("wave")],
      });
      expect(onEvent).toHaveBeenCalledTimes(5);
      const request = fetch.mock.calls[0][0] as Request;
      expect(request.credentials).toBe("include");
      expect(await request.json()).toEqual({
        connection_id: "chosen",
        model: "openai/gpt-oss-20b",
        transcript: "Hello",
        messages: [],
        stream: true,
        stream_audio: true,
      });
    } finally {
      fetch.mockRestore();
    }
  });

  it("accepts audio before later text deltas, keeping both in order", async () => {
    const events = [
      { type: "transcript", text: "Hello" },
      { type: "delta", text: "Hi! " },
      { type: "audio", audio: btoa("first") },
      { type: "delta", text: "How are you?" },
      { type: "audio", audio: btoa("second") },
      { type: "done" },
    ];
    const onEvent = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encode(event));
        controller.close();
      },
    });
    await expect(
      readGroqStream({ stream, signal: new AbortController().signal, onEvent }),
    ).resolves.toEqual({
      transcript: "Hello",
      reply: "Hi! How are you?",
      audio: [btoa("first"), btoa("second")],
    });
    expect(onEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it.each(["truncated", "error", "out-of-order"])(
    "rejects %s without silently completing or replaying",
    async (kind) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          if (kind === "out-of-order")
            controller.enqueue(encode({ type: "delta", text: "orphan" }));
          else
            controller.enqueue(encode({ type: "transcript", text: "Hello" }));
          if (kind === "error")
            controller.enqueue(
              encode({ type: "error", message: "Groq quota reached" }),
            );
          controller.close();
        },
      });
      await expect(
        readGroqStream({ stream, signal: new AbortController().signal }),
      ).rejects.toThrow(kind === "error" ? "Groq quota reached" : /Groq/);
      expect(stream.locked).toBe(false);
    },
  );
});
