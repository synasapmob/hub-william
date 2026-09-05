// Routing and payload handling for the Codex gateway: a local Codex CLI points
// at the hub, and the hub forwards each turn to one of the owner's connected
// ChatGPT accounts.
//
// Verified against codex-cli 0.146.0 by capturing a real request and replaying
// it upstream (see the spike notes on tasks 1-2). Everything here follows from
// three facts that capture established:
//
//   - The backend gates on originator + a matching User-Agent, and the CLI
//     sends codex_exec or codex_cli_rs depending on how it was invoked, so the
//     pair has to be rewritten rather than passed through.
//   - Requests carry include: ["reasoning.encrypted_content"], and those blobs
//     are decryptable only by the account that issued them. Moving a live
//     conversation to another account means stripping them first.
//   - A 69KB prefix rides on every turn, so an account switch is expensive.
//     Selection is deterministic: newest last_synced_at, then newest
//     created_at, preferring accounts still under 95%.
//
// Nothing here touches Deno or Supabase APIs directly; the entry point owns
// that, so this module survives a move to another host.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import type {
  CodexOAuthCredential,
  UsageLimitInput,
} from "../provider-types.ts";
import { windowLabel } from "./codex.ts";

const CHATGPT_BASE = "https://chatgpt.com/backend-api";
const CODEX_UA = "codex_cli_rs/0.146.0";
const CODEX_ORIGINATOR = "codex_cli_rs";

export const CODEX_RESPONSES_URL = `${CHATGPT_BASE}/codex/responses`;
export const CODEX_MODELS_URL = `${CHATGPT_BASE}/codex/models`;

// Switch before the hard 429 rather than on it. Hitting the wall mid-turn
// forces a swap while a tool loop is in flight, which costs the reasoning
// chain; crossing 95 almost always lands on a turn boundary instead.
const USAGE_THRESHOLD = 95;

export interface GatewayConnection {
  id: string;
  created_at: string;
  last_synced_at: string | null;
  display_name: string;
  planType: string | null;
  metadata: Record<string, unknown>;
}

// A free ChatGPT account is not a smaller paid account: it gets a monthly
// window instead of a weekly one and refuses the models the paid tiers serve,
// so routing a turn to one produces an error rather than a slower answer.
// Only a plan explicitly reported as free is excluded — an account whose plan
// is not yet known stays in the pool, because emptying the pool over missing
// metadata is worse than one failover.
export function isFreePlan(planType: string | null) {
  return planType?.trim().toLowerCase() === "free";
}

interface StoredLimit {
  connection_id: string;
  used: number | null;
  resets_at: string | null;
}

export function generateGatewayKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const encoded = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

  return `hw_sk_${encoded}`;
}

// What the dashboard shows in place of a key it can never see again. Both ends
// come from the key itself so the row is recognisable to whoever holds it,
// while the 8 revealed characters leave the 43-character random tail with far
// more entropy than anything could search.
export function gatewayKeyHint(key: string) {
  return `${key.slice(0, 10)}…${key.slice(-4)}`;
}

export async function hashGatewayKey(plaintext: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(plaintext),
  );

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function bearerToken(request: Request) {
  const authorization = request.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "").trim();

  return token && token.length > 0 ? token : null;
}

// Newest last_synced_at, then newest created_at. A dashboard or scheduled
// sync moves that account to the front; a gateway turn does not write
// last_synced_at. The in-memory sort is the source of truth so never-synced
// rows (null) always lose to any timestamp, regardless of PostgREST nulls.
async function allCodexConnections(
  client: SupabaseClient,
  ownerId: string,
): Promise<GatewayConnection[]> {
  const { data, error } = await client
    .from("provider_connections")
    .select("id, created_at, last_synced_at, display_name, metadata")
    .eq("owner_id", ownerId)
    .eq("provider", "openai")
    .eq("status", "connected")
    .order("last_synced_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => {
      const metadata = (row.metadata as Record<string, unknown> | null) ?? {};
      const planType = metadata.planType;
      const lastSyncedAt = row.last_synced_at;

      return {
        id: row.id as string,
        created_at: row.created_at as string,
        last_synced_at: typeof lastSyncedAt === "string" ? lastSyncedAt : null,
        display_name: row.display_name as string,
        planType: typeof planType === "string" ? planType : null,
        metadata,
      };
    })
    .filter((connection) => connection.metadata.product === "codex");
}

export async function codexConnections(
  client: SupabaseClient,
  ownerId: string,
) {
  const all = await allCodexConnections(client, ownerId);

  return all.filter((connection) => !isFreePlan(connection.planType));
}

// Every proxied response reports the plan, so a downgrade is caught on first
// contact instead of waiting for the next provider-sync. Written only when it
// actually changed, which on a stable account means never.
export async function syncPlanType(
  client: SupabaseClient,
  connection: GatewayConnection,
  headers: Headers,
) {
  const reported = headers.get("x-codex-plan-type")?.trim();

  if (!reported || reported === connection.planType) return;

  const { error } = await client
    .from("provider_connections")
    .update({ metadata: { ...connection.metadata, planType: reported } })
    .eq("id", connection.id);

  if (error) {
    throw error;
  }
}

