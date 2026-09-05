// OpenAI-shaped endpoint that a local Codex CLI can be pointed at:
//
//   [model_providers.hub]
//   base_url = "https://<ref>.supabase.co/functions/v1/codex-gateway/v1"
//   env_key = "HUB_WILLIAM_KEY"
//   wire_api = "responses"
//
// Requests authenticate with a hub gateway key and are forwarded to whichever
// of the owner's connected ChatGPT accounts still has quota, so a turn that
// would 429 on one account continues on the next.
//
// No CORS: the caller is a CLI, not a browser, and the streaming path cannot
// use http.ts's jsonResponse helpers.

import {
  readCredential,
  serviceClient,
  storeCredential,
} from "../_shared/database.ts";
import { ProviderRequestError, publicError } from "../_shared/http.ts";
import type { CodexOAuthCredential } from "../_shared/provider-types.ts";
import {
  activeCodexCredential,
  CodexReauthRequiredError,
  refreshCodexCredential,
} from "../_shared/providers/codex-auth.ts";
import {
  bearerToken,
  CODEX_MODELS_URL,
  CODEX_RESPONSES_URL,
  codexConnections,
  downstreamHeaders,
  type GatewayConnection,
  hashGatewayKey,
  intersectModels,
  isFailoverError,
  recordRateLimits,
  selectConnection,
  stripEncryptedReasoning,
  syncPlanType,
  upstreamHeaders,
} from "../_shared/providers/codex-proxy.ts";

type ServiceClient = ReturnType<typeof serviceClient>;

// Bounded so a provider returning 429 for a reason unrelated to quota cannot
// walk the whole account list on every request.
const MAX_ATTEMPTS = 4;

// What a pool that answered 401 all the way down is told. OpenAI's own words —
// "Encountered invalidated oauth token for user" — name no account and offer no
// remedy, which leaves the owner re-checking a gateway key that was never the
// problem.
const RECONNECT_MESSAGE =
  "Every connected Codex account was rejected by OpenAI. Reconnect them in the hub.";

