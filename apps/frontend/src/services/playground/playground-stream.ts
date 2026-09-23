import { z } from "zod";

import type { components } from "@/services/api.generated";

interface ReadPlaygroundStreamOptions {
  provider: components["schemas"]["AgentProvider"];
  stream: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

const errorSchema = z.object({
  error: z.object({ message: z.string().optional() }).optional(),
  message: z.string().optional(),
});
const responsesDeltaSchema = z.object({ delta: z.string() });
const claudeDeltaSchema = z.object({
  delta: z.object({ type: z.string(), text: z.string().optional() }),
});
const claudeStopSchema = z.object({
  delta: z.object({ stop_reason: z.string().nullable().optional() }),
});
const geminiSchema = z.object({
  promptFeedback: z.object({ blockReason: z.string().optional() }).optional(),
  candidates: z
    .array(
      z.object({
        index: z.number().optional(),
        content: z
          .object({
            parts: z
              .array(
                z.object({
                  text: z.string().optional(),
                  thought: z.boolean().optional(),
                }),
              )
              .optional(),
          })
          .optional(),
        finishReason: z.string().optional(),
      }),
    )
    .optional(),
});

export default async function readPlaygroundStream({
  provider,
  stream,
  signal,
  onDelta,
}: ReadPlaygroundStreamOptions) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  let hasText = false;
  let sawStreamRecord = false;
  let nonStreamBody = "";
  let claudeStopReason: string | null = null;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });

  function emit(text: string) {
    if (text) {
      hasText = true;
      onDelta(text);
    }
  }

  function consume(record: string) {
    const lines = record.split(/\r?\n/);
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) {
      if (!sawStreamRecord)
        nonStreamBody = (nonStreamBody + record + "\n\n").slice(0, 16_384);
      return;
    }
    sawStreamRecord = true;
    nonStreamBody = "";
    if (data === "[DONE]") return;
    const payload: unknown = JSON.parse(data);
    const envelope = z.object({ type: z.string().optional() }).parse(payload);
    const event =
      lines
        .find((line) => line.startsWith("event:"))
        ?.slice(6)
        .trim() || envelope.type;
    // Claude's message_start has a message object; only error records need
    // the error envelope's string message shape.
    const error = errorSchema.safeParse(payload);
    if (event === "error" || (error.success && error.data.error))
      throw new Error(
        (error.success && (error.data.error?.message || error.data.message)) ||
          "The provider could not complete this response.",
      );
    if (provider === "gemini") {
      const value = geminiSchema.parse(payload);
      if (value.promptFeedback?.blockReason)
        throw new Error(
          "The provider blocked this request: " +
            value.promptFeedback.blockReason +
            ".",
        );
      for (const candidate of value.candidates ?? []) {
        if (candidate.index !== undefined && candidate.index !== 0) continue;
        for (const part of candidate.content?.parts ?? [])
          if (!part.thought && part.text) emit(part.text);
        if (candidate.finishReason) {
          if (candidate.finishReason !== "STOP")
            throw new Error(
              "The response ended before completion: " +
                candidate.finishReason +
                ".",
            );
          complete = true;
        }
      }
    } else if (provider === "claude") {
      if (event === "content_block_delta") {
        const { delta } = claudeDeltaSchema.parse(payload);
        if (delta.type === "text_delta" && delta.text) emit(delta.text);
      }
      if (event === "message_delta")
        claudeStopReason =
          claudeStopSchema.parse(payload).delta.stop_reason ?? null;
      if (event === "message_stop") {
        if (claudeStopReason === "refusal" && !hasText)
          emit("Claude declined this request.");
        if (
          claudeStopReason !== "end_turn" &&
          claudeStopReason !== "stop_sequence" &&
          claudeStopReason !== "refusal"
        )
          throw new Error(
            "The provider stopped before completing its answer" +
              (claudeStopReason ? ": " + claudeStopReason : "") +
              ".",
          );
        complete = true;
      }
    } else {
      if (
        event === "response.output_text.delta" ||
        event === "response.refusal.delta"
      )
        emit(responsesDeltaSchema.parse(payload).delta);
      if (event === "response.failed" || event === "response.incomplete")
        throw new Error(
          "The provider returned an incomplete response. You can try sending the message again.",
        );
      if (event === "response.completed") complete = true;
    }
  }

  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      buffer += decoder.decode(value, { stream: !done });
      if (
        !sawStreamRecord &&
        buffer.length > 65_536 &&
        !buffer.includes("data:")
      )
        throw new Error("The provider did not return a streaming response.");
      let separator: RegExpExecArray | null;
      while ((separator = /\r?\n\r?\n/.exec(buffer))) {
        const record = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        consume(record);
      }
      if (done || complete) break;
    }
    if (!complete && !sawStreamRecord) {
      let payload: unknown;
      try {
        payload = JSON.parse((nonStreamBody + buffer).trim());
      } catch {
        // A non-JSON response cannot be used as a streamed answer.
      }
      const error = errorSchema.safeParse(payload);
      if (error.success) {
        const message = error.data.error?.message ?? error.data.message;
        if (message) throw new Error(message);
      }
      throw new Error("The provider did not return a streaming response.");
    }
    if (!complete)
      throw new Error(
        "The connection ended before the response completed. Your partial answer is shown below.",
      );
    if (!hasText)
      throw new Error(
        "The model completed without a text answer. Try another model or message.",
      );
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      throw new Error(
        "The provider returned an unreadable response. The answer is incomplete.",
        { cause: error },
      );
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
