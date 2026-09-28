import { describe, expect, it } from "vitest";
import {
  appendVoiceTranscript,
  readVoiceEvent,
  type PlaygroundVoiceTranscript,
} from "./playground-voice-events";

describe("Codex V3 voice transcripts", () => {
  it("decodes the native item.text deltas and turn.role/transcript final", () => {
    expect(
      readVoiceEvent(
        JSON.stringify({
          type: "input_transcript.added",
          item: { text: "Hello" },
        }),
      ),
    ).toEqual({
      type: "transcript",
      role: "user",
      text: "Hello",
      complete: false,
    });
    expect(
      readVoiceEvent(
        JSON.stringify({
          type: "output_transcript.added",
          item: { text: "Hi" },
        }),
      ),
    ).toEqual({
      type: "transcript",
      role: "assistant",
      text: "Hi",
      complete: false,
    });
    expect(
      readVoiceEvent(
        JSON.stringify({
          type: "turn.done",
          turn: { role: "assistant", transcript: "Hi there" },
        }),
      ),
    ).toMatchObject({
      type: "transcript",
      role: "assistant",
      text: "Hi there",
      complete: true,
    });
    expect(readVoiceEvent("malformed")).toBeNull();
    expect(readVoiceEvent(JSON.stringify({ type: "turn.created" }))).toBeNull();
  });

  it("keeps both speakers in order while overlapping deltas and final events arrive", () => {
    let entries: PlaygroundVoiceTranscript[] = [];
    const add = (
      role: "user" | "assistant",
      text: string,
      complete = false,
    ) => {
      entries = appendVoiceTranscript(entries, {
        type: "transcript",
        role,
        text,
        complete,
      });
    };
    add("user", "Hello");
    add("assistant", "Hi");
    add("user", " there");
    add("user", "Hello there!", true);
    add("assistant", " friend");
    add("assistant", "Hi friend", true);
    add("user", "My next question");
    expect(
      entries.map(({ role, text, complete }) => ({ role, text, complete })),
    ).toEqual([
      { role: "user", text: "Hello there!", complete: true },
      { role: "assistant", text: "Hi friend", complete: true },
      { role: "user", text: "My next question", complete: false },
    ]);
    add("user", "Hello there!", true);
    expect(entries.at(-1)?.text).toBe("My next question");
    expect(entries).toHaveLength(3);
  });

  it("surfaces provider errors and unsupported tool delegation instead of silently hanging", () => {
    expect(
      readVoiceEvent('{"type":"error","error":{"message":"Quota reached"}}'),
    ).toEqual({ type: "error", message: "Quota reached" });
    expect(readVoiceEvent('{"type":"delegation.created"}')).toMatchObject({
      type: "error",
    });
  });
});