async function storedLimits(client: SupabaseClient, connectionIds: string[]) {
  if (connectionIds.length === 0) return new Map<string, StoredLimit[]>();

  const { data, error } = await client
    .from("usage_limits")
    .select("connection_id, used, resets_at")
    .in("connection_id", connectionIds)
    .like("metric_key", "codex:%");

  if (error) {
    throw error;
  }

  const byConnection = new Map<string, StoredLimit[]>();

  for (const row of (data ?? []) as StoredLimit[]) {
    const existing = byConnection.get(row.connection_id) ?? [];
    existing.push(row);
    byConnection.set(row.connection_id, existing);
  }

  return byConnection;
}

// A window whose reset has already passed is available regardless of the
// percentage stored against it: the number describes a window that has since
// rolled over, and treating it as current would retire a healthy account.
function hasHeadroom(limits: StoredLimit[] | undefined) {
  if (!limits || limits.length === 0) return true;

  const now = Date.now();

  return limits.every((limit) => {
    if (limit.resets_at && new Date(limit.resets_at).getTime() <= now) {
      return true;
    }

    return (limit.used ?? 0) < USAGE_THRESHOLD;
  });
}

function lastSyncedMs(connection: GatewayConnection) {
  if (!connection.last_synced_at) return Number.NEGATIVE_INFINITY;

  const ms = Date.parse(connection.last_synced_at);

  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

function createdMs(connection: GatewayConnection) {
  const ms = Date.parse(connection.created_at);

  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function orderGatewayConnections(connections: GatewayConnection[]) {
  return [...connections].sort((left, right) => {
    const synced = lastSyncedMs(right) - lastSyncedMs(left);

    if (synced !== 0) return synced;

    return createdMs(right) - createdMs(left);
  });
}

// Walks newest-sync / newest-connect first. Under 95% is a preference on that
// list, not a wall: if every paid account is past it, the newest one still
// gets the turn so remaining quota is spent. A 429 still fails over.
export function chooseGatewayConnection(
  available: GatewayConnection[],
  limits: Map<string, StoredLimit[]>,
) {
  if (available.length === 0) return null;

  const ordered = orderGatewayConnections(available);

  return (
    ordered.find((connection) => hasHeadroom(limits.get(connection.id))) ??
    ordered[0]
  );
}

export async function selectConnection(
  client: SupabaseClient,
  ownerId: string,
  exclude: Set<string>,
) {
  const all = await allCodexConnections(client, ownerId);
  const eligible = all.filter((connection) => !isFreePlan(connection.planType));
  // Reported separately so an owner whose only accounts are free is told that,
  // rather than being told nothing is connected.
  const freeExcluded = all.length - eligible.length;
  const available = eligible.filter(
    (connection) => !exclude.has(connection.id),
  );

  if (available.length === 0) {
    return { connection: null, total: eligible.length, freeExcluded };
  }

  const limits = await storedLimits(
    client,
    available.map((connection) => connection.id),
  );

  return {
    connection: chooseGatewayConnection(available, limits),
    total: eligible.length,
    freeExcluded,
  };
}

// Only these move from the caller to upstream. Authorization and Host are
// replaced, and everything else the CLI sends is either irrelevant to the
// backend or actively wrong once the request changes origin.
function isForwardableHeader(name: string) {
  return (
    name.startsWith("x-codex-") ||
    name.startsWith("x-openai-") ||
    name === "session-id" ||
    name === "thread-id" ||
    name === "x-client-request-id"
  );
}

export function upstreamHeaders(
  request: Request,
  credential: CodexOAuthCredential,
) {
  const headers = new Headers();

  for (const [name, value] of request.headers) {
    if (isForwardableHeader(name.toLowerCase())) {
      headers.set(name, value);
    }
  }

  headers.set("Authorization", `Bearer ${credential.accessToken}`);
  headers.set("Content-Type", "application/json");
  headers.set("Accept", "text/event-stream");
  // The CLI's own value is invocation-dependent (codex_exec vs codex_cli_rs);
  // the backend only accepts the pair below, and the replay spike confirmed a
  // rewritten originator is accepted.
  headers.set("originator", CODEX_ORIGINATOR);
  headers.set("User-Agent", CODEX_UA);

  if (credential.chatgptAccountId) {
    headers.set("ChatGPT-Account-ID", credential.chatgptAccountId);
  }

  return headers;
}

// Account B cannot decrypt account A's reasoning blobs, so a failover has to
// drop them. The turn loses its prior reasoning chain but survives; keeping
// them would make the retry fail with a 400 every time.
export function stripEncryptedReasoning(rawBody: string) {
  let payload: Record<string, unknown>;

  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return rawBody;
  }

  if (!Array.isArray(payload.input)) return rawBody;

  payload.input = payload.input
    .map((item) => {
      const record = item as Record<string, unknown>;
      if (record?.type !== "reasoning") return item;

      const { encrypted_content: _dropped, ...rest } = record;
      return rest;
    })
    // A reasoning item that carried nothing but the encrypted blob has no
    // meaning once it is gone.
    .filter((item) => {
      const record = item as Record<string, unknown>;
      if (record?.type !== "reasoning") return true;

      return Array.isArray(record.summary) && record.summary.length > 0;
    });

  if (Array.isArray(payload.include)) {
    payload.include = payload.include.filter(
      (entry) => entry !== "reasoning.encrypted_content",
    );
  }

  return JSON.stringify(payload);
}

function headerNumber(headers: Headers, name: string) {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

// The response to every proxied turn carries the account's current quota, so
// selection never has to wait for the next provider-sync run. Written with the
// same metric_key shape collectLimits() uses in codex.ts, so both writers land
// on the same rows instead of duplicating them.
export function limitsFromHeaders(headers: Headers): UsageLimitInput[] {
  const limits: UsageLimitInput[] = [];

  for (const kind of ["primary", "secondary"] as const) {
    const usedPercent = headerNumber(headers, `x-codex-${kind}-used-percent`);
    const windowMinutes = headerNumber(
      headers,
      `x-codex-${kind}-window-minutes`,
    );

    // An absent window is not a window at 0% — on a weekly-primary account the
    // secondary is reported as zeroes and must not be stored as a real limit.
    if (usedPercent === null || !windowMinutes) continue;

    const resetAt = headerNumber(headers, `x-codex-${kind}-reset-at`);
    const resetAfter = headerNumber(
      headers,
      `x-codex-${kind}-reset-after-seconds`,
    );
    const resetsAt = resetAt
      ? new Date(resetAt * 1_000).toISOString()
      : resetAfter
        ? new Date(Date.now() + resetAfter * 1_000).toISOString()
        : null;

    const clamped = Math.min(Math.max(usedPercent, 0), 100);
    const windowSeconds = windowMinutes * 60;

    limits.push({
      metric_key: `codex:codex:${kind}`,
      label: windowLabel(windowSeconds),
      kind: "quota",
      unit: "percent",
      scope: "account",
      model: "all",
      window: `${windowMinutes} minutes`,
      used: clamped,
      limit_value: 100,
      remaining: Math.max(0, 100 - clamped),
      resets_at: resetsAt,
    });
  }

  return limits;
}

export async function recordRateLimits(
  client: SupabaseClient,
  connectionId: string,
  headers: Headers,
) {
  const limits = limitsFromHeaders(headers);
  if (limits.length === 0) return;

  // Upsert only. persistSyncResult() deletes stale limit rows because it writes
  // the complete set; this writes two of them and must leave the rest alone.
  const { error } = await client.from("usage_limits").upsert(
    limits.map((limit) => {
      const { window, ...stored } = limit;

      return {
        ...stored,
        window_name: window,
        connection_id: connectionId,
        observed_at: new Date().toISOString(),
      };
    }),
    { onConflict: "connection_id,metric_key,model" },
  );

  if (error) {
    throw error;
  }
}

// Quota is not the only reason an account cannot serve a turn. A pool assembled
// from different ChatGPT plans is heterogeneous: an account on another tier
// answers 400 "model is not supported when using Codex with a ChatGPT account",
// and a credential that died since the last sync answers 401/403. All three
// mean "ask someone else", as opposed to a 400 from a genuinely bad request,
// which every account would reject identically.
export function isFailoverError(status: number, body: string) {
  if (status === 429) return true;
  if (status === 401 || status === 403) return true;

  return (
    status === 400 &&
    /not supported when using codex with a chatgpt account/i.test(body)
  );
}

interface ModelEntry {
  slug?: unknown;
}

// Codex picks a model from this list once per session and then uses it for
// every turn, while routing can land on any account in the pool. Offering the
// union would guarantee that some turns pick a model their account rejects, so
// the list is narrowed to what every account can actually serve.
export function intersectModels(payloads: unknown[]) {
  const lists = payloads
    .map((payload) => (payload as { models?: unknown })?.models)
    .filter((models): models is ModelEntry[] => Array.isArray(models));

  if (lists.length === 0) return null;

  const shared = lists
    .slice(1)
    .reduce<Set<string>>(
      (carry, list) =>
        new Set(
          list
            .map((model) => model.slug)
            .filter(
              (slug): slug is string =>
                typeof slug === "string" && carry.has(slug),
            ),
        ),
      new Set(
        lists[0]
          .map((model) => model.slug)
          .filter((slug): slug is string => typeof slug === "string"),
      ),
    );

  const models = lists[0].filter(
    (model) => typeof model.slug === "string" && shared.has(model.slug),
  );

  // An empty intersection would leave Codex with nothing to choose; one
  // account's list at least starts a session, and failover covers the rest.
  return models.length > 0 ? { models } : { models: lists[0] };
}

// Codex surfaces quota in its own UI from these, so the caller should see the
// figures for whichever account actually served the turn.
export function downstreamHeaders(upstream: Response) {
  const headers = new Headers({
    "Content-Type": upstream.headers.get("content-type") ?? "text/event-stream",
    "Cache-Control": "no-store",
  });

  for (const [name, value] of upstream.headers) {
    if (name.toLowerCase().startsWith("x-codex-")) {
      headers.set(name, value);
    }
  }

  return headers;
}
