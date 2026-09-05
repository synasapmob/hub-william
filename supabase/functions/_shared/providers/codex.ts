// Reads quota, resets and token activity for a ChatGPT-subscription Codex
// account. Three undocumented GETs, all pollable without sending a model
// request (verified against codex-cli 0.146.0, which reaches the same paths
// through `codex app-server`):
//
//   GET /backend-api/wham/usage                    quota windows + plan + credits
//   GET /backend-api/wham/rate-limit-reset-credits available/earned reset credits
//   GET /backend-api/wham/profiles/me              lifetime + daily token buckets
//
// Field names have already moved once upstream (used_percent vs percent_used,
// reset_at vs resets_at), so every read goes through a tolerant accessor and a
// missing field degrades to null rather than failing the sync.

import type {
  CodexOAuthCredential,
  ProviderConnectionRow,
  ProviderResetCreditsInput,
  ProviderSyncResult,
  ProviderUsageSummaryInput,
  UsageBucketInput,
  UsageLimitInput,
} from "../provider-types.ts";
import { ProviderRequestError } from "../http.ts";
import { activeCodexCredential, refreshCodexCredential } from "./codex-auth.ts";

const CHATGPT_BASE = "https://chatgpt.com/backend-api";
const CODEX_UA = "codex_cli_rs/0.146.0";

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function firstNumber(source: Json | null, ...keys: string[]) {
  if (!source) return null;

  for (const key of keys) {
    const raw = source[key];
    // Number(null) is 0 and Number("") is 0, so an explicit null would
    // otherwise be stored as a real zero and hide that the field is absent.
    if (raw === null || raw === undefined || raw === "") continue;

    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }

  return null;
}

// bigint/integer columns reject fractional input; the API has returned
// fractional percentages before, so never hand a float to the database.
function wholeOrNull(value: number | null) {
  return value === null ? null : Math.round(value);
}

function firstString(source: Json | null, ...keys: string[]) {
  if (!source) return null;

  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return null;
}

async function codexGet(path: string, credential: CodexOAuthCredential) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    "User-Agent": CODEX_UA,
    originator: "codex_cli_rs",
    "OpenAI-Beta": "codex-1",
  };
  if (credential.chatgptAccountId) {
    headers["ChatGPT-Account-ID"] = credential.chatgptAccountId;
  }

  const response = await fetch(`${CHATGPT_BASE}${path}`, { headers });

  if (!response.ok) {
    // Only /wham/usage is essential; the other two degrade to null so a single
    // renamed endpoint cannot take the whole dashboard down.
    return { ok: false as const, status: response.status, body: null };
  }

  return {
    ok: true as const,
    status: response.status,
    body: (await response.json()) as Json,
  };
}

