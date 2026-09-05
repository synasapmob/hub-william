// Codex sends usage logs to /v1/logs and a tiny local lifecycle hook sends
// cwd/session attribution to /hooks. Both authenticate with the same one-time
// Hub gateway key used by codex-gateway.

import { serviceClient } from "../_shared/database.ts";
import { ProviderRequestError, publicError } from "../_shared/http.ts";
import {
  hourStart,
  parseCodexHookPayload,
  parseCodexLogPayload,
} from "../_shared/providers/codex-telemetry.ts";
import {
  bearerToken,
  hashGatewayKey,
} from "../_shared/providers/codex-proxy.ts";

type ServiceClient = ReturnType<typeof serviceClient>;

function response(body: Record<string, unknown>, status = 200) {
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

  if (error) throw error;
  if (!data)
    throw new ProviderRequestError("This gateway key is not valid.", 401);
  return data as string;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function projectName(cwd: string) {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  return (
    normalized.split("/").filter(Boolean).at(-1)?.slice(0, 120) ||
    "Unknown project"
  );
}

async function ingestHook(
  client: ServiceClient,
  ownerId: string,
  payload: unknown,
) {
  const event = parseCodexHookPayload(payload);

  if (!event) {
    throw new ProviderRequestError("Codex hook metadata is invalid.");
  }

  const projectKey = await sha256(event.cwd);

  // What used to be decided by a project-local hooks.json is now the owner's
  // list. The hook can therefore live once in ~/.codex/hooks.json and report
  // every repository; only listed folders get a session here, and usage for an
  // unmapped session is dropped by record_codex_project_usage.
  const { data: tracked, error: trackedError } = await client.rpc(
    "project_is_tracked",
    { p_owner_id: ownerId, p_folder_name: projectName(event.cwd) },
  );

  if (trackedError) throw trackedError;
  if (tracked !== true) return;

  const { error } = await client.rpc("record_codex_session", {
    p_owner_id: ownerId,
    p_session_id: event.sessionId,
    // Do not make the local absolute path browser-readable. The private
    // session mapping retains cwd while this public identity is a digest.
    p_project_key: projectKey,
    p_display_name: projectName(event.cwd),
    p_cwd: event.cwd,
    p_model: event.model,
    p_prompt_key: event.promptKey,
    p_prompt_delta: event.promptDelta,
    p_observed_at: new Date().toISOString(),
  });

  if (error) throw error;
}

async function ingestLogs(
  client: ServiceClient,
  ownerId: string,
  payload: unknown,
) {
  const events = parseCodexLogPayload(payload);
  let recorded = 0;

  for (const event of events) {
    const { data, error } = await client.rpc("record_codex_project_usage", {
      p_owner_id: ownerId,
      p_session_id: event.sessionId,
      p_event_key: event.eventKey,
      p_period_start: hourStart(event.occurredAt),
      p_model: event.model,
      p_input_tokens: event.inputTokens,
      p_output_tokens: event.outputTokens,
      p_cached_input_tokens: event.cachedInputTokens,
      p_reasoning_tokens: event.reasoningTokens,
    });

    if (error) throw error;
    if (data === true) recorded += 1;
  }

  return { accepted: events.length, recorded };
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return response({ error: "Only POST is accepted." }, 405);
  }

  try {
    const client = serviceClient();
    const ownerId = await requireOwner(client, request);
    const path = new URL(request.url).pathname;
    const payload = await request.json();

    if (path.endsWith("/hooks")) {
      await ingestHook(client, ownerId, payload);
      return response({});
    }

    if (path.endsWith("/v1/logs")) {
      await ingestLogs(client, ownerId, payload);
      return response({});
    }

    // Metrics/traces may share a collector base in client configuration. An
    // empty success prevents useless retries; the app counts logs only.
    return response({});
  } catch (error) {
    const status = error instanceof ProviderRequestError ? error.status : 500;
    if (status >= 500) console.error("codex-otel ingest failed", error);
    return response({ error: publicError(error) }, status);
  }
});
