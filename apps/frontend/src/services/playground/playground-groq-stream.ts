import { z } from "zod";
import type { PlaygroundGroqTurnResult } from "./index";

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("transcript"),
    text: z.string().max(8000),
  }),
  z.object({ type: z.literal("delta"), text: z.string().min(1).max(6400) }),
  z.object({
    type: z.literal("audio"),
    audio: z
      .string()
      .min(1)
      .max(3 * 1024 * 1024),
  }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type PlaygroundGroqEvent = z.infer<typeof eventSchema>;

interface ReadGroqStreamOptions {
  stream: ReadableStream<Uint8Array>;
  signal: AbortSignal;
  onEvent?: (event: PlaygroundGroqEvent) => void;
}

export default async function readGroqStream({
  stream,
  signal,
  onEvent,
}: ReadGroqStreamOptions): Promise<PlaygroundGroqTurnResult | null> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const result: PlaygroundGroqTurnResult = {
    transcript: "",
    reply: "",
    audio: [],
  };
  let buffer = "";
  let complete = false;
  let audioBytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (!complete) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done)
        throw new Error(
          "Groq stopped before completing this turn. Start a new call to retry.",
        );
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > 6 * 1024 * 1024)
        throw new Error("Groq returned an oversized voice response.");
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const record = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const data = record
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        const event = eventSchema.parse(JSON.parse(data));
        if (event.type === "error") {
          throw new Error(event.message);
        }
        if (event.type === "transcript") {
          if (result.transcript)
            throw new Error("Groq returned an invalid voice transcript.");
          // Ignore punctuation/noise before exposing any transcript or BOT output.
          // Finally cancels the stream, including remaining upstream work.
          if (!/[\p{L}\p{N}]/u.test(event.text)) return null;
          result.transcript = event.text;
        } else if (event.type === "delta") {
          if (!result.transcript)
            throw new Error("Groq returned an invalid voice reply.");
          result.reply += event.text;
          if (Array.from(result.reply).length > 1600)
            throw new Error("Groq returned an oversized voice reply.");
        } else if (event.type === "audio") {
          audioBytes += event.audio.length;
          if (!result.reply || audioBytes > 6 * 1024 * 1024)
            throw new Error("Groq returned invalid voice audio.");
          result.audio.push(event.audio);
        } else if (event.type === "done") {
          if (
            !result.transcript ||
            !result.reply.trim() ||
            !result.audio.length
          )
            throw new Error("Groq returned an incomplete voice response.");
          complete = true;
        }
        signal.throwIfAborted();
        onEvent?.(event);
        if (complete) break;
      }
    }
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
