// Minimal OTLP/HTTP JSON parser for the log events emitted by Codex. Prompt
// bodies, tool arguments, tool results, and output snippets are deliberately
// never copied out of the payload: this module exposes only usage metadata.

interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
}

interface KeyValue {
  key?: string;
  value?: AnyValue;
}

interface LogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  body?: AnyValue;
  attributes?: KeyValue[];
}

interface ResourceLogs {
  resource?: { attributes?: KeyValue[] };
  scopeLogs?: { logRecords?: LogRecord[] }[];
}

export interface CodexUsageEvent {
  eventKey: string;
  sessionId: string;
  occurredAt: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
}

export interface CodexHookEvent {
  sessionId: string;
  cwd: string;
  model: string | null;
  promptKey: string | null;
  promptDelta: number;
}

function text(value: AnyValue | undefined) {
  if (value?.stringValue !== undefined) return value.stringValue;
  if (value?.intValue !== undefined) return String(value.intValue);
  if (value?.doubleValue !== undefined) return String(value.doubleValue);
  if (value?.boolValue !== undefined) return String(value.boolValue);
  return null;
}

function count(value: AnyValue | undefined) {
  const parsed = Number(text(value) ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function attributes(...groups: (KeyValue[] | undefined)[]) {
  const result = new Map<string, AnyValue>();

  for (const group of groups) {
    for (const entry of group ?? []) {
      if (entry.key && entry.value) result.set(entry.key, entry.value);
    }
  }

  return result;
}

function valueFor(map: Map<string, AnyValue>, ...keys: string[]) {
  for (const key of keys) {
    const value = text(map.get(key))?.trim();
    if (value) return value;
  }

  return null;
}

function countFor(map: Map<string, AnyValue>, ...keys: string[]) {
  for (const key of keys) {
    if (map.has(key)) return count(map.get(key));
  }

  return 0;
}

function occurredAt(value: string) {
  const nanos = Number(value);

  if (Number.isFinite(nanos) && nanos > 0) {
    return new Date(nanos / 1_000_000);
  }

  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? new Date() : timestamp;
}

function usableClock(value: string | number | undefined) {
  if (value === undefined) return null;

  const clock = String(value).trim();
  if (!clock) return null;

  // Codex currently serializes an unset OTLP record clock as "0". Treating
  // that as Unix nanoseconds produces 1970 (and an hourStart near 2000 in some
  // JS runtimes) instead of falling back to the valid event timestamp.
  const numeric = Number(clock);
  return Number.isFinite(numeric) && numeric <= 0 ? null : clock;
}

export function hourStart(date: Date) {
  const result = new Date(date);
  result.setUTCMinutes(0, 0, 0);
  return result.toISOString();
}

export function parseCodexLogPayload(payload: unknown): CodexUsageEvent[] {
  const resourceLogs = (payload as { resourceLogs?: ResourceLogs[] })
    ?.resourceLogs;

  if (!Array.isArray(resourceLogs)) return [];

  const events: CodexUsageEvent[] = [];

  for (const resourceLog of resourceLogs) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const fields = attributes(
          resourceLog.resource?.attributes,
          record.attributes,
        );
        const name =
          valueFor(fields, "event.name") ?? text(record.body)?.trim() ?? null;
        const kind = valueFor(fields, "event.kind", "kind");

        // Token fields exist only on the response.completed SSE event. Reading
        // any broader event class would count the same request several times.
        if (name !== "codex.sse_event" || kind !== "response.completed") {
          continue;
        }

        const sessionId = valueFor(fields, "conversation.id", "session.id");

        if (!sessionId) continue;

        // Codex also emits event.timestamp as RFC 3339. OTLP normally adds a
        // nanosecond record clock, but the event field remains a stable retry
        // key when an intermediary strips that clock.
        const rawTime =
          usableClock(record.timeUnixNano) ??
          usableClock(valueFor(fields, "event.timestamp") ?? undefined) ??
          usableClock(record.observedTimeUnixNano) ??
          String(Date.now() * 1e6);
        const model = valueFor(fields, "model", "server_model") ?? "unknown";
        const inputTokens = countFor(
          fields,
          "input_token_count",
          "input_tokens",
        );
        const outputTokens = countFor(
          fields,
          "output_token_count",
          "output_tokens",
        );
        const cachedInputTokens = countFor(
          fields,
          "cached_token_count",
          "cached_input_tokens",
        );
        const reasoningTokens = countFor(
          fields,
          "reasoning_token_count",
          "reasoning_output_tokens",
        );

        // Some Codex transports emit a metadata-only response.completed record
        // beside the record containing the actual usage. It is useful for raw
        // observability, but counting it here would double the request total.
        if (
          inputTokens === 0 &&
          outputTokens === 0 &&
          cachedInputTokens === 0 &&
          reasoningTokens === 0
        ) {
          continue;
        }

        // Timestamp has nanosecond precision in OTLP and makes the key stable
        // across exporter retries. Counts make the fallback distinct even for
        // collectors that replace or omit that clock.
        const eventKey = [
          "response",
          sessionId,
          rawTime,
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
        ].join(":");

        events.push({
          eventKey,
          sessionId,
          occurredAt: occurredAt(rawTime),
          model,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          reasoningTokens,
        });
      }
    }
  }

  return events;
}

export function parseCodexHookPayload(payload: unknown): CodexHookEvent | null {
  if (!payload || typeof payload !== "object") return null;

  const event = payload as Record<string, unknown>;
  // The marker is the Hub script's signature and the version of this payload
  // shape. It no longer decides what is collected — the owner's allowlist does
  // — so the same script now serves a single user-level hook for every repo.
  if (event.project_opt_in !== "hub-william-v1") return null;

  const sessionId =
    typeof event.session_id === "string" ? event.session_id.trim() : "";
  const cwd = typeof event.cwd === "string" ? event.cwd.trim() : "";
  const hookName =
    typeof event.hook_event_name === "string" ? event.hook_event_name : "";
  const model =
    typeof event.model === "string" && event.model.trim()
      ? event.model.trim()
      : null;
  const turnId =
    typeof event.turn_id === "string" && event.turn_id.trim()
      ? event.turn_id.trim()
      : null;

  if (!sessionId || !cwd) return null;

  return {
    sessionId,
    cwd,
    model,
    promptKey: hookName === "UserPromptSubmit" ? turnId : null,
    promptDelta: hookName === "UserPromptSubmit" && turnId ? 1 : 0,
  };
}
