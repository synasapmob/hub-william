import { describe, expect, it } from "vitest";

import {
  eventPromptId,
  eventSessionId,
  folderName,
  parseClaudeHookPayload,
  parseLogPayload,
} from "./claude-telemetry";

function logPayload(attributes: Record<string, string>) {
  return {
    resourceLogs: [
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: "1750000000000000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: Object.entries(attributes).map(([key, value]) => ({
                  key,
                  value: { stringValue: value },
                })),
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("Claude hook payload", () => {
  it("keeps only the session and the working directory", () => {
    const event = parseClaudeHookPayload({
      session_id: "abc-123",
      cwd: "/Users/me/code/hub-william",
      hook_event_name: "SessionStart",
      transcript_path: "/Users/me/.claude/projects/conversation.jsonl",
    });

    expect(event).toEqual({
      sessionId: "abc-123",
      cwd: "/Users/me/code/hub-william",
    });
  });

  it("rejects a payload missing either field", () => {
    expect(parseClaudeHookPayload({ session_id: "abc" })).toBeNull();
    expect(parseClaudeHookPayload({ cwd: "/tmp/x" })).toBeNull();
    expect(parseClaudeHookPayload({ session_id: " ", cwd: " " })).toBeNull();
    expect(parseClaudeHookPayload("not an object")).toBeNull();
  });
});

describe("folderName", () => {
  it("reduces a path to its last segment", () => {
    expect(folderName("/Users/me/code/hub-william")).toBe("hub-william");
    expect(folderName("/Users/me/code/hub-william/")).toBe("hub-william");
    expect(folderName("C:\\Users\\me\\code\\hub-william")).toBe("hub-william");
  });

  it("never returns an empty label", () => {
    expect(folderName("/")).toBe("Unknown project");
    expect(folderName("")).toBe("Unknown project");
  });
});

describe("event identity", () => {
  it("reads the session and prompt an api_request belongs to", () => {
    const [event] = parseLogPayload(
      logPayload({ "session.id": "s-1", "prompt.id": "p-1" }),
    );

    expect(eventSessionId(event)).toBe("s-1");
    expect(eventPromptId(event)).toBe("p-1");
  });

  // Usage from a session no hook reported still parses; it is the ingest path
  // that decides such an event belongs to no tracked project.
  it("returns null when neither id is present", () => {
    const [event] = parseLogPayload(logPayload({ model: "claude-opus-5" }));

    expect(eventSessionId(event)).toBeNull();
    expect(eventPromptId(event)).toBeNull();
  });
});
