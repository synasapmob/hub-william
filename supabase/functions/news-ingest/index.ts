// The one way into news_items that does not come from a connector.
//
// Some sources cannot be fetched from a server at all: LinkedIn and X answer a
// login wall to anything without a session, and TikTok's API answers
// {"code":40101,"msg":"no permission"}. A browser signed in as a real person
// can read them, and that browser is on somebody's laptop rather than in an
// Edge Function.
//
// So collection for those splits in two. A local Playwright script reads the
// pages and posts the result here; this validates it, ranks it the same way
// every other item is ranked, and stores it. The laptop never holds a
// service-role key — it holds the same PROVIDER_SYNC_SECRET the cron already
// uses, and nothing else.
//
// Deliberately not scheduled. These sources are read when a person runs the
// script, at whatever hour they happen to run it, which is the difference
// between using a product and operating a bot against it.

import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { serviceClient, storeNewsItems } from "../_shared/database.ts";
import {
  jsonResponse,
  optionsResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import {
  canonicalizeUrl,
  classify,
  contentHash,
  effectiveAt,
  halfLifeFor,
  hotnessOf,
  type NewsCategory,
  NEWS_PARSER_VERSION,
  type RawNewsItem,
  titleKey,
  urlKey,
} from "../_shared/news-rank.ts";

/** One post as the local script reports it. Everything else is derived here. */
interface IngestItem {
  externalId?: unknown;
  url?: unknown;
  title?: unknown;
  excerpt?: unknown;
  publishedAt?: unknown;
  author?: unknown;
}

interface SourceRow {
  id: string;
  name: string;
  category: NewsCategory | null;
  category_exclusive: boolean;
  weight: number | string;
  enabled: boolean;
}

// A browser session reads a page, not an archive. More than this in one post is
// a sign something is enumerating rather than reading.
const MAX_ITEMS_PER_INGEST = 200;
const MAX_TITLE = 300;
const MAX_EXCERPT = 600;

/**
 * Trims, caps, and refuses to hand Postgres a broken surrogate pair.
 *
 * JavaScript counts UTF-16 code units, so slicing a string that contains an
 * astral character — the bold letters LinkedIn posts are full of, 𝗜'𝘃𝗲 — can
 * cut one character in half. What is left is an unpaired \uD835, which is not
 * valid UTF-8, and the insert fails for the whole batch. One post like that
 * took down a harvest of seven.
 */
function text(value: unknown, cap: number) {
  if (typeof value !== "string") return "";
  let out = value.trim().slice(0, cap);
  // A high surrogate at the very end lost its partner to the slice.
  if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
  // And anything already unpaired before it arrived.
  return out.replace(
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
    "",
  );
}

function readItems(body: unknown): IngestItem[] {
  if (typeof body !== "object" || body === null) return [];
  const items = (body as { items?: unknown }).items;
  return Array.isArray(items) ? (items as IngestItem[]) : [];
}

async function ingest(
  client: SupabaseClient,
  source: SourceRow,
  raw: IngestItem[],
  now: Date,
) {
  const { data: existingRows, error: existingError } = await client
    .from("news_items")
    .select("id, external_id, cluster_id, first_seen_at")
    .eq("source_id", source.id)
    .in(
      "external_id",
      raw.flatMap((item) => {
        const id = text(item.externalId, 200);
        return id ? [id] : [];
      }),
    );
  if (existingError) throw existingError;

  const existing = new Map(
    (
      (existingRows ?? []) as Array<{
        id: string;
        external_id: string;
        cluster_id: string;
        first_seen_at: string;
      }>
    ).map((row) => [row.external_id, row]),
  );

  const rows: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();

  for (const item of raw) {
    const externalId = text(item.externalId, 200);
    const url = text(item.url, 2_000);
    const title = text(item.title, MAX_TITLE);
    if (!externalId || !url || !title) continue;
    if (seen.has(externalId)) continue;
    seen.add(externalId);

    const canonical = canonicalizeUrl(url);
    const previous = existing.get(externalId);
    // Anchored to when the item was first seen, exactly as the collector does
    // it, so a post re-read tomorrow does not become today's news.
    const anchor = previous ? new Date(previous.first_seen_at) : now;
    const published = text(item.publishedAt, 40);
    const effective = effectiveAt(published || null, anchor);

    const shaped: RawNewsItem = {
      sourceId: source.id,
      externalId,
      url,
      title,
      author: text(item.author, 120) || null,
      excerpt: text(item.excerpt, MAX_EXCERPT),
      publishedAt: published || null,
      points: null,
      comments: null,
      attentionOverride: null,
      categoryHint: null,
      payload: { ingested: true },
    };

    const { category, reason } = classify(shaped, canonical, {
      category: source.category,
      categoryExclusive: source.category_exclusive,
    });

    rows.push({
      source_id: source.id,
      external_id: externalId,
      url,
      canonical_url: canonical,
      url_key: await urlKey(canonical),
      title,
      title_key: titleKey(title),
      author: shaped.author,
      excerpt: shaped.excerpt,
      category,
      category_reason: reason,
      cluster_id: previous?.cluster_id ?? crypto.randomUUID(),
      points: null,
      comments: null,
      attention: null,
      velocity: null,
      // No vote counter reaches us from a rendered feed, so these rank on their
      // source's weight the way every other counterless source does.
      hotness: hotnessOf({
        attention: null,
        sourceMedianLogAttention: null,
        velocity: null,
        weight: Number(source.weight),
      }),
      half_life_hours: halfLifeFor("rss", category),
      published_at: shaped.publishedAt,
      effective_at: effective.toISOString(),
      last_seen_at: now.toISOString(),
      content_hash: await contentHash(shaped),
      parser_version: NEWS_PARSER_VERSION,
      updated_at: now.toISOString(),
    });
  }

  if (rows.length === 0) return { stored: 0, created: 0 };

  const stored = await storeNewsItems(client, rows, [], []);
  const created = stored.filter(
    (row) => !existing.has(row.stored_external_id),
  ).length;

  await client
    .from("news_sources")
    .update({ last_synced_at: now.toISOString(), last_error: null })
    .eq("id", source.id);

  return { stored: stored.length, created };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return optionsResponse(request);
  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed." }, 405);
  }

  try {
    const secret = Deno.env.get("PROVIDER_SYNC_SECRET");
    // The shared secret is the whole of the authorization here. There is no
    // user session behind a laptop script, and this endpoint writes to a table
    // the browser can only read.
    if (!secret || request.headers.get("x-sync-secret") !== secret) {
      throw new ProviderRequestError("A valid sync secret is required.", 401);
    }

    const body = (await request.json().catch(() => null)) as unknown;
    const sourceId = text((body as { sourceId?: unknown })?.sourceId, 100);
    if (!sourceId) {
      throw new ProviderRequestError("A sourceId is required.", 400);
    }

    const items = readItems(body);
    if (items.length === 0) {
      throw new ProviderRequestError("No items were supplied.", 400);
    }
    if (items.length > MAX_ITEMS_PER_INGEST) {
      throw new ProviderRequestError(
        `At most ${MAX_ITEMS_PER_INGEST} items may be ingested at once.`,
        400,
      );
    }

    const client = serviceClient();
    const { data: source, error } = await client
      .from("news_sources")
      .select("id, name, category, category_exclusive, weight, enabled")
      .eq("id", sourceId)
      .maybeSingle();
    if (error) throw error;
    if (!source) {
      throw new ProviderRequestError("That source is not registered.", 404);
    }
    if (!(source as SourceRow).enabled) {
      throw new ProviderRequestError("That source is disabled.", 409);
    }

    const result = await ingest(client, source as SourceRow, items, new Date());
    return jsonResponse(request, { sourceId, ...result });
  } catch (error) {
    console.error("News ingest failed", error);
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
