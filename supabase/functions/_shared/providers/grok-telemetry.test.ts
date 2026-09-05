import { describe, expect, it } from "vitest";

import {
  folderName,
  hourStart,
  parseGrokHookPayload,
  parseGrokLogPayload,
  usageRecords,
} from "./grok-telemetry";

// The same real Grok Build 1.0.5 batches the decoder is tested against, with
// the account identifiers replaced by same-length placeholders: one carrying an
// api_request, one carrying a user_prompt.
const API_REQUEST_BATCH =
  "CqAGCrsBChcKDXRlcm1pbmFsLnR5cGUSBgoET3JjYQoZCg5jbGllbnQudmVyc2lvbhIHCgUxLjAuNQoaCgxzZXJ2aWNlLm5hbWUSCgoIZ3Jvay1jbGkKIAoYZ3Jva19jb2RlLnNjaGVtYS52ZXJzaW9uEgQKAnYxChwKDmFwcC5lbnRyeXBvaW50EgoKCGhlYWRsZXNzCikKD3NlcnZpY2UudmVyc2lvbhIWChQxLjAuNSAoNTExNWI0NmJjOTA5KRLfBAoSChBhaS54YWkuZ3Jva19jb2RlEsMCCaAwqTOHYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgEMhMKBW1vZGVsEgoKCGdyb2stNC42MhIKC2R1cmF0aW9uX21zEgMYnRYyFQoLc3RvcF9yZWFzb24SBgoEc3RvcDITCgxpbnB1dF90b2tlbnMSAxiQbzITCg1vdXRwdXRfdG9rZW5zEgIYITIWChByZWFzb25pbmdfdG9rZW5zEgIYHDIYChFjYWNoZV9yZWFkX3Rva2VucxIDGIABMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWaAwqTOHYs0YYhVncm9rX2NvZGUuYXBpX3JlcXVlc3QSggIJqFXdNodizRgQCTIUCg5ldmVudC5zZXF1ZW5jZRICGAUyFgoHb3V0Y29tZRILCgljb21wbGV0ZWQyEgoLZHVyYXRpb25fbXMSAxjCFjIVCg90b29sX2NhbGxfY291bnQSAhgAMhMKBW1vZGVsEgoKCGdyb2stNC42MjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWahV3TaHYs0YYhhncm9rX2NvZGUudHVybl9jb21wbGV0ZWQ=";

const USER_PROMPT_BATCH =
  "CvAFCrsBChcKDXRlcm1pbmFsLnR5cGUSBgoET3JjYQoZCg5jbGllbnQudmVyc2lvbhIHCgUxLjAuNQoaCgxzZXJ2aWNlLm5hbWUSCgoIZ3Jvay1jbGkKIAoYZ3Jva19jb2RlLnNjaGVtYS52ZXJzaW9uEgQKAnYxChwKDmFwcC5lbnRyeXBvaW50EgoKCGhlYWRsZXNzCikKD3NlcnZpY2UudmVyc2lvbhIWChQxLjAuNSAoNTExNWI0NmJjOTA5KRKvBAoSChBhaS54YWkuZ3Jva19jb2RlEqkCCaAHSoWGYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgCMhUKBnN0YXR1cxILCgljb25uZWN0ZWQyGAoOdHJhbnNwb3J0X3R5cGUSBgoEaHR0cDISCgtkdXJhdGlvbl9tcxIDGOgIMhAKCnRvb2xfY291bnQSAhgcMh8KD21jcF9zZXJ2ZXIubmFtZRIMCgptY3Bfc2VydmVyMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWaAHSoWGYs0YYh9ncm9rX2NvZGUubWNwX3NlcnZlcl9jb25uZWN0aW9uEuwBCahVnoWGYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgDMhMKDXByb21wdF9sZW5ndGgSAhgxMhMKBW1vZGVsEgoKCGdyb2stNC42MhkKC3NjcmVlbl9tb2RlEgoKCGhlYWRsZXNzMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWahVnoWGYs0YYhVncm9rX2NvZGUudXNlcl9wcm9tcHQ=";

function bytes(base64: string) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

