// Parsing for the OTLP/HTTP JSON payloads Claude Code pushes at the hub.
//
// Only the logs signal is read. The metrics signal carries the same token
// counts, and its counters are cumulative unless the exporter is told
// otherwise, so ingesting both would either double count or require tracking
// the previous value of every series. The api_request log record is already
// one row per request, it carries the model and cost that metrics split across
// series, and it carries prompt.id, which metrics do not have at all.

// OTLP JSON encodes 64-bit integers as strings, so every numeric read below has
// to accept both forms rather than trusting the field's declared type.
interface AnyValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string | number;
  doubleValue?: number;
  arrayValue?: { values?: AnyValue[] };
  kvlistValue?: { values?: KeyValue[] };
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

export interface TelemetryEvent {
  name: string;
  occurredAt: Date;
  attributes: Map<string, AnyValue>;
}

export interface UsageRecord {
  periodStart: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  requestCount: number;
  costMicros: number;
}

export interface PromptAttribution {
  promptId: string;
  model: string;
  tokens: number;
  occurredAt: string;
}

// No prompt text, by construction rather than by configuration. The `prompt`
// attribute is never read out of the payload, so a project that turns
// OTEL_LOG_USER_PROMPTS on still contributes nothing but the facts below — and
// a secret pasted at the CLI has nowhere in this hub to land.
export interface PromptRecord {
  promptId: string;
  sessionId: string | null;
  occurredAt: string;
  promptLength: number;
  commandName: string | null;
  commandSource: string | null;
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

function attributeMap(...groups: (KeyValue[] | undefined)[]) {
  const merged = new Map<string, AnyValue>();

  for (const group of groups) {
    for (const entry of group ?? []) {
      if (entry.key && entry.value) {
        merged.set(entry.key, entry.value);
      }
    }
  }

  return merged;
}

function eventTime(record: LogRecord) {
  const nanos = record.timeUnixNano ?? record.observedTimeUnixNano;
  const parsed = Number(nanos ?? 0);

  // A record with no usable clock is dated on arrival rather than dropped: the
  // usage it carries is real even when the timestamp is not.
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return new Date();
  }

  return new Date(parsed / 1_000_000);
}

// Both "claude_code.api_request" and a bare "api_request" appear depending on
// whether the name arrives in the body or the event.name attribute.
function normalizeEventName(value: string | null) {
  if (!value) {
    return null;
  }

  return value.replace(/^claude_code\./, "");
}

export function parseLogPayload(payload: unknown): TelemetryEvent[] {
  const resourceLogs = (payload as { resourceLogs?: ResourceLogs[] })
    ?.resourceLogs;

  if (!Array.isArray(resourceLogs)) {
    return [];
  }

  const events: TelemetryEvent[] = [];

  for (const resourceLog of resourceLogs) {
    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        // Record attributes win over resource attributes: a per-event value is
        // always more specific than the process-wide default.
        const attributes = attributeMap(
          resourceLog.resource?.attributes,
          record.attributes,
        );
        const name =
          normalizeEventName(text(attributes.get("event.name"))) ??
          normalizeEventName(text(record.body));

        if (name) {
          events.push({ name, occurredAt: eventTime(record), attributes });
        }
      }
    }
  }

  return events;
}

// repo.name is set per project in .claude/settings.local.json. It is now the
// fallback rather than the source: a lifecycle hook reports the folder the
// session actually ran in, which needs no per-repository file and cannot go
// stale. Setups that predate the hook keep working through this attribute.
export function projectName(event: TelemetryEvent) {
  const name = text(event.attributes.get("repo.name"))?.trim();
  return name && name.length > 0 ? name.slice(0, 120) : unlabelledProject;
}

export function eventSessionId(event: TelemetryEvent) {
  return text(event.attributes.get("session.id"))?.trim() || null;
}

export function eventPromptId(event: TelemetryEvent) {
  return text(event.attributes.get("prompt.id"))?.trim() || null;
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

export interface ClaudeHookEvent {
  sessionId: string;
  cwd: string;
}

// Claude Code hands its hooks the session and the working directory as plain
// snake_case JSON. Nothing else is read: transcript_path points at the full
// conversation on disk and has no place in a usage hub.
export function parseClaudeHookPayload(
  payload: unknown,
): ClaudeHookEvent | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const event = payload as Record<string, unknown>;
  const sessionId =
    typeof event.session_id === "string" ? event.session_id.trim() : "";
  const cwd = typeof event.cwd === "string" ? event.cwd.trim() : "";

  if (!sessionId || !cwd) {
    return null;
  }

  return { sessionId, cwd };
}

export function accountEmail(event: TelemetryEvent) {
  return text(event.attributes.get("user.email"))?.trim() || null;
}

export function hourStart(occurredAt: Date) {
  const bucket = new Date(occurredAt);
  bucket.setUTCMinutes(0, 0, 0);
  return bucket.toISOString();
}

