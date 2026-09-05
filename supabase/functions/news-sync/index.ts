import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import {
  requireAdmin,
  requireApprovedUser,
  serviceClient,
  storeNewsItems,
} from "../_shared/database.ts";
import {
  jsonResponse,
  optionsResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import {
  attentionOf,
  canonicalizeUrl,
  classify,
  CLUSTER_WINDOW_MS,
  contentHash,
  effectiveAt,
  halfLifeFor,
  hotnessOf,
  type NewsCategory,
  NEWS_PARSER_VERSION,
  type RawNewsItem,
  TITLE_MATCH_MIN_SIMILARITY,
  titleKey,
  titleSimilarityOf,
  titleWords,
  urlKey,
  velocityOf,
} from "../_shared/news-rank.ts";
import {
  fetchSource,
  fetchTrends,
  isTrendSource,
  newsSources,
  sampleWatchTerm,
  type SourceDefinition,
  trendGeo,
} from "../_shared/news-sources.ts";
import {
  coverageTerms,
  deriveKeywords,
  type KeywordArticle,
  keywordKey,
  type ParsedTrend,
  TRENDS_PARSER_VERSION,
} from "../_shared/news-trends.ts";

interface ExistingItemRow {
  id: string;
  external_id: string;
  cluster_id: string;
  content_hash: string;
  attention: number | string | null;
  first_seen_at: string;
}

interface ClusterCandidate {
  cluster_id: string;
  url_key: string;
  title_key: string;
  effective_at: string;
}

interface SourceSyncResult {
  sourceId: string;
  status: "succeeded" | "skipped" | "failed";
  fetched: number;
  kept: number;
  created: number;
  updated: number;
  duplicates: number;
  error: string | null;
}

const RECENT_WINDOW_DAYS = 14;

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Source synchronization failed.";
}

