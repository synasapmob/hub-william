// OTLP endpoint that a local Grok Build can be pointed at.
//
// Grok Build accepts only http/protobuf or grpc, and an unrecognized protocol
// disables its exporter silently, so unlike claude-otel this reads bytes rather
// than JSON. The decoder lives in _shared/providers/otlp-protobuf.ts.
//
// The endpoint is per launch rather than per user:
//
//   OTEL_EXPORTER_OTLP_ENDPOINT=https://<ref>.supabase.co/functions/v1/grok-otel/r/<run id>
//
// That run id is the whole reason project attribution works. Grok Build's
// api_request records carry no session id, so nothing in the payload says which
// folder spent the tokens; a lifecycle hook posts the same run id to /hooks
// together with its cwd, and grok_runs joins the two. Usage for a run the hook
// never announced is dropped rather than parked — the hook fires again on the
// next prompt, so a run repairs itself within one turn.
//
// Which folders become projects is the owner's list in tracked_projects, not
// anything on disk. A folder that is not on it produces no project and no row.
//
// No CORS: the caller is a CLI, not a browser.

import { serviceClient } from "../_shared/database.ts";
import { ProviderRequestError, publicError } from "../_shared/http.ts";
import {
  bearerToken,
  hashGatewayKey,
} from "../_shared/providers/codex-proxy.ts";
import {
  folderName,
  isCountedEvent,
  parseGrokHookPayload,
  parseGrokLogPayload,
  usageRecords,
  type GrokEvent,
} from "../_shared/providers/grok-telemetry.ts";

type ServiceClient = ReturnType<typeof serviceClient>;

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

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// The launch this batch belongs to, from the path the exporter was pointed at.
// OTLP appends /v1/logs to whatever base URL it is given, so the run id sits in
// the middle of the path rather than at the end.
function runIdFrom(pathname: string) {
  const match = /\/r\/([^/]+)/.exec(pathname);
  return match ? decodeURIComponent(match[1]).slice(0, 200) : null;
}

// Drops events this owner has already counted. Every usage write is an
// addition, so without this a retried export — the normal response to a
// timeout or a dropped acknowledgement — would inflate the totals.
async function claimEvents(
  client: ServiceClient,
  ownerId: string,
  runId: string,
  events: GrokEvent[],
) {
  const claims = new Map<string, GrokEvent>();

  for (const event of events) {
    if (!event.eventKey) {
      continue;
    }

    // Namespaced by run: two launches sharing a nanosecond is vanishingly
    // unlikely, but the key costs nothing to make unambiguous.
    claims.set(`${runId}:${event.eventKey}`, event);
  }

  if (claims.size === 0) {
    return [];
  }

  const { data, error } = await client
    .from("grok_usage_claims")
    .upsert(
      [...claims.keys()].map((key) => ({
        owner_id: ownerId,
        event_key: key,
      })),
      { onConflict: "owner_id,event_key", ignoreDuplicates: true },
    )
    .select("event_key");

  if (error) {
    throw error;
  }

  const accepted = new Set((data ?? []).map((row) => row.event_key as string));

  // An event with no clock at all is kept: dropping it would lose real usage to
  // guard against a duplicate that may never arrive.
  return events.filter(
    (event) => !event.eventKey || accepted.has(`${runId}:${event.eventKey}`),
  );
}

async function ingestLogs(
  client: ServiceClient,
  ownerId: string,
  runId: string | null,
  payload: Uint8Array,
) {
  // Without a run id the batch cannot be attributed to anything. It is accepted
  // and dropped rather than refused, because a non-2xx would put the exporter
  // into a retry loop over a batch that can never succeed.
  if (!runId) {
    console.warn("grok-otel received a batch with no run id in its path");
    return { recorded: 0 };
  }

  const events = parseGrokLogPayload(payload).filter(isCountedEvent);

  if (events.length === 0) {
    return { recorded: 0 };
  }

  const unseen = await claimEvents(client, ownerId, runId, events);
  let recorded = 0;

  for (const record of usageRecords(unseen)) {
    const { data, error } = await client.rpc("record_grok_project_usage", {
      p_owner_id: ownerId,
      p_run_id: runId,
      p_period_start: record.periodStart,
      p_model: record.model,
      p_input_tokens: record.inputTokens,
      p_output_tokens: record.outputTokens,
      p_cached_input_tokens: record.cachedInputTokens,
      p_reasoning_tokens: record.reasoningTokens,
      p_request_count: record.requestCount,
      p_prompt_count: record.promptCount,
    });

    if (error) {
      throw error;
    }

    if (data === true) {
      recorded += 1;
    }
  }

  return { recorded };
}

// The hook fires on SessionStart and again on every prompt, so the run is
// normally already mapped when the first batch of usage arrives.
async function ingestHook(
  client: ServiceClient,
  ownerId: string,
  payload: unknown,
) {
  const event = parseGrokHookPayload(payload);

  if (!event) {
    throw new ProviderRequestError("Grok Build hook metadata is invalid.");
  }

  const folder = folderName(event.cwd);

  // The owner's list, checked before anything is written: a folder they never
  // named produces no project, no run, and no usage.
  const { data: tracked, error: trackedError } = await client.rpc(
    "project_is_tracked",
    { p_owner_id: ownerId, p_folder_name: folder },
  );

  if (trackedError) throw trackedError;
  if (tracked !== true) return;

  const { error } = await client.rpc("record_grok_run", {
    p_owner_id: ownerId,
    p_run_id: event.runId,
    p_session_id: event.sessionId,
    // Do not make the local absolute path browser-readable. The private run
    // mapping retains cwd while this public identity is a digest, which also
    // keeps two checkouts of the same folder name as separate cards.
    p_project_key: await sha256(event.cwd),
    p_display_name: folder,
    p_cwd: event.cwd,
    p_observed_at: new Date().toISOString(),
  });

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

    // Metrics are accepted and discarded rather than refused. Grok Build's
    // quick-start enables both exporters against one base endpoint, and a 404
    // would put the metrics pipeline into a retry loop that says nothing useful
    // about the logs one. The same counts arrive on /v1/logs per request.
    if (!path.endsWith("/v1/logs")) {
      return otlpResponse({});
    }

    await ingestLogs(
      client,
      ownerId,
      runIdFrom(path),
      new Uint8Array(await request.arrayBuffer()),
    );

    return otlpResponse({});
  } catch (error) {
    const status = error instanceof ProviderRequestError ? error.status : 500;

    if (status >= 500) {
      console.error("grok-otel ingest failed", error);
    }

    return otlpResponse({ error: publicError(error) }, status);
  }
});
