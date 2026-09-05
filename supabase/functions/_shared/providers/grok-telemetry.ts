// Parsing for the OTLP/protobuf payloads Grok Build pushes at the hub.
//
// The shape of the problem differs from Claude Code's in one way that decides
// most of this file. Grok Build's usage-bearing records carry no session id:
// grok_code.api_request has model and token counts and nothing that says which
// session, prompt, or folder produced them. session.id appears only on
// grok_code.session_start and grok_code.model_switched, and setting
// OTEL_METRICS_INCLUDE_SESSION_ID does not change that.
//
// So the correlation is carried outside the payload. The exporter is pointed at
// a per-launch URL — .../grok-otel/r/<run id>/v1/logs — and a lifecycle hook
// reports that same run id along with the folder the session is running in.
// The run id in the path is what joins tokens to a project; nothing in the
// telemetry itself can.
//
// Only the logs signal is read. The metrics signal carries the same counts
// split across series, with no per-request granularity and no better identity.

import { decodeLogsRequest, type AnyValue } from "./otlp-protobuf.ts";

export interface GrokEvent {
  name: string;
  occurredAt: Date;
  // The nanosecond clock, kept exact and used to claim a record once. Grok
  // Build assigns no request id, so there is nothing else stable to dedupe on,
  // and OTLP exporters retry any batch they do not see acknowledged.
  eventKey: string;
  attributes: Map<string, AnyValue>;
}

// One row per hour and model, the shape agent_project_usage stores. Requests
// and prompts aggregate together because both are keyed the same way and a
// single write per bucket beats one per event.
//
// No prompt text, by construction. Grok Build gates prompt content behind
// OTEL_LOG_USER_PROMPTS and the hub never reads the attribute either way, so
// turning that gate on in a project changes nothing that reaches the database.
export interface GrokUsageRecord {
  periodStart: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  requestCount: number;
  promptCount: number;
}

export interface GrokHookEvent {
  runId: string;
  sessionId: string;
  cwd: string;
}

export const unlabelledProject = "__unlabelled__";

function text(value: AnyValue | undefined) {
  if (value?.stringValue !== undefined) {
    return value.stringValue;
  }

  if (value?.intValue !== undefined) {
    return String(value.intValue);
  }

  if (value?.doubleValue !== undefined) {
    return String(value.doubleValue);
  }

  if (value?.boolValue !== undefined) {
    return String(value.boolValue);
  }

  return null;
}

function count(value: AnyValue | undefined) {
  const raw = text(value);

  if (raw === null) {
    return 0;
  }

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

// Every event name is prefixed in the stream; the hub matches on the bare name
// so a rename of the namespace does not silently drop every record.
function normalizeEventName(value: string | null) {
  if (!value) {
    return null;
  }

  return value.replace(/^grok_code\./, "");
}

function eventTime(timeUnixNano: string | null) {
  const parsed = Number(timeUnixNano ?? 0);

  // A record with no usable clock is dated on arrival rather than dropped: the
  // usage it carries is real even when the timestamp is not.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date();
  }

  return new Date(parsed / 1_000_000);
}

export function parseGrokLogPayload(bytes: Uint8Array): GrokEvent[] {
  const events: GrokEvent[] = [];

  for (const group of decodeLogsRequest(bytes)) {
    for (const record of group.logRecords) {
      // Record attributes win over resource attributes: a per-event value is
      // always more specific than the process-wide default.
      const attributes = new Map<string, AnyValue>();

      for (const entry of [...group.resourceAttributes, ...record.attributes]) {
        if (entry.key && entry.value) {
          attributes.set(entry.key, entry.value);
        }
      }

      const name = normalizeEventName(record.eventName);

      if (!name) {
        continue;
      }

      const clock = record.timeUnixNano ?? record.observedTimeUnixNano;

      events.push({
        name,
        occurredAt: eventTime(clock),
        eventKey: clock ?? "",
        attributes,
      });
    }
  }

  return events;
}

// The folder is the last segment of the path, and only that segment is stored:
// an absolute path names the machine's owner and often their client.
export function folderName(cwd: string) {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");

  return (
    normalized.split("/").filter(Boolean).at(-1)?.slice(0, 120) ||
    "Unknown project"
  );
}

// Grok Build hands its hooks camelCase JSON, unlike Claude Code's snake_case.
// Nothing else is read: the same payload carries the full prompt text and a
// transcriptPath pointing at the conversation on disk, and neither has any
// place in a usage hub.
export function parseGrokHookPayload(payload: unknown): GrokHookEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const event = payload as Record<string, unknown>;
  const runId = typeof event.runId === "string" ? event.runId.trim() : "";
  const sessionId =
    typeof event.sessionId === "string" ? event.sessionId.trim() : "";
  const cwd = typeof event.cwd === "string" ? event.cwd.trim() : "";

  if (!runId || !sessionId || !cwd) {
    return null;
  }

  return { runId, sessionId, cwd };
}

export function hourStart(occurredAt: Date) {
  const bucket = new Date(occurredAt);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString();
}

export function requestModel(event: GrokEvent) {
  return text(event.attributes.get("model"))?.trim() || "unknown";
}

// reasoning_tokens is stored in its own column but deliberately not added to
// the total. Grok Build reports it alongside output_tokens as a breakdown of
// them, not as a separate charge: a one-word answer reported 33 output tokens
// and 28 reasoning tokens, which only holds if the reasoning is counted inside
// the output. Summing the two would inflate every reasoning-model turn.
function requestTokens(event: GrokEvent) {
  return {
    input: count(event.attributes.get("input_tokens")),
    output: count(event.attributes.get("output_tokens")),
    cached: count(event.attributes.get("cache_read_tokens")),
    reasoning: count(event.attributes.get("reasoning_tokens")),
  };
}

// The two events the hub counts. Anything else in the stream — tool calls,
// MCP connections, compactions — describes behaviour rather than spend.
export function isCountedEvent(event: GrokEvent) {
  return event.name === "api_request" || event.name === "user_prompt";
}

function emptyRecord(periodStart: string, model: string): GrokUsageRecord {
  return {
    periodStart,
    model,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    requestCount: 0,
    promptCount: 0,
  };
}

// Events in the same hour on the same model collapse into one row before any
// database call: a busy minute is dozens of api_request records that all target
// the identical bucket.
export function usageRecords(events: GrokEvent[]) {
  const grouped = new Map<string, GrokUsageRecord>();

  for (const event of events) {
    if (!isCountedEvent(event)) {
      continue;
    }

    const periodStart = hourStart(event.occurredAt);
    const model = requestModel(event);
    const key = `${periodStart}::${model}`;
    const record = grouped.get(key) ?? emptyRecord(periodStart, model);

    if (event.name === "user_prompt") {
      record.promptCount += 1;
    } else {
      const tokens = requestTokens(event);
      record.inputTokens += tokens.input;
      record.outputTokens += tokens.output;
      record.cachedInputTokens += tokens.cached;
      record.reasoningTokens += tokens.reasoning;
      record.requestCount += 1;
    }

    grouped.set(key, record);
  }

  return [...grouped.values()];
}
