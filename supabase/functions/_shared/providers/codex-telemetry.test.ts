import { describe, expect, it } from "vitest";

import { parseCodexHookPayload, parseCodexLogPayload } from "./codex-telemetry";

function value(value: string | number) {
  return typeof value === "number"
    ? { intValue: String(value) }
    : { stringValue: value };
}

function attribute(key: string, entry: string | number) {
  return { key, value: value(entry) };
}

describe("Codex telemetry parser", () => {
  it("reads only completed responses and their token metadata", () => {
    const events = parseCodexLogPayload({
      resourceLogs: [
        {
          resource: {
            attributes: [attribute("conversation.id", "thread-1")],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1787130000000000000",
                  body: value("codex.sse_event"),
                  attributes: [
                    attribute("event.kind", "response.completed"),
                    attribute("model", "gpt-5.6-sol"),
                    attribute("input_token_count", 100),
                    attribute("output_token_count", 25),
                    attribute("cached_token_count", 80),
                    attribute("reasoning_token_count", 10),
                  ],
                },
                {
                  body: value("codex.user_prompt"),
                  attributes: [
                    attribute("prompt", "never persist this"),
                    attribute("prompt_length", 18),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sessionId: "thread-1",
      model: "gpt-5.6-sol",
      inputTokens: 100,
      outputTokens: 25,
      cachedInputTokens: 80,
      reasoningTokens: 10,
    });
    expect(JSON.stringify(events)).not.toContain("never persist this");
  });

  it("accepts only bounded hook metadata and ignores the prompt", () => {
    const event = parseCodexHookPayload({
      project_opt_in: "hub-william-v1",
      session_id: "thread-1",
      turn_id: "turn-1",
      cwd: "/workspace/hub-william",
      hook_event_name: "UserPromptSubmit",
      model: "gpt-5.6-sol",
      prompt: "an API key pasted by accident",
    });

    expect(event).toEqual({
      sessionId: "thread-1",
      cwd: "/workspace/hub-william",
      model: "gpt-5.6-sol",
      promptKey: "turn-1",
      promptDelta: 1,
    });
    expect(JSON.stringify(event)).not.toContain("API key");
  });

  it("rejects legacy global hook payloads without project opt-in", () => {
    expect(
      parseCodexHookPayload({
        session_id: "thread-global",
        turn_id: "turn-global",
        cwd: "/workspace/not-opted-in",
        hook_event_name: "UserPromptSubmit",
        model: "gpt-5.6-sol",
      }),
    ).toBeNull();
  });

  it("rejects an unknown project opt-in protocol", () => {
    expect(
      parseCodexHookPayload({
        project_opt_in: "hub-william-v0",
        session_id: "thread-old-protocol",
        cwd: "/workspace/opted-in",
        hook_event_name: "SessionStart",
        model: "gpt-5.6-sol",
      }),
    ).toBeNull();
  });

  it("uses Codex's event timestamp when an intermediary omits OTLP clocks", () => {
    const [event] = parseCodexLogPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    attribute("event.name", "codex.sse_event"),
                    attribute("event.kind", "response.completed"),
                    attribute("event.timestamp", "2026-08-19T10:15:30.000Z"),
                    attribute("conversation.id", "thread-2"),
                    attribute("input_token_count", 50),
                    attribute("output_token_count", 10),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(event.occurredAt.toISOString()).toBe("2026-08-19T10:15:30.000Z");
    expect(event.eventKey).toContain("2026-08-19T10:15:30.000Z");
  });

  it("ignores Codex's zero OTLP clock and uses the event timestamp", () => {
    const [event] = parseCodexLogPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "0",
                  observedTimeUnixNano: "0",
                  attributes: [
                    attribute("event.name", "codex.sse_event"),
                    attribute("event.kind", "response.completed"),
                    attribute("event.timestamp", "2026-08-19T11:45:30.000Z"),
                    attribute("conversation.id", "thread-zero-clock"),
                    attribute("input_token_count", 75),
                    attribute("output_token_count", 20),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(event.occurredAt.toISOString()).toBe("2026-08-19T11:45:30.000Z");
    expect(event.eventKey).toContain("2026-08-19T11:45:30.000Z");
  });

  it("does not count the metadata-only completed record beside usage", () => {
    const events = parseCodexLogPayload({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: "1787139930000000000",
                  attributes: [
                    attribute("event.name", "codex.sse_event"),
                    attribute("event.kind", "response.completed"),
                    attribute("conversation.id", "thread-metadata"),
                    attribute("model", "gpt-5.6-sol"),
                  ],
                },
                {
                  timeUnixNano: "1787139930000000000",
                  attributes: [
                    attribute("event.name", "codex.sse_event"),
                    attribute("event.kind", "response.completed"),
                    attribute("conversation.id", "thread-metadata"),
                    attribute("model", "gpt-5.6-sol"),
                    attribute("input_token_count", 120),
                    attribute("output_token_count", 30),
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ inputTokens: 120, outputTokens: 30 });
  });
});
