// OTLP endpoint that a local Claude Code can be pointed at:
//
//   ~/.claude/settings.json
//   "env": {
//     "CLAUDE_CODE_ENABLE_TELEMETRY": "1",
//     "OTEL_LOGS_EXPORTER": "otlp",
//     "OTEL_EXPORTER_OTLP_PROTOCOL": "http/json",
//     "OTEL_EXPORTER_OTLP_ENDPOINT": "https://<ref>.supabase.co/functions/v1/claude-otel",
//     "OTEL_EXPORTER_OTLP_HEADERS": "Authorization=Bearer <hub gateway key>"
//   }
//
// Unlike Codex, nothing here polls: Claude Code pushes and the hub records what
// arrives. Usage lands on /v1/logs and a lifecycle hook reports the folder each
// session runs in to /hooks, so the settings above are the whole setup and no
// file is ever added to a repository.
//
// Which folders become projects is the owner's list in tracked_projects, not
// anything on disk. A folder that is not on it is discarded on arrival.
//
// No CORS: the caller is a CLI, not a browser.

import { serviceClient } from "../_shared/database.ts";
import { ProviderRequestError, publicError } from "../_shared/http.ts";
import {
  bearerToken,
  hashGatewayKey,
} from "../_shared/providers/codex-proxy.ts";
import {
  accountEmail,
  eventPromptId,
  eventSessionId,
  folderName,
  hourStart,
  parseClaudeHookPayload,
  parseLogPayload,
  projectName,
  promptAttributions,
  promptRecords,
  requestId,
  sessionWindowMs,
  sessionWindowStart,
  unlabelledProject,
  usageRecords,
  type TelemetryEvent,
} from "../_shared/providers/claude-telemetry.ts";

type ServiceClient = ReturnType<typeof serviceClient>;

interface ConnectionRow {
  id: string;
  display_name: string;
  email: string | null;
  metadata: Record<string, unknown>;
}

// Claude Code reports no plan, and nothing in the telemetry surface implies
// one. The badge is fixed rather than guessed per account.
const claudePlanType = "Pro+";

function otlpResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

async function requireOwner(client: ServiceClient, request: Request) {
  const token = bearerToken(request);

  if (!token) {
    throw new ProviderRequestError("A hub gateway key is required.", 401);
  }

  const { data, error } = await client.rpc("resolve_gateway_key", {
    p_key_hash: await hashGatewayKey(token),
  });

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ProviderRequestError("This gateway key is not valid.", 401);
  }

  return data as string;
}

// external_account_id carries repo.name, so the same checkout keeps the same
// card across restarts without the dashboard ever having to name it.
async function resolveConnection(
  client: ServiceClient,
  ownerId: string,
  project: string,
  email: string | null,
) {
  const { data: existing, error: readError } = await client
    .from("provider_connections")
    .select("id, display_name, email, metadata")
    .eq("owner_id", ownerId)
    .eq("provider", "anthropic")
    .eq("external_account_id", project)
    .maybeSingle();

  if (readError) {
    throw readError;
  }

  if (existing) {
    return existing as ConnectionRow;
  }

  const { data: created, error: insertError } = await client
    .from("provider_connections")
    .insert({
      owner_id: ownerId,
      provider: "anthropic",
      connection_method: "collector",
      status: "connected",
      display_name:
        project === unlabelledProject ? "Unlabelled project" : project,
      external_account_id: project,
      email,
      history_starts_at: new Date().toISOString(),
      capabilities: { cost: true, modelBreakdown: true, limits: false },
      metadata: { product: "claude_code", planType: claudePlanType },
    })
    .select("id, display_name, email, metadata")
    .single();

  if (insertError) {
    throw insertError;
  }

  return created as ConnectionRow;
}

// Drops api_request events this connection has already counted. Every usage
// write is an addition, so without this a retried export — the normal response
// to a timeout or a dropped acknowledgement — would inflate the totals. Prompt
// events need no such guard: they are upserted by prompt id.
async function claimRequests(
  client: ServiceClient,
  connectionId: string,
  events: TelemetryEvent[],
) {
  const claims = new Map<string, TelemetryEvent>();

  for (const event of events) {
    if (event.name !== "api_request") {
      continue;
    }

    const id = requestId(event);

    if (id) {
      claims.set(id, event);
    }
  }

  if (claims.size === 0) {
    return events;
  }

  const { data, error } = await client
    .from("claude_request_ids")
    .upsert(
      [...claims.keys()].map((id) => ({
        connection_id: connectionId,
        request_id: id,
      })),
      { onConflict: "connection_id,request_id", ignoreDuplicates: true },
    )
    .select("request_id");

  if (error) {
    throw error;
  }

  const accepted = new Set((data ?? []).map((row) => row.request_id as string));

  // An api_request that carries no id at all is kept: dropping it would lose
  // real usage to guard against a duplicate that may never arrive.
  return events.filter((event) => {
    if (event.name !== "api_request") {
      return true;
    }

    const id = requestId(event);
    return id === null || accepted.has(id);
  });
}