describe("parseGrokLogPayload", () => {
  it("strips the grok_code namespace off every event name", () => {
    const events = parseGrokLogPayload(bytes(API_REQUEST_BATCH));

    expect(events.map((event) => event.name)).toEqual([
      "api_request",
      "turn_completed",
    ]);
  });

  it("merges resource attributes under the record's own", () => {
    const [event] = parseGrokLogPayload(bytes(API_REQUEST_BATCH));

    expect(event.attributes.get("service.name")?.stringValue).toBe("grok-cli");
    expect(event.attributes.get("model")?.stringValue).toBe("grok-4.6");
  });

  it("keeps the nanosecond clock as the deduplication key", () => {
    const [event] = parseGrokLogPayload(bytes(API_REQUEST_BATCH));

    expect(event.eventKey).toBe("1787192959962788000");
    expect(event.occurredAt.toISOString()).toBe("2026-08-20T02:29:19.962Z");
  });

  it("yields nothing for a payload that is not OTLP", () => {
    expect(parseGrokLogPayload(new Uint8Array([9, 9, 9]))).toEqual([]);
  });
});

describe("usageRecords", () => {
  it("reads one api_request into an hourly bucket", () => {
    const records = usageRecords(parseGrokLogPayload(bytes(API_REQUEST_BATCH)));

    expect(records).toEqual([
      {
        periodStart: "2026-08-20T02:00:00.000Z",
        model: "grok-4.6",
        inputTokens: 14224,
        // 33, not 61: reasoning_tokens breaks output down rather than adding
        // to it, so it is kept in its own field and left out of the total.
        outputTokens: 33,
        cachedInputTokens: 128,
        reasoningTokens: 28,
        requestCount: 1,
        promptCount: 0,
      },
    ]);
  });

  it("collapses events that share an hour and a model", () => {
    const [request] = parseGrokLogPayload(bytes(API_REQUEST_BATCH));
    const records = usageRecords([request, request]);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      inputTokens: 28448,
      outputTokens: 66,
      requestCount: 2,
    });
  });

  it("counts a user_prompt without counting it as a request", () => {
    const records = usageRecords(parseGrokLogPayload(bytes(USER_PROMPT_BATCH)));

    expect(records).toEqual([
      {
        periodStart: "2026-08-20T02:00:00.000Z",
        model: "grok-4.6",
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        reasoningTokens: 0,
        requestCount: 0,
        promptCount: 1,
      },
    ]);
  });

  it("ignores events that describe behaviour rather than spend", () => {
    const events = parseGrokLogPayload(bytes(API_REQUEST_BATCH));
    const turnCompleted = events.filter(
      (event) => event.name === "turn_completed",
    );

    expect(turnCompleted).toHaveLength(1);
    expect(usageRecords(turnCompleted)).toEqual([]);
  });
});

describe("parseGrokHookPayload", () => {
  it("reads the camelCase envelope Grok Build sends", () => {
    expect(
      parseGrokHookPayload({
        hookEventName: "session_start",
        runId: "RUN-abc123",
        sessionId: "01a01d0e-a1b5-7c31-9944-ee0ee42b0c9f",
        cwd: "/Users/me/hub-william",
        workspaceRoot: "/Users/me/hub-william",
      }),
    ).toEqual({
      runId: "RUN-abc123",
      sessionId: "01a01d0e-a1b5-7c31-9944-ee0ee42b0c9f",
      cwd: "/Users/me/hub-william",
    });
  });

  it("never carries prompt text or a transcript path through", () => {
    const parsed = parseGrokHookPayload({
      runId: "r",
      sessionId: "s",
      cwd: "/tmp/project",
      prompt: "<user_query>my secret</user_query>",
      transcriptPath: "/Users/me/.grok/sessions/x/updates.jsonl",
    });

    expect(Object.keys(parsed!)).toEqual(["runId", "sessionId", "cwd"]);
  });

  it("rejects an envelope missing any of the three fields", () => {
    expect(parseGrokHookPayload({ sessionId: "s", cwd: "/c" })).toBeNull();
    expect(parseGrokHookPayload({ runId: "r", cwd: "/c" })).toBeNull();
    expect(parseGrokHookPayload({ runId: "r", sessionId: "s" })).toBeNull();
    expect(parseGrokHookPayload(null)).toBeNull();
  });
});

describe("folderName", () => {
  it("keeps only the last segment of a path", () => {
    expect(folderName("/Users/me/code/hub-william")).toBe("hub-william");
    expect(folderName("/Users/me/code/hub-william/")).toBe("hub-william");
    expect(folderName("C:\\Users\\me\\hub-william")).toBe("hub-william");
    expect(folderName("/")).toBe("Unknown project");
  });
});

describe("hourStart", () => {
  it("floors to the hour in UTC", () => {
    expect(hourStart(new Date("2026-08-20T02:29:19.962Z"))).toBe(
      "2026-08-20T02:00:00.000Z",
    );
  });
});
