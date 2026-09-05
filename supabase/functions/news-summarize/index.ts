import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  requireAdmin,
  requireApprovedUser,
  serviceClient,
} from "../_shared/database.ts";
import {
  jsonResponse,
  optionsResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import { extractArticle } from "../_shared/article.ts";
import { decayedHotness } from "../_shared/news-rank.ts";
import {
  summarize,
  summarizeTrend,
  summaryConfig,
  type SummaryConfig,
} from "../_shared/summarizer.ts";

// Bumped whenever the prompt changes, and stored next to every summary, so a
// prompt revision can be found and re-run rather than silently coexisting with
// output from the version before it.
const SUMMARY_PROMPT_VERSION = "summary-2026-08-25-v1";

// Its own version, because a trend summary answers a different question from an
// article summary and the two must be re-runnable independently.
const TREND_PROMPT_VERSION = "trend-2026-08-27-v1";

// One run is bounded by the Edge Function's wall clock, not by the budget.
const MAX_ITEMS_PER_RUN = 12;
// Matches the feed, so anything a reader can see is something the batch can
// still explain.
const CANDIDATE_WINDOW_HOURS = 24 * 7;

interface CandidateRow {
  id: string;
  url: string;
  title: string;
  hotness: number | string;
  half_life_hours: number | string;
  effective_at: string;
  summary_status: string;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Summarization failed.";
}

async function candidates(client: SupabaseClient) {
  const since = new Date(
    Date.now() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const { data, error } = await client
    .from("news_items")
    .select(
      "id, url, title, hotness, half_life_hours, effective_at, summary_status",
    )
    .in("summary_status", ["pending", "extracted"])
    .gte("effective_at", since)
    .limit(300);
  if (error) throw error;

  const now = new Date();
  // The stored hotness is time-independent, so ordering has to apply the decay
  // here rather than trusting the raw column.
  return ((data ?? []) as CandidateRow[])
    .map((row) => ({
      row,
      score: decayedHotness(
        Number(row.hotness),
        new Date(row.effective_at),
        Number(row.half_life_hours),
        now,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_ITEMS_PER_RUN)
    .map((entry) => entry.row);
}

/**
 * One story, asked for by the page showing it. Unlike the scheduled batch this
 * ignores summary_status entirely — a reader pressing the button on a story
 * whose extraction failed last night means "try again", not "skip it".
 */
async function candidate(client: SupabaseClient, itemId: string) {
  const { data, error } = await client
    .from("news_items")
    .select(
      "id, url, title, hotness, half_life_hours, effective_at, summary_status",
    )
    .eq("id", itemId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderRequestError("That story was not found.", 404);
  return data as CandidateRow;
}

async function processItem(
  client: SupabaseClient,
  item: CandidateRow,
  config: SummaryConfig | null,
) {
  let text: string;
  try {
    const article = await extractArticle(item.url);
    text = article.text;
    const { error } = await client.rpc("store_news_article_text", {
      p_item_id: item.id,
      p_extracted_text: text,
    });
    if (error) throw error;
  } catch (error) {
    await client
      .from("news_items")
      .update({
        summary_status: "failed",
        summary_error: errorMessage(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    return "failed" as const;
  }

  // No key configured is a deliberate, supported state, not a failure. The item
  // is left extracted, which is exactly what the admin paste form picks up.
  if (!config) {
    await client
      .from("news_items")
      .update({
        summary_status: "extracted",
        summary_error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    return "extracted" as const;
  }

  try {
    const summary = await summarize(config, item.title, text);
    await client
      .from("news_items")
      .update({
        summary_md: summary.text.slice(0, 20_000),
        summary_model: summary.model,
        summary_prompt_version: SUMMARY_PROMPT_VERSION,
        summary_status: "summarized",
        summary_error: null,
        summarized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    return "summarized" as const;
  } catch (error) {
    await client
      .from("news_items")
      .update({
        summary_status: "extracted",
        summary_error: errorMessage(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", item.id);
    return "extracted" as const;
  }
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

interface TrendRow {
  id: string;
  term: string;
  hotness: number | string;
  half_life_hours: number | string;
  effective_at: string;
}

/**
 * Headlines are read through the coverage table rather than fetched, so a trend
 * summary costs one model call and no article extraction at all. The headlines
 * were already collected; the only question is what they add up to.
 */
async function trendHeadlines(client: SupabaseClient, trendId: string) {
  const { data, error } = await client
    .from("news_trend_coverage")
    .select("title")
    .eq("trend_id", trendId)
    .order("position")
    .limit(25);
  if (error) throw error;
  return ((data ?? []) as Array<{ title: string }>).map((row) => row.title);
}

async function trendCandidates(client: SupabaseClient) {
  const since = new Date(
    Date.now() - CANDIDATE_WINDOW_HOURS * 60 * 60 * 1_000,
  ).toISOString();
  const { data, error } = await client
    .from("news_trends")
    .select("id, term, hotness, half_life_hours, effective_at")
    .in("summary_status", ["pending", "extracted", "failed"])
    .gte("effective_at", since)
    .limit(300);
  if (error) throw error;

  const now = new Date();
  return ((data ?? []) as TrendRow[])
    .map((row) => ({
      row,
      score: decayedHotness(
        Number(row.hotness),
        new Date(row.effective_at),
        Number(row.half_life_hours),
        now,
      ),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_ITEMS_PER_RUN)
    .map((entry) => entry.row);
}

async function processTrend(
  client: SupabaseClient,
  trend: TrendRow,
  config: SummaryConfig | null,
) {
  const headlines = await trendHeadlines(client, trend.id);

  // No coverage is not a failure to retry forever — it is a keyword nothing has
  // been written about yet, which the next collection may change.
  if (headlines.length === 0) return "extracted" as const;

  if (!config) {
    await client
      .from("news_trends")
      .update({ summary_error: null, updated_at: new Date().toISOString() })
      .eq("id", trend.id);
    return "extracted" as const;
  }

  try {
    const summary = await summarizeTrend(config, trend.term, headlines);
    await client
      .from("news_trends")
      .update({
        summary_md: summary.text.slice(0, 20_000),
        summary_model: summary.model,
        summary_prompt_version: TREND_PROMPT_VERSION,
        summary_status: "summarized",
        summary_error: null,
        summarized_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", trend.id);
    return "summarized" as const;
  } catch (error) {
    await client
      .from("news_trends")
      .update({
        summary_status: "failed",
        summary_error: errorMessage(error),
        updated_at: new Date().toISOString(),
      })
      .eq("id", trend.id);
    return "extracted" as const;
  }
}

async function trend(client: SupabaseClient, trendId: string) {
  const { data, error } = await client
    .from("news_trends")
    .select("id, term, hotness, half_life_hours, effective_at")
    .eq("id", trendId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new ProviderRequestError("That keyword was not found.", 404);
  return data as TrendRow;
}

async function summarizeTrends(client: SupabaseClient, trendId?: string) {
  const config = summaryConfig();
  const trends = trendId
    ? [await trend(client, trendId)]
    : await trendCandidates(client);
  const counts = { summarized: 0, extracted: 0, failed: 0 };

  for (const row of trends) {
    counts[await processTrend(client, row, config)] += 1;
  }

  return {
    considered: trends.length,
    ...counts,
    modelConfigured: Boolean(config),
    model: config?.model ?? null,
  };
}

async function summarizeNews(client: SupabaseClient, itemId?: string) {
  const config = summaryConfig();
  const items = itemId
    ? [await candidate(client, itemId)]
    : await candidates(client);
  const counts = { summarized: 0, extracted: 0, failed: 0 };

  for (const item of items) {
    counts[await processItem(client, item, config)] += 1;
  }

  return {
    considered: items.length,
    ...counts,
    // Stated rather than inferred: "0 summarized" reads as a broken model until
    // you know no key was configured.
    modelConfigured: Boolean(config),
    // Which model actually wrote these, so a summary that reads oddly can be
    // traced to the provider without opening the dashboard.
    model: config?.model ?? null,
  };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed." }, 405);
  }

  try {
    const client = serviceClient();
    const syncSecret = Deno.env.get("PROVIDER_SYNC_SECRET");
    const scheduled = Boolean(
      syncSecret && request.headers.get("x-sync-secret") === syncSecret,
    );

    if (!scheduled) {
      const approvedUser = await requireApprovedUser(request, client);
      requireAdmin(approvedUser);
    }

    const body = (await request.json().catch(() => ({}))) as {
      itemId?: unknown;
      trendId?: unknown;
      scope?: unknown;
    };
    const itemId = typeof body.itemId === "string" ? body.itemId : undefined;
    const trendId = typeof body.trendId === "string" ? body.trendId : undefined;

    // The keyword page asks for one keyword; the schedule asks for both kinds.
    // A trend summary costs one model call and no article fetch, so on the
    // shared free-tier budget it is the cheaper half and runs first.
    if (trendId) {
      return jsonResponse(request, await summarizeTrends(client, trendId));
    }
    if (itemId) {
      return jsonResponse(request, await summarizeNews(client, itemId));
    }

    const trends = await summarizeTrends(client);
    const items = body.scope === "trends" ? null : await summarizeNews(client);

    return jsonResponse(request, {
      considered: trends.considered + (items?.considered ?? 0),
      summarized: trends.summarized + (items?.summarized ?? 0),
      extracted: trends.extracted + (items?.extracted ?? 0),
      failed: trends.failed + (items?.failed ?? 0),
      modelConfigured: trends.modelConfigured,
      model: trends.model,
      trends: trends.summarized,
    });
  } catch (error) {
    console.error("News summarization failed", error);
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