function errorResponse(status: number, message: string) {
  return new Response(
    JSON.stringify({ error: { message, type: "hub_gateway_error" } }),
    {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
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

// A refresh must be persisted the moment it succeeds: OpenAI invalidates the
// presented refresh token on rotation, so a later failure in this request
// would otherwise strand the connection with a dead credential.
async function readActiveCredential(
  client: ServiceClient,
  connectionId: string,
) {
  const stored = await readCredential(client, connectionId);

  if (stored.type !== "codex_oauth") {
    throw new ProviderRequestError(
      "Provider authorization type is invalid.",
      409,
    );
  }

  const active = await activeCodexCredential(stored);

  if (active !== stored) {
    await storeCredential(client, connectionId, active);
  }

  return active as CodexOAuthCredential;
}

// OpenAI repudiates an access token as soon as the same ChatGPT account signs
// in somewhere else, so a token that is still unexpired by the stored clock can
// already be dead upstream — it answers 401 "invalidated oauth token" rather
// than anything about expiry. A Codex token is issued for ten days, so waiting
// for the recorded expiry leaves the account broken for a week. The 401 itself
// is the only signal, which makes this the refresh trigger the clock cannot be.
//
// Returns null when the account cannot be recovered without the owner, having
// already retired it from the pool so the next turn does not try it again.
async function renewCredential(
  client: ServiceClient,
  connection: GatewayConnection,
  credential: CodexOAuthCredential,
) {
  try {
    const refreshed = await refreshCodexCredential(credential);
    // Persisted before the retry, not after: OpenAI invalidates the presented
    // refresh token on rotation, so a failure in between would strand the
    // connection with a credential nobody holds.
    await storeCredential(client, connection.id, refreshed);

    return refreshed;
  } catch (error) {
    if (error instanceof CodexReauthRequiredError) {
      // Two turns that hit 401 together present the same refresh token, and
      // OpenAI answers the loser with refresh_token_reused — the same verdict a
      // genuinely dead account gives. What separates them is that the winner
      // has already written its replacement, so the stored row is the tiebreak.
      // Without this, ordinary concurrency retires a healthy account.
      const stored = await rereadCredential(client, connection.id);

      if (stored && stored.refreshToken !== credential.refreshToken) {
        return stored;
      }

      await retireConnection(client, connection, error.message);
    } else {
      // A refresh endpoint that is merely unreachable says nothing about the
      // account, so the connection keeps its status and the pool moves on.
      console.error(
        `Gateway could not refresh ${connection.display_name}`,
        publicError(error),
      );
    }

    return null;
  }
}

// Deliberately not readActiveCredential: this runs while deciding whether a
// refresh failed, and that one can start a second refresh of its own.
async function rereadCredential(client: ServiceClient, connectionId: string) {
  try {
    const stored = await readCredential(client, connectionId);

    return stored.type === "codex_oauth" ? stored : null;
  } catch {
    return null;
  }
}

// A connection whose refresh token is gone can only be fixed by reconnecting,
// so it leaves the pool and says why. Left as 'connected' it would be selected
// on every turn, fail, and show the dashboard a healthy account.
async function retireConnection(
  client: ServiceClient,
  connection: GatewayConnection,
  reason: string,
) {
  const { error } = await client
    .from("provider_connections")
    .update({ status: "needs_attention", last_error: reason })
    .eq("id", connection.id);

  if (error) {
    console.error(
      `Gateway could not retire ${connection.display_name}`,
      publicError(error),
    );
  }
}

async function handleModels(client: ServiceClient, request: Request, url: URL) {
  const ownerId = await requireOwner(client, request);
  const connections = await codexConnections(client, ownerId);

  if (connections.length === 0) {
    throw new ProviderRequestError("No Codex account is connected.", 503);
  }

  // Codex speaks its own model protocol even to a custom provider, and the
  // backend rejects the call without client_version.
  const clientVersion = url.searchParams.get("client_version") ?? "0.146.0";
  const modelsUrl = `${CODEX_MODELS_URL}?client_version=${encodeURIComponent(clientVersion)}`;

  // Asked of every account, not just the first: the answer has to describe the
  // pool, because any of them may end up serving a turn.
  const payloads = await Promise.all(
    connections.map(async (connection) => {
      try {
        const credential = await readActiveCredential(client, connection.id);
        const list = (active: CodexOAuthCredential) => {
          const headers = upstreamHeaders(request, active);
          headers.set("Accept", "application/json");

          return fetch(modelsUrl, { headers });
        };

        let upstream = await list(credential);

        // Codex asks for the model list once per session, so recovering the
        // credential here is what keeps a whole session off the failure path.
        if (upstream.status === 401) {
          await upstream.body?.cancel();
          const renewed = await renewCredential(client, connection, credential);

          if (renewed) {
            upstream = await list(renewed);
          }
        }

        return upstream.ok ? await upstream.json() : null;
      } catch (error) {
        console.error(
          `Gateway could not list models for ${connection.display_name}`,
          publicError(error),
        );
        return null;
      }
    }),
  );

  const models = intersectModels(payloads.filter(Boolean));

  if (!models) {
    throw new ProviderRequestError("No Codex account could list models.", 502);
  }

  return new Response(JSON.stringify(models), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

// Quota moves with every turn, so it is recorded before the caller decides
// anything — including for the 429 that is about to send the turn to the next
// account. The plan rides on the same headers, so a downgrade to free retires
// the account from the pool on first contact instead of on the next sync.
async function sendTurn(
  client: ServiceClient,
  connection: GatewayConnection,
  credential: CodexOAuthCredential,
  request: Request,
  body: string,
) {
  const upstream = await fetch(CODEX_RESPONSES_URL, {
    method: "POST",
    headers: upstreamHeaders(request, credential),
    body,
  });

  try {
    await Promise.all([
      recordRateLimits(client, connection.id, upstream.headers),
      syncPlanType(client, connection, upstream.headers),
    ]);
  } catch (error) {
    console.error("Gateway could not record account state", publicError(error));
  }

  return upstream;
}

async function handleResponses(client: ServiceClient, request: Request) {
  const ownerId = await requireOwner(client, request);
  // Read once and forward the bytes untouched on the happy path; parsing a 69KB
  // body on every turn buys nothing when only a failover needs to rewrite it.
  const rawBody = await request.text();

  const attempted = new Set<string>();
  let strippedBody: string | null = null;
  // Held so an exhausted retry loop reports what upstream actually said.
  // Claiming "out of quota" after four accounts rejected the model for an
  // unrelated reason would send the user hunting the wrong problem.
  let lastFailure: {
    status: number;
    body: string;
    contentType: string;
  } | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const { connection, total, freeExcluded } = await selectConnection(
      client,
      ownerId,
      attempted,
    );

    if (!connection) {
      // Checked before the empty-pool case, because a pool that emptied by
      // retiring its accounts mid-request is not a hub nobody connected to.
      if (lastFailure?.status === 401) {
        return errorResponse(401, RECONNECT_MESSAGE);
      }

      if (total === 0) {
        // A free plan gets a monthly window and a reduced model list, so it is
        // skipped rather than routed to. Say which case this is.
        return errorResponse(
          503,
          freeExcluded > 0
            ? `No paid Codex account is connected to this hub (${freeExcluded} free ${freeExcluded === 1 ? "account is" : "accounts are"} skipped).`
            : "No Codex account is connected to this hub.",
        );
      }

      if (lastFailure) {
        return new Response(lastFailure.body, {
          status: lastFailure.status,
          headers: {
            "Content-Type": lastFailure.contentType,
            "Cache-Control": "no-store",
          },
        });
      }

      // Say so plainly rather than dressing an exhausted pool up as an
      // upstream failure — every account really is out of quota.
      return errorResponse(
        429,
        `All ${total} paid Codex ${total === 1 ? "account is" : "accounts are"} out of quota.`,
      );
    }

    attempted.add(connection.id);

    const credential = await readActiveCredential(client, connection.id);
    const isRetry = attempted.size > 1;
    const body = isRetry
      ? (strippedBody ??= stripEncryptedReasoning(rawBody))
      : rawBody;

    let upstream = await sendTurn(
      client,
      connection,
      credential,
      request,
      body,
    );
    // Held across the refresh so the original rejection is still reportable if
    // the account turns out to be unrecoverable.
    let failureBody: string | null = null;

    // Retried on the same account rather than handed to the next one: a 401 is
    // about this credential, and spending another account's 69KB prefix on a
    // problem a refresh fixes would cost the turn its reasoning chain.
    if (upstream.status === 401) {
      failureBody = await upstream.text();
      const renewed = await renewCredential(client, connection, credential);

      if (renewed) {
        upstream = await sendTurn(client, connection, renewed, request, body);
        failureBody = null;
      }
    }

    if (!upstream.ok) {
      failureBody ??= await upstream.text();
      const contentType =
        upstream.headers.get("content-type") ?? "application/json";

      if (isFailoverError(upstream.status, failureBody)) {
        lastFailure = {
          status: upstream.status,
          body: failureBody,
          contentType,
        };
        console.warn(
          `Gateway account ${connection.display_name} returned ${upstream.status}, failing over`,
        );
        continue;
      }

      // A request the backend considers malformed will be malformed for every
      // account, so surface it instead of burning the pool rediscovering that.
      return new Response(failureBody, {
        status: upstream.status,
        headers: { "Content-Type": contentType, "Cache-Control": "no-store" },
      });
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: downstreamHeaders(upstream),
    });
  }

  if (lastFailure) {
    if (lastFailure.status === 401) {
      return errorResponse(401, RECONNECT_MESSAGE);
    }

    return new Response(lastFailure.body, {
      status: lastFailure.status,
      headers: {
        "Content-Type": lastFailure.contentType,
        "Cache-Control": "no-store",
      },
    });
  }

  return errorResponse(429, "Every Codex account returned a rate limit.");
}

Deno.serve(async (request) => {
  const url = new URL(request.url);
  // Supabase serves this at /functions/v1/codex-gateway/..., so the provider's
  // own /v1 prefix lands as a suffix and only the tail is meaningful.
  const path = url.pathname;

  try {
    const client = serviceClient();

    if (request.method === "GET" && path.endsWith("/models")) {
      return await handleModels(client, request, url);
    }

    if (request.method === "POST" && path.endsWith("/responses")) {
      return await handleResponses(client, request);
    }

    return errorResponse(404, "Unsupported gateway route.");
  } catch (error) {
    console.error("Gateway request failed", publicError(error));
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return errorResponse(status, publicError(error));
  }
});
