import { z } from "zod";

export interface PlaygroundVoiceTranscript {
  id: number;
  role: "user" | "assistant";
  text: string;
  complete: boolean;
}

export type PlaygroundVoiceEvent =
  | { type: "started" }
  | {
      type: "transcript";
      role: "user" | "assistant";
      text: string;
      complete: boolean;
    }
  | { type: "error"; message: string };

const eventSchema = z.object({ type: z.string() });
const deltaSchema = z.object({ item: z.object({ text: z.string() }) });
const doneSchema = z.object({
  turn: z.object({
    role: z.enum(["user", "assistant"]),
    transcript: z.string(),
  }),
});
const errorSchema = z.object({
  message: z.string().optional(),
  error: z.union([z.string(), z.object({ message: z.string() })]).optional(),
});

export function readVoiceEvent(message: unknown): PlaygroundVoiceEvent | null {
  if (typeof message !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(message);
  } catch {
    return null;
  }
  const envelope = eventSchema.safeParse(value);
  if (!envelope.success) return null;
  switch (envelope.data.type) {
    case "session.started":
      return { type: "started" };
    case "input_transcript.added":
    case "output_transcript.added": {
      const delta = deltaSchema.safeParse(value);
      return delta.success
        ? {
            type: "transcript",
            role:
              envelope.data.type === "input_transcript.added"
                ? "user"
                : "assistant",
            text: delta.data.item.text,
            complete: false,
          }
        : null;
    }
    case "turn.done": {
      const done = doneSchema.safeParse(value);
      return done.success
        ? {
            type: "transcript",
            ...done.data.turn,
            text: done.data.turn.transcript,
            complete: true,
          }
        : null;
    }
    case "delegation.created":
      return {
        type: "error",
        message:
          "This call requested a tool that Voice does not support. Start a new call to continue.",
      };
    case "error": {
      const error = errorSchema.safeParse(value);
      const detail = error.success ? error.data : undefined;
      return {
        type: "error",
        message:
          detail?.message ??
          (typeof detail?.error === "string"
            ? detail.error
            : detail?.error?.message) ??
          "The voice service reported an error.",
      };
    }
    default:
      return null;
  }
}

export function appendVoiceTranscript(
  entries: PlaygroundVoiceTranscript[],
  event: Extract<PlaygroundVoiceEvent, { type: "transcript" }>,
): PlaygroundVoiceTranscript[] {
  if (!event.text) return entries;
  // V3 supplies no stable turn ID. Track the latest unfinished entry for each
  // speaker so overlapping input/output deltas do not create fragmented rows.
  const index = entries.findLastIndex((entry) => entry.role === event.role);
  const previous = entries[index];
  if (!previous || previous.complete) {
    if (event.complete && previous?.text === event.text) return entries;
    return [
      ...entries,
      {
        id: (entries.at(-1)?.id ?? 0) + 1,
        role: event.role,
        text: event.text,
        complete: event.complete,
      },
    ];
  }
  // Match Codex V3: a delayed final that does not extend the current partial
  // must not overwrite a newer utterance by the same speaker.
  if (event.complete && !event.text.startsWith(previous.text)) return entries;
  return entries.map((entry, at) =>
    at === index
      ? {
          ...entry,
          text: event.complete ? event.text : entry.text + event.text,
          complete: event.complete,
        }
      : entry,
  );
}