// The id Anthropic assigned the request, used to claim it exactly once.
// client_request_id is the fallback because it is generated locally and so
// survives a response that never arrived.
export function requestId(event: TelemetryEvent) {
  return (
    text(event.attributes.get("request_id"))?.trim() ||
    text(event.attributes.get("client_request_id"))?.trim() ||
    null
  );
}

function requestTokens(event: TelemetryEvent) {
  return {
    input: count(event.attributes.get("input_tokens")),
    output: count(event.attributes.get("output_tokens")),
    cached:
      count(event.attributes.get("cache_read_tokens")) +
      count(event.attributes.get("cache_creation_tokens")),
  };
}

// cost_usd_micros is preferred over cost_usd because it is an integer: summing
// fractional dollars across thousands of requests drifts, summing millionths
// does not.
function requestCostMicros(event: TelemetryEvent) {
  const micros = count(event.attributes.get("cost_usd_micros"));

  if (micros > 0) {
    return micros;
  }

  const dollars = Number(text(event.attributes.get("cost_usd")) ?? 0);
  return Number.isFinite(dollars) && dollars > 0
    ? Math.round(dollars * 1_000_000)
    : 0;
}

export function requestModel(event: TelemetryEvent) {
  return text(event.attributes.get("model"))?.trim() || "unknown";
}

// Requests in the same hour on the same model collapse into one row before any
// database call: a busy minute is dozens of api_request records that all target
// the identical bucket.
export function usageRecords(events: TelemetryEvent[]) {
  const grouped = new Map<string, UsageRecord>();

  for (const event of events) {
    if (event.name !== "api_request") {
      continue;
    }

    const periodStart = hourStart(event.occurredAt);
    const model = requestModel(event);
    const key = `${periodStart}::${model}`;
    const tokens = requestTokens(event);
    const existing = grouped.get(key);

    if (existing) {
      existing.inputTokens += tokens.input;
      existing.outputTokens += tokens.output;
      existing.cachedInputTokens += tokens.cached;
      existing.requestCount += 1;
      existing.costMicros += requestCostMicros(event);
      continue;
    }

    grouped.set(key, {
      periodStart,
      model,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cachedInputTokens: tokens.cached,
      requestCount: 1,
      costMicros: requestCostMicros(event),
    });
  }

  return [...grouped.values()];
}

// One prompt fans out into several api_request records, often across models.
// They are summed per model here so the database only has to compare totals.
export function promptAttributions(events: TelemetryEvent[]) {
  const grouped = new Map<string, PromptAttribution>();

  for (const event of events) {
    if (event.name !== "api_request") {
      continue;
    }

    const promptId = text(event.attributes.get("prompt.id"))?.trim();

    if (!promptId) {
      continue;
    }

    const model = requestModel(event);
    const key = `${promptId}::${model}`;
    const tokens = requestTokens(event);
    const total = tokens.input + tokens.output;
    const existing = grouped.get(key);

    if (existing) {
      existing.tokens += total;
      continue;
    }

    grouped.set(key, {
      promptId,
      model,
      tokens: total,
      occurredAt: event.occurredAt.toISOString(),
    });
  }

  return [...grouped.values()];
}

export function promptRecords(events: TelemetryEvent[]) {
  const records: PromptRecord[] = [];

  for (const event of events) {
    if (event.name !== "user_prompt") {
      continue;
    }

    const promptId = text(event.attributes.get("prompt.id"))?.trim();

    if (!promptId) {
      continue;
    }

    records.push({
      promptId,
      sessionId: text(event.attributes.get("session.id"))?.trim() || null,
      occurredAt: event.occurredAt.toISOString(),
      // prompt_length is reported even when the text is redacted, so how long a
      // prompt ran survives dropping what it said.
      promptLength: count(event.attributes.get("prompt_length")),
      commandName: text(event.attributes.get("command_name"))?.trim() || null,
      commandSource:
        text(event.attributes.get("command_source"))?.trim() || null,
    });
  }

  return records;
}

export const sessionWindowMs = 5 * 60 * 60 * 1_000;

// Claude Code's session window opens on the first request after a gap and runs
// five hours. Anthropic never reports the window, so it is reconstructed from
// the arrival times the hub already has, and the dashboard labels it estimated.
export function sessionWindowStart(
  events: TelemetryEvent[],
  previousStart: string | null,
  previousEventAt: string | null,
) {
  const times = events
    .map((event) => event.occurredAt.getTime())
    .sort((left, right) => left - right);

  if (times.length === 0) {
    return { startedAt: previousStart, lastEventAt: previousEventAt };
  }

  let startedAt = previousStart ? Date.parse(previousStart) : null;
  let lastEventAt = previousEventAt ? Date.parse(previousEventAt) : null;

  for (const time of times) {
    if (
      startedAt === null ||
      lastEventAt === null ||
      time - lastEventAt >= sessionWindowMs
    ) {
      startedAt = time;
    }

    lastEventAt = lastEventAt === null ? time : Math.max(lastEventAt, time);
  }

  return {
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    lastEventAt:
      lastEventAt === null ? null : new Date(lastEventAt).toISOString(),
  };
}