function chunks<T>(items: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Pages through a result set instead of trusting one large `.limit()`.
 *
 * PostgREST clamps every response to `max_rows` — 1000 here (supabase/config.toml)
 * and 1000 on hosted Supabase — and it does so *silently*, with a 200 and a short
 * array rather than an error. A `.limit(5_000)` therefore reads as "give me the
 * window" and quietly returns an arbitrary, unordered fifth of it. Every query in
 * this file that can exceed a thousand rows goes through here, and each one
 * orders explicitly so the pages are stable.
 */
async function fetchAllRows<T>(
  fetchPage: (
    from: number,
    to: number,
  ) => PromiseLike<{
    data: T[] | null;
    error: { message: string } | null;
  }>,
  cap: number,
) {
  const pageSize = 1_000;
  const rows: T[] = [];
  for (let from = 0; from < cap; from += pageSize) {
    const result = await fetchPage(from, Math.min(from + pageSize, cap) - 1);
    if (result.error) throw new Error(result.error.message);
    const page = result.data ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return rows;
}

/**
 * ln(1 + attention) at the source's own median, over its recent history. This
 * is what lets 400 Hacker News points and a Lobsters score of 40 be compared
 * without either drowning the other.
 */
async function sourceBaselines(client: SupabaseClient) {
  const since = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1_000,
  ).toISOString();
  const rows = await fetchAllRows<{
    source_id: string;
    attention: number | string;
  }>(
    (from, to) =>
      client
        .from("news_items")
        .select("source_id, attention")
        .gte("first_seen_at", since)
        .not("attention", "is", null)
        .order("source_id")
        .order("id")
        .range(from, to),
    20_000,
  );

  const grouped = new Map<string, number[]>();
  for (const row of rows) {
    const value = Math.log1p(Number(row.attention));
    grouped.set(row.source_id, [...(grouped.get(row.source_id) ?? []), value]);
  }

  const baselines = new Map<string, number>();
  for (const [sourceId, values] of grouped) {
    const middle = median(values);
    if (middle !== null) baselines.set(sourceId, middle);
  }
  return baselines;
}

async function clusterCandidates(client: SupabaseClient) {
  const since = new Date(Date.now() - CLUSTER_WINDOW_MS).toISOString();
  return await fetchAllRows<ClusterCandidate>(
    (from, to) =>
      client
        .from("news_items")
        .select("cluster_id, url_key, title_key, effective_at")
        .gte("effective_at", since)
        .order("effective_at", { ascending: false })
        .order("id")
        .range(from, to),
    20_000,
  );
}

/**
 * The clustering window, indexed for lookup rather than scanned twice per item.
 *
 * The array form was two linear passes over a set that grows with every item in
 * the run — order eight million comparisons across thirty-one sources, each one
 * re-splitting both headlines into words. The URL pass is the one that matters
 * and it is an exact match, so it becomes a Map; the title pass keeps its scan
 * but compares pre-built word sets.
 */
class ClusterIndex {
  private readonly byUrl = new Map<string, string>();
  private readonly titles: Array<{
    clusterId: string;
    words: Set<string>;
    effectiveMs: number;
  }> = [];

  constructor(candidates: ClusterCandidate[]) {
    for (const candidate of candidates) {
      this.add(
        candidate.cluster_id,
        candidate.url_key,
        candidate.title_key,
        new Date(candidate.effective_at).getTime(),
      );
    }
  }

  add(clusterId: string, key: string, title: string, effectiveMs: number) {
    if (!this.byUrl.has(key)) this.byUrl.set(key, clusterId);
    this.titles.push({ clusterId, words: titleWords(title), effectiveMs });
  }

  /** The cluster this item belongs to, or null if it starts a new one. */
  find(key: string, title: string, effective: Date): string | null {
    const byUrl = this.byUrl.get(key);
    if (byUrl) return byUrl;

    const words = titleWords(title);
    const at = effective.getTime();
    for (const candidate of this.titles) {
      if (Math.abs(at - candidate.effectiveMs) > CLUSTER_WINDOW_MS) continue;
      if (
        titleSimilarityOf(words, candidate.words) >= TITLE_MATCH_MIN_SIMILARITY
      ) {
        return candidate.clusterId;
      }
    }
    return null;
  }
}

interface PreparedItem {
  raw: RawNewsItem;
  canonicalUrl: string;
  urlKey: string;
  titleKey: string;
  category: NewsCategory;
  categoryReason: string;
  clusterId: string;
  effective: Date;
  attention: number | null;
  hash: string;
}

/**
 * The rows this source already has, looked up by the external ids this run
 * actually saw.
 *
 * Reading the source's whole history instead would be both wasteful and wrong:
 * it crosses `max_rows` within days of hourly collection and is then silently
 * truncated, so stored items start looking new — inflating the created count,
 * erasing the previous snapshot that velocity is derived from, and resetting
 * the item's age.
 */
async function existingItems(
  client: SupabaseClient,
  sourceId: string,
  externalIds: string[],
) {
  const existing = new Map<string, ExistingItemRow>();
  for (const batch of chunks(externalIds, 150)) {
    const { data, error } = await client
      .from("news_items")
      .select(
        "id, external_id, cluster_id, content_hash, attention, first_seen_at",
      )
      .eq("source_id", sourceId)
      .in("external_id", batch);
    if (error) throw error;
    for (const row of (data ?? []) as ExistingItemRow[]) {
      existing.set(row.external_id, row);
    }
  }
  return existing;
}

async function prepareItems(
  source: SourceDefinition,
  raws: RawNewsItem[],
  index: ClusterIndex,
  existing: Map<string, ExistingItemRow>,
  now: Date,
) {
  const prepared: PreparedItem[] = [];
  const seenExternal = new Set<string>();

  for (const raw of raws) {
    if (!raw.title || !raw.url || !raw.externalId) continue;
    if (seenExternal.has(raw.externalId)) continue;
    seenExternal.add(raw.externalId);

    const previous = existing.get(raw.externalId);
    const canonical = canonicalizeUrl(raw.url);
    const key = await urlKey(canonical);
    const title = titleKey(raw.title);
    // Anchored to when this item was first seen, not to this run's clock.
    // Re-deriving it from `now` every hour resets the age of anything still in
    // its feed, so a source that publishes no date — GitHub trending — would
    // pin its items at the top of the page permanently, and one whose dates are
    // older than the backfill clamp would sit at a constant 48 hours forever.
    const anchor = previous ? new Date(previous.first_seen_at) : now;
    const effective = effectiveAt(raw.publishedAt, anchor);
    const { category, reason } = classify(raw, canonical, source);
    // A stored row keeps the cluster it was already filed under; only a new one
    // asks the index. Advertising anything else would tell the rest of the run
    // about a cluster that is never written.
    const clusterId =
      previous?.cluster_id ??
      index.find(key, title, effective) ??
      crypto.randomUUID();

    index.add(clusterId, key, title, effective.getTime());

    prepared.push({
      raw,
      canonicalUrl: canonical,
      urlKey: key,
      titleKey: title,
      category,
      categoryReason: reason,
      clusterId,
      effective,
      attention: attentionOf(source.family, raw),
      hash: await contentHash(raw),
    });
  }

  return prepared;
}

/**
 * The most recent snapshot for each item, which is what velocity is measured
 * against. Scoped to the ids in this run and read newest-first per page, so a
 * long-lived item's history cannot crowd another item out of the result.
 */
async function latestMetrics(client: SupabaseClient, itemIds: string[]) {
  const latest = new Map<string, { attention: number; capturedAt: Date }>();
  for (const batch of chunks(itemIds, 100)) {
    const rows = await fetchAllRows<{
      item_id: string;
      attention: number | string;
      captured_at: string;
    }>(
      (from, to) =>
        client
          .from("news_item_metrics")
          .select("item_id, attention, captured_at")
          .in("item_id", batch)
          .order("item_id")
          .order("captured_at", { ascending: false })
          .range(from, to),
      5_000,
    );
    for (const row of rows) {
      if (latest.has(row.item_id)) continue;
      latest.set(row.item_id, {
        attention: Number(row.attention),
        capturedAt: new Date(row.captured_at),
      });
    }
  }
  return latest;
}

async function syncSource(
  client: SupabaseClient,
  runId: string,
  source: SourceDefinition,
  index: ClusterIndex,
  baselines: Map<string, number>,
  now: Date,
): Promise<SourceSyncResult> {
  try {
    // A trending search is a keyword, not an article. It still reports a sync
    // run so the source-health panel can show it failing, but nothing it
    // returns belongs in news_items.
    if (isTrendSource(source)) {
      const { kept } = await syncTrendSource(client, source, now);
      await client.from("news_sync_source_runs").insert({
        run_id: runId,
        source_id: source.id,
        status: "succeeded",
        items_fetched: kept,
        items_kept: kept,
        duplicate_items: 0,
      });
      await client
        .from("news_sources")
        .update({ last_synced_at: now.toISOString(), last_error: null })
        .eq("id", source.id);
      return {
        sourceId: source.id,
        status: "succeeded",
        fetched: kept,
        kept,
        created: 0,
        updated: 0,
        duplicates: 0,
        error: null,
      };
    }

    const raws = await fetchSource(source);
    // Resolved before clustering, because whether a row already exists decides
    // both its cluster and the age it is scored at.
    const existing = await existingItems(
      client,
      source.id,
      raws.flatMap((raw) => (raw.externalId ? [raw.externalId] : [])),
    );
    const prepared = await prepareItems(source, raws, index, existing, now);

    const metrics = await latestMetrics(
      client,
      prepared.flatMap((item) => {
        const previous = existing.get(item.raw.externalId);
        return previous ? [previous.id] : [];
      }),
    );

    const baseline = baselines.get(source.id) ?? null;
    let created = 0;
    let updated = 0;

    const rows = prepared.map((item) => {
      const previous = existing.get(item.raw.externalId);
      const previousMetric = previous ? metrics.get(previous.id) : undefined;
      const hoursBetween = previousMetric
        ? (now.getTime() - previousMetric.capturedAt.getTime()) / 3_600_000
        : 0;
      const velocity =
        item.attention === null || !previousMetric
          ? null
          : velocityOf(
              source.family,
              item.attention,
              previousMetric.attention,
              hoursBetween,
            );

      return {
        source_id: source.id,
        external_id: item.raw.externalId,
        url: item.raw.url,
        canonical_url: item.canonicalUrl,
        url_key: item.urlKey,
        title: item.raw.title,
        title_key: item.titleKey,
        author: item.raw.author,
        excerpt: item.raw.excerpt,
        category: item.category,
        category_reason: item.categoryReason,
        // A story keeps the cluster it was first filed under, so a later
        // duplicate cannot split a thread that is already on the page.
        cluster_id: previous?.cluster_id ?? item.clusterId,
        // Floored, because the column is checked non-negative and Lobsters
        // publishes a *net* score: one downvoted story would otherwise fail the
        // whole hundred-row batch it happens to share.
        points: item.raw.points === null ? null : Math.max(item.raw.points, 0),
        comments:
          item.raw.comments === null ? null : Math.max(item.raw.comments, 0),
        attention: item.attention,
        velocity,
        hotness: hotnessOf({
          attention: item.attention,
          sourceMedianLogAttention: baseline,
          velocity,
          weight: source.weight,
        }),
        half_life_hours: halfLifeFor(source.family, item.category),
        published_at: item.raw.publishedAt,
        effective_at: item.effective.toISOString(),
        last_seen_at: now.toISOString(),
        content_hash: item.hash,
        parser_version: NEWS_PARSER_VERSION,
        updated_at: now.toISOString(),
      };
    });

    const preparedByExternalId = new Map(
      prepared.map((item) => [item.raw.externalId, item]),
    );
    let storedCount = 0;
    for (const batch of chunks(rows, 100)) {
      const batchItems = batch.flatMap((row) => {
        const externalId = row.external_id as string;
        const item = preparedByExternalId.get(externalId);
        return item ? [item] : [];
      });
      const stored = await storeNewsItems(
        client,
        batch,
        batchItems.flatMap((item) => {
          if (item.attention === null) return [];
          return [
            {
              source_id: source.id,
              external_id: item.raw.externalId,
              captured_at: now.toISOString(),
              attention: item.attention,
            },
          ];
        }),
        batchItems.map((item) => ({
          source_id: source.id,
          external_id: item.raw.externalId,
          raw_payload: item.raw.payload,
        })),
      );
      storedCount += stored.length;

      for (const row of stored) {
        const item = preparedByExternalId.get(row.stored_external_id);
        if (!item) continue;
        const previous = existing.get(row.stored_external_id);
        if (!previous) created += 1;
        else if (previous.content_hash !== item.hash) updated += 1;
      }
    }

    const completedAt = now.toISOString();
    await client
      .from("news_sources")
      .update({
        last_synced_at: completedAt,
        last_error: null,
        updated_at: completedAt,
      })
      .eq("id", source.id);
    await client.from("news_sync_source_runs").insert({
      run_id: runId,
      source_id: source.id,
      status: "succeeded",
      items_fetched: raws.length,
      items_kept: storedCount,
      duplicate_items: raws.length - storedCount,
    });

    return {
      sourceId: source.id,
      status: "succeeded",
      fetched: raws.length,
      kept: storedCount,
      created,
      updated,
      duplicates: raws.length - storedCount,
      error: null,
    };
  } catch (error) {
    const message = errorMessage(error);
    await client
      .from("news_sources")
      .update({ last_error: message, updated_at: new Date().toISOString() })
      .eq("id", source.id);
    await client.from("news_sync_source_runs").insert({
      run_id: runId,
      source_id: source.id,
      status: "failed",
      stop_reason: "request-or-processing-error",
      error: message,
    });
    return {
      sourceId: source.id,
      status: "failed",
      fetched: 0,
      kept: 0,
      created: 0,
      updated: 0,
      duplicates: 0,
      error: message,
    };
  }
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

/**
 * Half-lives are longer than an article's because a keyword outlives any one
 * story about it. A search that spikes stays interesting for the rest of the
 * day; a repo that shipped is worth a card tomorrow.
 */
const TREND_HALF_LIFE_HOURS: Record<NewsCategory, number> = {
  ai: 24,
  stack: 30,
  // Raised from 12 alongside the seven-day window. At a twelve-hour half-life a
  // keyword from Tuesday scores about 0.006% of a fresh one, so it was in the
  // window and invisible — the week would have been a week on paper only.
  genz: 24,
  // Channels upload on a weekly rhythm, so a keyword from a video should still
  // be there when the next one lands.
  media: 48,
};

/**
 * Seven days, matching the feed. A repo that shipped on Monday and again on
 * Thursday is one keyword with two peaks, and a three-day window would have
 * shown it as two unrelated bursts.
 */
const KEYWORD_WINDOW_HOURS = 24 * 7;
const MAX_KEYWORDS_PER_CATEGORY = 60;
const MAX_COVERAGE_PER_TREND = 12;

interface TrendUpsert {
  term: string;
  term_key: string;
  category: NewsCategory;
  origin: "search" | "coverage";
  geo: string | null;
  search_volume: number | null;
  article_count: number;
  source_count: number;
  picture_url: string | null;
  hotness: number;
  half_life_hours: number;
  effective_at: string;
  last_seen_at: string;
  parser_version: string;
  updated_at: string;
}

/** One entry per distinct headline, compared the way clustering compares them. */
function distinctTitles(titles: string[]): string[] {
  const seen = new Set<string>();
  return titles.filter((title) => {
    const key = titleKey(title);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * One row per (trend_id, key) within a batch, keeping the first.
 *
 * Guards the upserts above against Postgres 21000. Ordering is meaningful:
 * callers sort by hotness first, so "the first" is "the best one".
 */
function dedupe(
  rows: Array<Record<string, unknown>>,
  key: string,
): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const identity = `${String(row.trend_id)}|${String(row[key])}`;
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * Writes the keyword rows and everything hanging off them.
 *
 * The upsert deliberately does not touch first_seen_at or any summary column.
 * A keyword that trends again on Thursday is the same keyword, and resetting
 * its age would put it back at the top of the page every hour — the same bug
 * effective_at already guards against for articles.
 */
async function storeTrends(
  client: SupabaseClient,
  rows: TrendUpsert[],
  coverageOf: Map<string, Array<Record<string, unknown>>>,
  termsOf: Map<string, Array<{ term: string; weight: number; count: number }>>,
  capturedOn: string,
) {
  if (rows.length === 0) return 0;

  const stored: Array<{
    id: string;
    term_key: string;
    category: string;
    geo: string | null;
  }> = [];

  for (const batch of chunks(rows, 200)) {
    const { data, error } = await client
      .from("news_trends")
      .upsert(batch, { onConflict: "term_key,category,geo" })
      .select("id, term_key, category, geo");
    if (error) throw error;
    stored.push(...(data ?? []));
  }

  const idFor = new Map(
    stored.map((row) => [
      `${row.term_key}|${row.category}|${row.geo ?? ""}`,
      row.id,
    ]),
  );

  const coverageRows: Array<Record<string, unknown>> = [];
  const termRows: Array<Record<string, unknown>> = [];
  const metricRows: Array<Record<string, unknown>> = [];

  for (const row of rows) {
    const key = `${row.term_key}|${row.category}|${row.geo ?? ""}`;
    const trendId = idFor.get(key);
    if (!trendId) continue;

    for (const entry of coverageOf.get(key) ?? []) {
      coverageRows.push({ ...entry, trend_id: trendId });
    }
    for (const entry of termsOf.get(key) ?? []) {
      termRows.push({
        trend_id: trendId,
        term: entry.term,
        weight: entry.weight,
        article_count: entry.count,
      });
    }
    metricRows.push({
      trend_id: trendId,
      captured_on: capturedOn,
      search_volume: row.search_volume,
      article_count: row.article_count,
    });
  }

  // Postgres refuses an ON CONFLICT batch that proposes one conflict key twice
  // — 21000, "cannot affect row a second time" — and it refuses the whole
  // statement, not the offending row. Two sources carrying one story is the
  // normal case here rather than an edge case; it is what clustering exists
  // for. So the same canonical_url arrives twice for a keyword that covers
  // both, and the first article wins because coverage is already ordered by
  // hotness.
  // Coverage and terms are recomputed in full every run, so stale rows are
  // replaced rather than merged. Upserting alone left a keyword wearing terms
  // derived under older rules — "and the", "road ahead" — long after the rules
  // that produced them were gone.
  const trendIds = [...idFor.values()];
  for (const batch of chunks(
    trendIds.map((id) => ({ id })),
    200,
  )) {
    const ids = batch.map((row) => row.id as string);
    const { error: clearedTerms } = await client
      .from("news_trend_terms")
      .delete()
      .in("trend_id", ids);
    if (clearedTerms) throw clearedTerms;
    const { error: clearedCoverage } = await client
      .from("news_trend_coverage")
      .delete()
      .in("trend_id", ids);
    if (clearedCoverage) throw clearedCoverage;
  }

  for (const batch of chunks(dedupe(coverageRows, "canonical_url"), 500)) {
    const { error } = await client
      .from("news_trend_coverage")
      .upsert(batch, { onConflict: "trend_id,canonical_url" });
    if (error) throw error;
  }
  for (const batch of chunks(dedupe(termRows, "term"), 500)) {
    const { error } = await client
      .from("news_trend_terms")
      .upsert(batch, { onConflict: "trend_id,term" });
    if (error) throw error;
  }
  for (const batch of chunks(metricRows, 500)) {
    const { error } = await client
      .from("news_trend_metrics")
      .upsert(batch, { onConflict: "trend_id,captured_on" });
    if (error) throw error;
  }

  return rows.length;
}

/**
 * Google's trending searches. These carry a real search volume, which nothing
 * else here does, so their origin is 'search' and the number on the card means
 * people rather than articles.
 */
async function syncTrendSource(
  client: SupabaseClient,
  source: SourceDefinition,
  now: Date,
): Promise<{ kept: number }> {
  const trends: ParsedTrend[] = await fetchTrends(source);
  if (trends.length === 0) return { kept: 0 };

  const geo = trendGeo(source);
  const capturedOn = now.toISOString().slice(0, 10);
  const rows: TrendUpsert[] = [];
  const coverageOf = new Map<string, Array<Record<string, unknown>>>();
  const termsOf = new Map<
    string,
    Array<{ term: string; weight: number; count: number }>
  >();

  for (const trend of trends) {
    const termKey = keywordKey(trend.term);
    if (!termKey) continue;

    // The connector used to hardcode GenZ, which filed pork prices under youth
    // culture. A regional trending search is genuinely general interest, and
    // GenZ is the tab this app has for that — but the category is at least now
    // stated in one place rather than asserted per item.
    const category: NewsCategory = source.category ?? "genz";
    const key = `${termKey}|${category}|${geo}`;
    const published = trend.publishedAt ? new Date(trend.publishedAt) : now;
    const effective =
      Number.isNaN(published.getTime()) || published > now ? now : published;

    rows.push({
      term: trend.term,
      term_key: termKey,
      category,
      origin: "search",
      geo,
      search_volume: trend.approxTraffic,
      article_count: trend.coverage.length,
      source_count: new Set(trend.coverage.map((entry) => entry.sourceName))
        .size,
      picture_url: trend.pictureUrl,
      // Search volume is the attention signal, and it arrives as a floor like
      // "200+". log1p keeps a 1M+ term from dwarfing every other card.
      hotness: Math.log1p(trend.approxTraffic ?? 0) * source.weight,
      half_life_hours: TREND_HALF_LIFE_HOURS[category],
      effective_at: effective.toISOString(),
      last_seen_at: now.toISOString(),
      parser_version: TRENDS_PARSER_VERSION,
      updated_at: now.toISOString(),
    });

    coverageOf.set(
      key,
      trend.coverage
        .slice(0, MAX_COVERAGE_PER_TREND)
        .map((entry, position) => ({
          item_id: null,
          title: entry.title,
          url: entry.url,
          canonical_url: entry.canonicalUrl,
          source_name: entry.sourceName,
          published_at: null,
          position,
        })),
    );

    termsOf.set(
      key,
      coverageTerms(
        distinctTitles(trend.coverage.map((entry) => entry.title)),
        trend.term,
      ).map((entry) => ({
        term: entry.term,
        weight: entry.weight,
        count: entry.articleCount,
      })),
    );
  }

  await storeTrends(client, rows, coverageOf, termsOf, capturedOn);
  return { kept: rows.length };
}

/**
 * Keywords for AI and Stack, where Google Trends is silent — it reports what a
 * whole country searched, and no country searches "llama.cpp".
 *
 * Derived from the articles already collected, so these carry article and
 * source counts rather than a search volume. origin says which, and the check
 * constraint on the table refuses a search_volume here at all.
 */
async function deriveTrendKeywords(client: SupabaseClient, now: Date) {
  const since = new Date(
    now.getTime() - KEYWORD_WINDOW_HOURS * 60 * 60 * 1_000,
  ).toISOString();

  // Paged, because PostgREST caps a response at max_rows and does it with a
  // 200 and a short array. A bare .limit() here would quietly derive keywords
  // from an arbitrary slice of the window.
  const rows = await fetchAllRows<{
    id: string;
    source_id: string;
    title: string;
    url: string;
    canonical_url: string;
    category: NewsCategory;
    hotness: number | string;
    half_life_hours: number | string;
    effective_at: string;
    published_at: string | null;
  }>(
    (from, to) =>
      client
        .from("news_items")
        .select(
          "id, source_id, title, url, canonical_url, category, hotness, half_life_hours, effective_at, published_at",
        )
        .gte("effective_at", since)
        .order("id")
        .range(from, to),
    20_000,
  );

  const names = new Map(newsSources.map((source) => [source.id, source.name]));
  // A trending search is already a keyword. Any rows a trend source left in
  // news_items are from before this function existed, and deriving keywords
  // from them would put the same term on the page twice — once as origin
  // 'search' with its real volume, once as origin 'coverage' counting the
  // search itself as an article.
  const trendSourceIds = new Set(
    newsSources.filter(isTrendSource).map((source) => source.id),
  );

  const articles: KeywordArticle[] = rows
    .filter((row) => !trendSourceIds.has(row.source_id))
    .map((row) => ({
      id: row.id,
      sourceId: row.source_id,
      sourceName: names.get(row.source_id) ?? row.source_id,
      title: row.title,
      url: row.url,
      canonicalUrl: row.canonical_url,
      category: row.category,
      hotness: Number(row.hotness),
      halfLifeHours: Number(row.half_life_hours),
      effectiveAt: new Date(row.effective_at),
      publishedAt: row.published_at,
    }));

  const byId = new Map(articles.map((article) => [article.id, article]));
  const derived = deriveKeywords(articles, now);

  const perCategory: Record<string, number> = {};
  const rowsToStore: TrendUpsert[] = [];
  const coverageOf = new Map<string, Array<Record<string, unknown>>>();
  const termsOf = new Map<
    string,
    Array<{ term: string; weight: number; count: number }>
  >();
  const capturedOn = now.toISOString().slice(0, 10);

  for (const keyword of derived) {
    const taken = perCategory[keyword.category] ?? 0;
    if (taken >= MAX_KEYWORDS_PER_CATEGORY) continue;
    perCategory[keyword.category] = taken + 1;

    const covering = keyword.articleIds
      .flatMap((id) => {
        const article = byId.get(id);
        return article ? [article] : [];
      })
      .sort((left, right) => right.hotness - left.hotness);
    if (covering.length === 0) continue;

    // The keyword is as new as its freshest article, not as old as its oldest:
    // a repo that shipped again today is today's keyword.
    const newest = covering.reduce((best, article) =>
      article.effectiveAt > best.effectiveAt ? article : best,
    );
    const key = `${keyword.termKey}|${keyword.category}|`;

    rowsToStore.push({
      term: keyword.term,
      term_key: keyword.termKey,
      category: keyword.category,
      origin: "coverage",
      geo: null,
      search_volume: null,
      article_count: covering.length,
      source_count: keyword.sourceIds.length,
      picture_url: null,
      hotness: keyword.score,
      half_life_hours: TREND_HALF_LIFE_HOURS[keyword.category],
      effective_at: newest.effectiveAt.toISOString(),
      last_seen_at: now.toISOString(),
      parser_version: TRENDS_PARSER_VERSION,
      updated_at: now.toISOString(),
    });

    coverageOf.set(
      key,
      covering.slice(0, MAX_COVERAGE_PER_TREND).map((article, position) => ({
        item_id: article.id,
        title: article.title,
        url: article.url,
        canonical_url: article.canonicalUrl,
        source_name: article.sourceName,
        published_at: article.publishedAt,
        position,
      })),
    );

    termsOf.set(
      key,
      coverageTerms(
        // Distinct headlines, not every row. Four sources carrying one story
        // is the normal case, and counting that headline four times made its
        // every fragment — "and the", "road ahead", "The Hugging" — look
        // like a term recurring across the coverage rather than one sentence
        // repeated.
        distinctTitles(covering.map((article) => article.title)),
        keyword.term,
      ).map((entry) => ({
        term: entry.term,
        weight: entry.weight,
        count: entry.articleCount,
      })),
    );
  }

  await storeTrends(client, rowsToStore, coverageOf, termsOf, capturedOn);

  // Derivation is complete, not incremental: every run rebuilds the whole
  // window from news_items. So a derived keyword this run did not produce is
  // one the corpus no longer supports, and leaving it would let a keyword
  // outlive its own evidence — the rules changing is exactly when that
  // happens, and stale rows sat on the page for the seven-day window with
  // nothing behind them.
  //
  // Scoped to origin 'coverage'. Search keywords are Google's, they are
  // written on a different path, and a run where Trends is unreachable must
  // not read as "none of them trend any more".
  const { error: retired } = await client
    .from("news_trends")
    .delete()
    .eq("origin", "coverage")
    .lt("last_seen_at", now.toISOString());
  if (retired) throw retired;

  return rowsToStore.length;
}

async function syncWatchTerms(client: SupabaseClient, now: Date) {
  const { data, error } = await client
    .from("news_watch_terms")
    .select("id, term, wiki_article")
    .eq("active", true);
  if (error) throw error;

  const terms = (data ?? []) as Array<{
    id: string;
    term: string;
    wiki_article: string | null;
  }>;
  if (terms.length === 0) return 0;

  const capturedOn = now.toISOString().slice(0, 10);
  const rows = [];
  for (const term of terms) {
    const sample = await sampleWatchTerm(term.term, term.wiki_article);
    rows.push({
      term_id: term.id,
      captured_on: capturedOn,
      wiki_views: sample.wikiViews,
      definitions: sample.definitions,
      thumbs_up: sample.thumbsUp,
    });
  }

  const { error: insertError } = await client
    .from("news_watch_metrics")
    .upsert(rows, { onConflict: "term_id,captured_on" });
  if (insertError) throw insertError;
  return rows.length;
}

async function synchronizeNews(client: SupabaseClient, requestedBy: string) {
  const staleCutoff = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  await client
    .from("news_sync_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "Synchronization timed out.",
    })
    .eq("status", "running")
    .lt("started_at", staleCutoff);

  const { data: run, error: runError } = await client
    .from("news_sync_runs")
    .insert({
      requested_by: requestedBy,
      sources_attempted: newsSources.length,
    })
    .select("id")
    .single();
  if (runError) {
    if (runError.code === "23505") {
      throw new ProviderRequestError(
        "The news feed is already synchronizing.",
        409,
      );
    }
    throw runError;
  }

  try {
    const now = new Date();
    const baselines = await sourceBaselines(client);
    const index = new ClusterIndex(await clusterCandidates(client));
    const results: SourceSyncResult[] = [];

    for (const source of newsSources) {
      results.push(
        await syncSource(
          client,
          run.id as string,
          source,
          index,
          baselines,
          now,
        ),
      );
    }

    // After every source, because a keyword is derived from the whole corpus
    // and a repo that shipped on two feeds is only corroborated once both have
    // been stored. Isolated like the watch terms: keyword derivation failing
    // must not lose a run's worth of collected articles.
    let derivedKeywords = 0;
    try {
      derivedKeywords = await deriveTrendKeywords(client, now);
    } catch (error) {
      console.error("Keyword derivation failed", error);
    }

    let watchTerms = 0;
    try {
      watchTerms = await syncWatchTerms(client, now);
    } catch (error) {
      console.error("Watch-term sampling failed", error);
    }

    const succeeded = results.filter(
      (result) => result.status === "succeeded",
    ).length;
    const failed = results.filter(
      (result) => result.status === "failed",
    ).length;
    const status =
      succeeded === 0 ? "failed" : failed > 0 ? "partial" : "succeeded";
    const totals = results.reduce(
      (sum, result) => ({
        fetched: sum.fetched + result.kept,
        created: sum.created + result.created,
        updated: sum.updated + result.updated,
      }),
      { fetched: 0, created: 0, updated: 0 },
    );

    const { error: completionError } = await client
      .from("news_sync_runs")
      .update({
        status,
        completed_at: new Date().toISOString(),
        sources_succeeded: succeeded,
        items_fetched: totals.fetched,
        items_created: totals.created,
        items_updated: totals.updated,
        error:
          failed > 0
            ? `${failed} source${failed === 1 ? "" : "s"} failed.`
            : null,
      })
      .eq("id", run.id);
    if (completionError) throw completionError;

    return {
      runId: run.id as string,
      status,
      watchTerms,
      keywords: derivedKeywords,
      ...totals,
      sources: results,
    };
  } catch (error) {
    await client
      .from("news_sync_runs")
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error:
          error instanceof Error ? error.message : "Synchronization failed.",
      })
      .eq("id", run.id);
    throw error;
  }
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
    let requestedBy: string;

    if (scheduled) {
      const { data: admin, error } = await client
        .from("profiles")
        .select("id")
        .eq("status", "approved")
        .eq("role", "admin")
        .order("created_at", { ascending: true })
        .limit(1)
        .single();
      if (error || !admin) throw new Error("An approved admin is required.");
      requestedBy = admin.id as string;
    } else {
      const approvedUser = await requireApprovedUser(request, client);
      requireAdmin(approvedUser);
      requestedBy = approvedUser.user.id;
    }

    return jsonResponse(request, await synchronizeNews(client, requestedBy));
  } catch (error) {
    console.error("News synchronization failed", error);
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