async function recordUsage(
  client: ServiceClient,
  connectionId: string,
  events: TelemetryEvent[],
) {
  for (const record of usageRecords(events)) {
    const { error } = await client.rpc("record_claude_usage", {
      p_connection_id: connectionId,
      p_period_start: record.periodStart,
      p_model: record.model,
      p_input_tokens: record.inputTokens,
      p_output_tokens: record.outputTokens,
      p_cached_input_tokens: record.cachedInputTokens,
      p_request_count: record.requestCount,
      p_cost_micros: record.costMicros,
    });

    if (error) {
      throw error;
    }
  }
}

async function recordPrompts(
  client: ServiceClient,
  connectionId: string,
  events: TelemetryEvent[],
) {
  for (const record of promptRecords(events)) {
    const { error } = await client.rpc("record_claude_prompt", {
      p_connection_id: connectionId,
      p_prompt_id: record.promptId,
      p_session_id: record.sessionId,
      p_occurred_at: record.occurredAt,
      p_prompt_length: record.promptLength,
      p_command_name: record.commandName,
      p_command_source: record.commandSource,
    });

    if (error) {
      throw error;
    }
  }

  for (const attribution of promptAttributions(events)) {
    const { error } = await client.rpc("attribute_claude_prompt_model", {
      p_connection_id: connectionId,
      p_prompt_id: attribution.promptId,
      p_occurred_at: attribution.occurredAt,
      p_model: attribution.model,
      p_tokens: attribution.tokens,
    });

    if (error) {
      throw error;
    }
  }
}

// The window is derived, never reported, so used is filled and limit_value is
// deliberately left null: a percentage would need a denominator Anthropic does
// not publish, and inventing one is worse than showing none.
async function recordSessionWindow(
  client: ServiceClient,
  connectionId: string,
  startedAt: string | null,
) {
  if (!startedAt) {
    return;
  }

  // Buckets are floored to the hour, so the window has to be floored too. A
  // window opening at 05:51 lives in the 05:00 bucket, and comparing against
  // 05:51 would skip that bucket and report the window as untouched.
  const { data, error: usageError } = await client
    .from("usage_buckets")
    .select("input_tokens, output_tokens")
    .eq("connection_id", connectionId)
    .gte("period_start", hourStart(new Date(startedAt)));

  if (usageError) {
    throw usageError;
  }

  const used = (data ?? []).reduce(
    (total, row) =>
      total + Number(row.input_tokens) + Number(row.output_tokens),
    0,
  );

  const { error } = await client.from("usage_limits").upsert(
    {
      connection_id: connectionId,
      metric_key: "session_5h",
      label: "5h limit",
      kind: "session",
      unit: "tokens",
      scope: "account",
      model: "all",
      window_name: "5h",
      used,
      limit_value: null,
      remaining: null,
      resets_at: new Date(
        Date.parse(startedAt) + sessionWindowMs,
      ).toISOString(),
      observed_at: new Date().toISOString(),
    },
    { onConflict: "connection_id,metric_key,model" },
  );

  if (error) {
    throw error;
  }
}

