import { describe, expect, it } from "vitest";

import { decodeLogsRequest } from "./otlp-protobuf";

// Real ExportLogsServiceRequest bodies, captured off the wire from Grok Build
// 1.0.5 exporting to a local collector. Hand-built fixtures would only prove
// the decoder agrees with whatever the test author believed the encoder does.
//
// The account identifiers were replaced with same-length placeholders, so the
// framing is byte-for-byte what Grok sent while nobody's real user.id or
// team.id lives in the repository.
const API_REQUEST_BATCH =
  "CqAGCrsBChcKDXRlcm1pbmFsLnR5cGUSBgoET3JjYQoZCg5jbGllbnQudmVyc2lvbhIHCgUxLjAuNQoaCgxzZXJ2aWNlLm5hbWUSCgoIZ3Jvay1jbGkKIAoYZ3Jva19jb2RlLnNjaGVtYS52ZXJzaW9uEgQKAnYxChwKDmFwcC5lbnRyeXBvaW50EgoKCGhlYWRsZXNzCikKD3NlcnZpY2UudmVyc2lvbhIWChQxLjAuNSAoNTExNWI0NmJjOTA5KRLfBAoSChBhaS54YWkuZ3Jva19jb2RlEsMCCaAwqTOHYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgEMhMKBW1vZGVsEgoKCGdyb2stNC42MhIKC2R1cmF0aW9uX21zEgMYnRYyFQoLc3RvcF9yZWFzb24SBgoEc3RvcDITCgxpbnB1dF90b2tlbnMSAxiQbzITCg1vdXRwdXRfdG9rZW5zEgIYITIWChByZWFzb25pbmdfdG9rZW5zEgIYHDIYChFjYWNoZV9yZWFkX3Rva2VucxIDGIABMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWaAwqTOHYs0YYhVncm9rX2NvZGUuYXBpX3JlcXVlc3QSggIJqFXdNodizRgQCTIUCg5ldmVudC5zZXF1ZW5jZRICGAUyFgoHb3V0Y29tZRILCgljb21wbGV0ZWQyEgoLZHVyYXRpb25fbXMSAxjCFjIVCg90b29sX2NhbGxfY291bnQSAhgAMhMKBW1vZGVsEgoKCGdyb2stNC42MjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWahV3TaHYs0YYhhncm9rX2NvZGUudHVybl9jb21wbGV0ZWQ=";

const USER_PROMPT_BATCH =
  "CvAFCrsBChcKDXRlcm1pbmFsLnR5cGUSBgoET3JjYQoZCg5jbGllbnQudmVyc2lvbhIHCgUxLjAuNQoaCgxzZXJ2aWNlLm5hbWUSCgoIZ3Jvay1jbGkKIAoYZ3Jva19jb2RlLnNjaGVtYS52ZXJzaW9uEgQKAnYxChwKDmFwcC5lbnRyeXBvaW50EgoKCGhlYWRsZXNzCikKD3NlcnZpY2UudmVyc2lvbhIWChQxLjAuNSAoNTExNWI0NmJjOTA5KRKvBAoSChBhaS54YWkuZ3Jva19jb2RlEqkCCaAHSoWGYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgCMhUKBnN0YXR1cxILCgljb25uZWN0ZWQyGAoOdHJhbnNwb3J0X3R5cGUSBgoEaHR0cDISCgtkdXJhdGlvbl9tcxIDGOgIMhAKCnRvb2xfY291bnQSAhgcMh8KD21jcF9zZXJ2ZXIubmFtZRIMCgptY3Bfc2VydmVyMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWaAHSoWGYs0YYh9ncm9rX2NvZGUubWNwX3NlcnZlcl9jb25uZWN0aW9uEuwBCahVnoWGYs0YEAkyFAoOZXZlbnQuc2VxdWVuY2USAhgDMhMKDXByb21wdF9sZW5ndGgSAhgxMhMKBW1vZGVsEgoKCGdyb2stNC42MhkKC3NjcmVlbl9tb2RlEgoKCGhlYWRsZXNzMjEKB3VzZXIuaWQSJgokMTExMTExMTEtMTExMS00MTExLTgxMTEtMTExMTExMTExMTExMjEKB3RlYW0uaWQSJgokMjIyMjIyMjItMjIyMi00MjIyLTgyMjItMjIyMjIyMjIyMjIyWahVnoWGYs0YYhVncm9rX2NvZGUudXNlcl9wcm9tcHQ=";

function bytes(base64: string) {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
}

function attributes(entries: { key?: string; value?: unknown }[]) {
  return Object.fromEntries(
    entries.map((entry) => [
      entry.key,
      Object.values(entry.value as Record<string, unknown>)[0],
    ]),
  );
}

describe("decodeLogsRequest", () => {
  it("reads the resource the exporter identifies itself with", () => {
    const [group] = decodeLogsRequest(bytes(API_REQUEST_BATCH));

    expect(attributes(group.resourceAttributes)).toEqual({
      "terminal.type": "Orca",
      "client.version": "1.0.5",
      "service.name": "grok-cli",
      "grok_code.schema.version": "v1",
      "app.entrypoint": "headless",
      "service.version": "1.0.5 (5115b46bc909)",
    });
  });

  it("reads the event name from field 12 rather than the body", () => {
    const [group] = decodeLogsRequest(bytes(API_REQUEST_BATCH));

    expect(group.logRecords.map((record) => record.eventName)).toEqual([
      "grok_code.api_request",
      "grok_code.turn_completed",
    ]);
    // Grok Build leaves the body empty; the name lives only on the field.
    expect(group.logRecords[0].body).toBeUndefined();
  });

  it("reads the token counts an api_request carries", () => {
    const [group] = decodeLogsRequest(bytes(API_REQUEST_BATCH));
    const [request] = group.logRecords;

    expect(attributes(request.attributes)).toMatchObject({
      model: "grok-4.6",
      input_tokens: 14224,
      output_tokens: 33,
      reasoning_tokens: 28,
      cache_read_tokens: 128,
      stop_reason: "stop",
    });
  });

  it("keeps the nanosecond clock exact, as a string", () => {
    const [group] = decodeLogsRequest(bytes(API_REQUEST_BATCH));

    // 1787192959962788000 is past 2^53: read as a double it would come back
    // as ...787968, and it is also this record's deduplication key.
    expect(group.logRecords[0].timeUnixNano).toBe("1787192959962788000");
  });

  it("reads a user_prompt without ever seeing prompt text", () => {
    const [group] = decodeLogsRequest(bytes(USER_PROMPT_BATCH));
    const prompt = group.logRecords.find(
      (record) => record.eventName === "grok_code.user_prompt",
    );

    expect(attributes(prompt!.attributes)).toEqual({
      "event.sequence": 3,
      prompt_length: 49,
      model: "grok-4.6",
      screen_mode: "headless",
      "user.id": "11111111-1111-4111-8111-111111111111",
      "team.id": "22222222-2222-4222-8222-222222222222",
    });
    expect(Object.keys(attributes(prompt!.attributes))).not.toContain("prompt");
  });

  it("yields nothing for a payload that is not a logs request", () => {
    expect(decodeLogsRequest(new Uint8Array([1, 2, 3, 4]))).toEqual([]);
    expect(decodeLogsRequest(new Uint8Array())).toEqual([]);
  });
});