// Codex derives window labels from duration rather than hardcoding primary=5h;
// this account's primary window is weekly, so the same must hold here.
// Exported so the gateway labels the limits it writes back from response
// headers identically to the ones this sync writes.
export function windowLabel(seconds: number | null) {
  if (!seconds) return "Usage limit";

  const minutes = Math.round(seconds / 60);
  const named: Array<[number, string]> = [
    [300, "5h limit"],
    [1440, "Daily limit"],
    [10080, "Weekly limit"],
    [43200, "Monthly limit"],
  ];

  for (const [target, label] of named) {
    if (Math.abs(minutes - target) <= target * 0.05) return label;
  }

  if (minutes < 60) return `${minutes}m limit`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h limit`;
  return `${Math.round(minutes / 1440)}d limit`;
}

function windowToLimit(
  window: unknown,
  limitId: string,
  kind: "primary" | "secondary",
): UsageLimitInput | null {
  const record = asRecord(window);
  if (!record) return null;

  const usedPercent = firstNumber(record, "used_percent", "percent_used");
  if (usedPercent === null) return null;

  const windowSeconds = firstNumber(
    record,
    "limit_window_seconds",
    "window_seconds",
  );
  const resetAtSeconds = firstNumber(record, "reset_at", "resets_at");
  const resetAfterSeconds = firstNumber(
    record,
    "reset_after_seconds",
    "resets_in_seconds",
  );

  const resetsAt = resetAtSeconds
    ? new Date(resetAtSeconds * 1_000).toISOString()
    : resetAfterSeconds
      ? new Date(Date.now() + resetAfterSeconds * 1_000).toISOString()
      : null;

  const clamped = Math.min(Math.max(usedPercent, 0), 100);

  return {
    metric_key: `codex:${limitId}:${kind}`,
    label: windowLabel(windowSeconds),
    kind: "quota",
    unit: "percent",
    scope: "account",
    model: "all",
    window: windowSeconds ? `${Math.round(windowSeconds / 60)} minutes` : kind,
    used: clamped,
    limit_value: 100,
    remaining: Math.max(0, 100 - clamped),
    resets_at: resetsAt,
  };
}

function collectLimits(usage: Json | null): UsageLimitInput[] {
  if (!usage) return [];

  const limits: UsageLimitInput[] = [];
  const seen = new Set<string>();

  const push = (limit: UsageLimitInput | null) => {
    if (!limit || seen.has(limit.metric_key)) return;
    seen.add(limit.metric_key);
    limits.push(limit);
  };

  const addSnapshot = (snapshot: unknown, limitId: string) => {
    const record = asRecord(snapshot);
    if (!record) return;

    push(
      windowToLimit(
        record.primary_window ?? record.primary,
        limitId,
        "primary",
      ),
    );
    push(
      windowToLimit(
        record.secondary_window ?? record.secondary,
        limitId,
        "secondary",
      ),
    );
  };

  addSnapshot(usage.rate_limit ?? usage.rate_limits, "codex");

  const byLimitId = asRecord(usage.rate_limits_by_limit_id);
  if (byLimitId) {
    for (const [limitId, snapshot] of Object.entries(byLimitId)) {
      addSnapshot(snapshot, limitId);
    }
  }

  addSnapshot(
    usage.code_review_rate_limit ?? usage.review_rate_limit,
    "review",
  );

  const additional = usage.additional_rate_limits;
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const record = asRecord(entry);
      if (!record) continue;

      const limitId =
        firstString(record, "limit_name", "metered_feature", "id") ?? "other";
      addSnapshot(record.rate_limit ?? record, limitId);
    }
  }

  return limits;
}

function collectSummary(
  profile: Json | null,
): ProviderUsageSummaryInput | undefined {
  const stats = asRecord(profile?.stats);
  if (!stats) return undefined;

  return {
    lifetime_tokens: wholeOrNull(firstNumber(stats, "lifetime_tokens")),
    peak_daily_tokens: wholeOrNull(firstNumber(stats, "peak_daily_tokens")),
    longest_running_turn_seconds: wholeOrNull(
      firstNumber(stats, "longest_running_turn_sec"),
    ),
    current_streak_days: wholeOrNull(firstNumber(stats, "current_streak_days")),
    longest_streak_days: wholeOrNull(firstNumber(stats, "longest_streak_days")),
  };
}

function collectDailyBuckets(profile: Json | null): UsageBucketInput[] {
  const stats = asRecord(profile?.stats);
  const buckets = stats?.daily_usage_buckets;
  if (!Array.isArray(buckets)) return [];

  const byDate = new Map<string, UsageBucketInput>();

  for (const entry of buckets) {
    const record = asRecord(entry);
    const startDate = firstString(record, "start_date");
    const tokens = firstNumber(record, "tokens");

    if (!startDate || tokens === null) continue;

    const start = new Date(`${startDate}T00:00:00.000Z`);
    if (Number.isNaN(start.getTime())) continue;

    const end = new Date(start.getTime() + 24 * 60 * 60 * 1_000);

    byDate.set(startDate, {
      period_start: start.toISOString(),
      period_end: end.toISOString(),
      model: "all",
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      request_count: 0,
      total_tokens: Math.max(0, Math.round(tokens)),
      source_key: "codex:account-usage",
    });
  }

  return [...byDate.values()];
}

function collectResetCredits(
  credits: Json | null,
): ProviderResetCreditsInput | undefined {
  if (!credits) return undefined;

  const available = firstNumber(credits, "available_count") ?? 0;
  const earned = firstNumber(credits, "total_earned_count");
  const list = Array.isArray(credits.credits) ? credits.credits : [];

  return {
    available_count: Math.max(0, Math.round(available)),
    // Earned is what makes "2 of 3" meaningful; without it, fall back to
    // available so the ratio is never smaller than the numerator.
    total_earned_count: Math.max(
      Math.max(0, Math.round(earned ?? 0)),
      Math.max(0, Math.round(available)),
    ),
    credits: list,
  };
}

export async function syncCodex(
  _connection: ProviderConnectionRow,
  credential: CodexOAuthCredential,
  // Called the instant a refresh succeeds. OpenAI invalidates the presented
  // refresh token on rotation, so deferring persistence to the end of the sync
  // means one failed GET permanently strands the connection.
  persistCredential?: (credential: CodexOAuthCredential) => Promise<void>,
): Promise<ProviderSyncResult> {
  const snapshot = (active: CodexOAuthCredential) =>
    Promise.all([
      codexGet("/wham/usage", active),
      codexGet("/wham/rate-limit-reset-credits", active),
      codexGet("/wham/profiles/me", active),
    ]);

  let active = await activeCodexCredential(credential);
  let refreshed = active !== credential;

  if (refreshed && persistCredential) {
    await persistCredential(active);
  }

  let [usageResponse, creditsResponse, profileResponse] =
    await snapshot(active);

  // The recorded expiry is not the only thing that ends an access token:
  // OpenAI repudiates the whole session when the same ChatGPT account signs in
  // elsewhere, and the credential then looks current here while answering 401
  // there. As long as the refresh token itself survives that, a refresh is the
  // whole remedy — so it is worth one before telling the owner to reconnect.
  if (usageResponse.status === 401 || usageResponse.status === 403) {
    // Throws CodexReauthRequiredError when the refresh token died too, which
    // is the one case that genuinely needs the owner.
    active = await refreshCodexCredential(active);
    refreshed = true;

    if (persistCredential) {
      await persistCredential(active);
    }

    [usageResponse, creditsResponse, profileResponse] = await snapshot(active);
  }

  if (!usageResponse.ok) {
    // ProviderRequestError rather than Error: publicError() only forwards the
    // former, and "rejected by Codex even after a refresh" is worth saying on
    // the card instead of the generic failure text.
    throw new ProviderRequestError(
      usageResponse.status === 401 || usageResponse.status === 403
        ? "Codex rejected this account even after refreshing its sign-in."
        : "Codex usage is temporarily unavailable.",
      usageResponse.status,
    );
  }

  const usage = usageResponse.body;
  const limits = collectLimits(usage);
  const rateLimit = asRecord(usage.rate_limit);
  // The connection names itself from the authenticated account. Fall back to
  // the profile username when the usage payload omits the email.
  const email = firstString(usage, "email");
  const username = firstString(
    asRecord(profileResponse.body?.profile),
    "username",
    "display_name",
  );
  const accountName = email ?? username ?? undefined;

  return {
    usage: collectDailyBuckets(profileResponse.body),
    costs: [],
    limits,
    capabilities: {
      usage: true,
      cost: false,
      limits: limits.length > 0,
      resets: limits.some((limit) => limit.resets_at !== null),
      modelBreakdown: false,
      tokenBreakdown: false,
    },
    identity: {
      externalAccountId: firstString(usage, "account_id") ?? undefined,
      email: email ?? undefined,
      displayName: accountName,
      workspaceName: accountName,
    },
    summary: collectSummary(profileResponse.body),
    resetCredits: collectResetCredits(creditsResponse.body),
    metadata: {
      product: "codex",
      planType: firstString(usage, "plan_type"),
      limitReached: rateLimit?.limit_reached === true,
      rateLimitReachedType:
        firstString(asRecord(usage.rate_limit_reached_type), "type") ?? null,
    },
    // Gate on whether a refresh actually ran, not on accessToken equality:
    // a rotation that returns the same access token but a new refresh token
    // must still be persisted.
    updatedCredential: refreshed && !persistCredential ? active : undefined,
  };
}