async function ingestProject(
  client: ServiceClient,
  ownerId: string,
  project: string,
  events: TelemetryEvent[],
) {
  // The owner's list, checked before anything is written: a folder they never
  // named produces no connection, no usage row, and no claim row.
  const { data: tracked, error: trackedError } = await client.rpc(
    "project_is_tracked",
    { p_owner_id: ownerId, p_folder_name: project },
  );

  if (trackedError) throw trackedError;
  if (tracked !== true) return;

  const email = events.map(accountEmail).find(Boolean) ?? null;
  const connection = await resolveConnection(client, ownerId, project, email);
  const metadata = connection.metadata ?? {};
  const window = sessionWindowStart(
    events,
    typeof metadata.sessionStartedAt === "string"
      ? metadata.sessionStartedAt
      : null,
    typeof metadata.lastEventAt === "string" ? metadata.lastEventAt : null,
  );

  const unseen = await claimRequests(client, connection.id, events);

  await recordUsage(client, connection.id, unseen);
  await recordPrompts(client, connection.id, unseen);
  await recordSessionWindow(client, connection.id, window.startedAt);

  const { error } = await client
    .from("provider_connections")
    .update({
      status: "connected",
      // The address only reaches the dashboard through metadata: display_name
      // has to stay the repository, or every card for this account would show
      // the same email instead of the project it is reporting for.
      email: null,
      metadata: {
        ...metadata,
        product: "claude_code",
        planType: claudePlanType,
        accountEmail: email ?? metadata.accountEmail ?? null,
        sessionStartedAt: window.startedAt,
        lastEventAt: window.lastEventAt,
      },
      last_synced_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", connection.id);

  if (error) {
    throw error;
  }
}

// Sessions the hook has already reported, for the ids present in this batch.
async function sessionFolders(
  client: ServiceClient,
  ownerId: string,
  sessionIds: string[],
) {
  if (sessionIds.length === 0) {
    return new Map<string, string>();
  }

  const { data, error } = await client
    .from("claude_sessions")
    .select("session_id, folder_name")
    .eq("owner_id", ownerId)
    .in("session_id", sessionIds);

  if (error) {
    throw error;
  }

  return new Map(
    (data ?? []).map((row) => [
      row.session_id as string,
      row.folder_name as string,
    ]),
  );
}

async function ingestLogs(
  client: ServiceClient,
  ownerId: string,
  payload: unknown,
) {
  const events = parseLogPayload(payload).filter(
    (event) => event.name === "api_request" || event.name === "user_prompt",
  );

  // A user_prompt carries both ids, so an api_request that reports only its
  // prompt still finds its session without a second round trip — as long as
  // both arrived in the same export.
  const sessionByPrompt = new Map<string, string>();

  for (const event of events) {
    const promptId = eventPromptId(event);
    const sessionId = eventSessionId(event);

    if (promptId && sessionId) {
      sessionByPrompt.set(promptId, sessionId);
    }
  }

  const resolveSession = (event: TelemetryEvent) => {
    const direct = eventSessionId(event);

    if (direct) {
      return direct;
    }

    const promptId = eventPromptId(event);
    return promptId ? (sessionByPrompt.get(promptId) ?? null) : null;
  };

  const folders = await sessionFolders(client, ownerId, [
    ...new Set(events.map(resolveSession).filter(Boolean)),
  ] as string[]);

  const byProject = new Map<string, TelemetryEvent[]>();

  for (const event of events) {
    const session = resolveSession(event);
    // The hook wins over repo.name: it reports where the session is running
    // now, while the attribute reports whatever a settings file last claimed.
    const project =
      (session ? folders.get(session) : undefined) ?? projectName(event);
    const bucket = byProject.get(project);

    if (bucket) {
      bucket.push(event);
      continue;
    }

    byProject.set(project, [event]);
  }

  for (const [project, projectEvents] of byProject) {
    await ingestProject(client, ownerId, project, projectEvents);
  }

  return { projects: byProject.size, events: events.length };
}

// The hook fires before the first request of a session, so the mapping is
// normally already there when usage arrives. Nothing is written for a folder
// the owner has not listed, which keeps the session table to real projects.
//
// If a mapping is ever missing when an export lands — the hub was unreachable
// for that one POST — the batch is discarded rather than parked, and only that
// batch. The hook runs again on the next prompt, so a session repairs itself
// within one turn.
async function ingestHook(
  client: ServiceClient,
  ownerId: string,
  payload: unknown,
) {
  const event = parseClaudeHookPayload(payload);

  if (!event) {
    throw new ProviderRequestError("Claude Code hook metadata is invalid.");
  }

  const folder = folderName(event.cwd);
  const { data: tracked, error: trackedError } = await client.rpc(
    "project_is_tracked",
    { p_owner_id: ownerId, p_folder_name: folder },
  );

  if (trackedError) throw trackedError;
  if (tracked !== true) return;

  const { error } = await client.from("claude_sessions").upsert(
    {
      owner_id: ownerId,
      session_id: event.sessionId,
      folder_name: folder,
      cwd: event.cwd,
      last_seen_at: new Date().toISOString(),
    },
    { onConflict: "owner_id,session_id" },
  );

  if (error) {
    throw error;
  }
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return otlpResponse({ error: "Only POST is accepted." }, 405);
  }

  const path = new URL(request.url).pathname;

  try {
    const client = serviceClient();
    const ownerId = await requireOwner(client, request);

    if (path.endsWith("/hooks")) {
      await ingestHook(client, ownerId, await request.json());
      return otlpResponse({});
    }

    // Metrics and traces are accepted and discarded rather than refused. The
    // exporters are enabled by the same settings block, and a 404 would put
    // them into a retry loop that says nothing useful about the logs pipeline.
    if (!path.endsWith("/v1/logs")) {
      return otlpResponse({});
    }

    await ingestLogs(client, ownerId, await request.json());

    return otlpResponse({});
  } catch (error) {
    const status = error instanceof ProviderRequestError ? error.status : 500;

    if (status >= 500) {
      console.error("claude-otel ingest failed", error);
    }

    return otlpResponse({ error: publicError(error) }, status);
  }
});
