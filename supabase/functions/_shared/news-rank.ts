// Everything that turns a fetched item into a ranked, categorised, deduplicated
// row. Deliberately free of I/O so the rules can be tested directly and so a
// version bump can re-derive the whole table without refetching anything.

export type NewsCategory = "ai" | "stack" | "genz" | "media";

export const NEWS_PARSER_VERSION = "rules-2026-08-25-v1";

/** Source families share decay and attention behaviour, not endpoints. */
export type SourceFamily =
  "hn" | "lobsters" | "reddit" | "github" | "hf" | "devto" | "rss";

export interface RawNewsItem {
  sourceId: string;
  externalId: string;
  url: string;
  title: string;
  author: string | null;
  excerpt: string;
  publishedAt: string | null;
  points: number | null;
  comments: number | null;
  /**
   * For sources whose popularity is not a vote count — a star delta, a
   * trendingScore, an upvote count nested somewhere odd. Null means the source
   * publishes no popularity signal at all and is ranked editorially.
   */
  attentionOverride: number | null;
  /** A category the source itself asserted, e.g. an arXiv primary category. */
  categoryHint: NewsCategory | null;
  payload: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Canonical URLs
// ---------------------------------------------------------------------------

const TRACKING_PARAMS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "utm_id",
  "utm_name",
  "ref",
  "ref_src",
  "ref_url",
  "referrer",
  "source",
  "src",
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "yclid",
  "wbraid",
  "gbraid",
  "ttclid",
  "igshid",
  "igsh",
  "twclid",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "_hsenc",
  "_hsmi",
  "cmpid",
  "campaign_id",
  "spm",
  "trk",
  "sh",
  "share_id",
  "guccounter",
  "guce_referrer",
  "guce_referrer_sig",
  "__twitter_impression",
  "amp",
  "_gl",
]);

// Hosts where a query parameter is identity rather than decoration. Everything
// else has its query stripped down to the non-tracking remainder.
const IDENTITY_PARAMS: Record<string, Set<string>> = {
  "youtube.com": new Set(["v", "list", "t"]),
  "news.ycombinator.com": new Set(["id"]),
  "docs.google.com": new Set(["id"]),
};

/**
 * Families of URL that are the same thing wearing different clothes. Collapsing
 * them is what makes an arXiv paper submitted three times, or a repo linked
 * once by tree URL and once by root, count as one story.
 *
 * The GitHub rule intentionally stops at the repository root and leaves
 * /issues/123 and /pull/456 alone — those are separate stories about one repo.
 */
const ENTITY_RULES: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [
    /^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf|html)\/(\d{4}\.\d{4,5})(?:v\d+)?/i,
    (match) => `arxiv:${match[1]}`,
  ],
  [
    /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/.*)?$/i,
    (match) => `github:${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
  ],
  [
    /^https?:\/\/huggingface\.co\/(datasets|spaces)\/([^/]+)\/([^/#?]+)/i,
    (match) =>
      `hf:${match[1]}:${match[2].toLowerCase()}/${match[3].toLowerCase()}`,
  ],
  [
    /^https?:\/\/huggingface\.co\/(?!datasets|spaces|papers)([^/]+)\/([^/#?]+)/i,
    (match) => `hf:${match[1].toLowerCase()}/${match[2].toLowerCase()}`,
  ],
  [
    /^https?:\/\/(?:www\.)?youtube\.com\/watch\?(?:.*&)?v=([\w-]{11})/i,
    (match) => `yt:${match[1]}`,
  ],
  [/^https?:\/\/youtu\.be\/([\w-]{11})/i, (match) => `yt:${match[1]}`],
  [
    /^https?:\/\/(?:dx\.)?doi\.org\/(10\.[^\s]+)$/i,
    (match) => `doi:${match[1].toLowerCase()}`,
  ],
  [
    /^https?:\/\/(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i,
    (match) => `x:${match[1]}`,
  ],
];

export function canonicalizeUrl(raw: string): string {
  const trimmed = raw.trim();

  for (const [pattern, toKey] of ENTITY_RULES) {
    const match = trimmed.match(pattern);
    if (match) return toKey(match);
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Not a URL at all — a Google Trends term, a slang word. It is its own key.
    return trimmed.toLowerCase();
  }

  const host = url.hostname
    .toLowerCase()
    .replace(/^(?:www|www2|m|mobile|amp)\./, "");
  const identity = IDENTITY_PARAMS[host];
  const kept: Array<[string, string]> = [];

  for (const [key, value] of url.searchParams) {
    const lower = key.toLowerCase();
    if (value === "") continue;
    if (identity) {
      if (identity.has(lower)) kept.push([lower, value]);
      continue;
    }
    if (TRACKING_PARAMS.has(lower)) continue;
    if (lower.startsWith("utm_") || lower.startsWith("at_")) continue;
    kept.push([lower, value]);
  }

  kept.sort((left, right) =>
    left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
  );

  const path =
    url.pathname
      .replace(/\/{2,}/g, "/")
      .replace(/\/amp(?:\.html)?$/i, "")
      .replace(/\/index\.(?:html?|php|aspx?)$/i, "/")
      .replace(/\/+$/, "") || "/";

  const query = kept.map(([key, value]) => `${key}=${value}`).join("&");
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

export async function urlKey(canonical: string): Promise<string> {
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// Title similarity
// ---------------------------------------------------------------------------

function normalizeTitle(title: string) {
  return title
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The comparable form of a headline. Stored per item so two feeds wording one
 * story differently can still be recognised as one story.
 */
export function titleKey(title: string): string {
  return normalizeTitle(title);
}

/**
 * Jaccard similarity over word sets, not a simhash.
 *
 * Simhash is the reflex here and it is the wrong tool at this length: a
 * headline yields five or six 3-word shingles, so one extra word moves nine
 * bits of a 64-bit fingerprint. Measured on real pairs it put
 * "OpenAI releases GPT-5.6 for developers" and the same headline plus "today"
 * nine bits apart — further than the threshold anyone would set. Word overlap
 * is stable at this size and needs no magic bit distance.
 */
export function titleWords(key: string): Set<string> {
  return new Set(key.split(" ").filter(Boolean));
}

/**
 * The set form, for callers that compare one title against thousands and would
 * otherwise re-split and re-allocate both sides on every comparison.
 */
export function titleSimilarityOf(
  left: Set<string>,
  right: Set<string>,
): number {
  // Below this a coincidental two-word overlap looks like agreement:
  // "Postgres 19 released" and "Postgres 19 benchmarks" share two of three
  // words while being different stories. Short titles must match exactly.
  if (left.size < 4 || right.size < 4) {
    if (left.size !== right.size) return 0;
    for (const word of left) if (!right.has(word)) return 0;
    return 1;
  }

  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function titleSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  return titleSimilarityOf(titleWords(left), titleWords(right));
}

export const TITLE_MATCH_MIN_SIMILARITY = 0.5;
export const CLUSTER_WINDOW_MS = 72 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Category routing
// ---------------------------------------------------------------------------

const HOST_CATEGORY: Record<string, NewsCategory> = {
  "huggingface.co": "ai",
  "openai.com": "ai",
  "anthropic.com": "ai",
  "claude.com": "ai",
  "deepmind.google": "ai",
  "ai.meta.com": "ai",
  "mistral.ai": "ai",
  "lmsys.org": "ai",
  "together.ai": "ai",
  "replicate.com": "ai",
  "openreview.net": "ai",
  "pytorch.org": "ai",
  "stackoverflow.com": "stack",
  "martinfowler.com": "stack",
  "infoq.com": "stack",
  "lwn.net": "stack",
  "rust-lang.org": "stack",
  "go.dev": "stack",
  "kubernetes.io": "stack",
  "postgresql.org": "stack",
  "developer.mozilla.org": "stack",
  "nvd.nist.gov": "stack",
  "phoronix.com": "stack",
  "supabase.com": "stack",
  "vercel.com": "stack",
  "techcrunch.com": "stack",
  "theverge.com": "stack",
  "tiktok.com": "genz",
  "knowyourmeme.com": "genz",
  "urbandictionary.com": "genz",
  "kenh14.vn": "genz",
  "dexerto.com": "genz",
  "youtube.com": "media",
  "youtu.be": "media",
};

const LEXICON: Record<NewsCategory, string[]> = {
  ai: [
    "llm",
    "gpt",
    "claude",
    "gemini",
    "openai",
    "anthropic",
    "deepmind",
    "mistral",
    "llama",
    "qwen",
    "deepseek",
    "grok",
    "transformer",
    "diffusion",
    "embedding",
    "fine-tune",
    "finetune",
    "rag",
    "agentic",
    "ai agent",
    "agent harness",
    "prompt",
    "prompting",
    "benchmark",
    "eval",
    "inference",
    "quantization",
    "neural",
    "machine learning",
    "deep learning",
    "model context protocol",
    "mcp",
    "copilot",
    "chatbot",
    "hallucination",
    "tokenizer",
    "context window",
    "open-weights",
    "multimodal",
  ],
  stack: [
    "typescript",
    "javascript",
    "rust",
    "golang",
    "python",
    "react",
    "vue",
    "svelte",
    "angular",
    "vite",
    "webpack",
    "node.js",
    "deno",
    "bun",
    "postgres",
    "sqlite",
    "mysql",
    "redis",
    "kubernetes",
    "docker",
    "terraform",
    "aws",
    "serverless",
    "compiler",
    "runtime",
    "framework",
    "library",
    "release",
    "changelog",
    "deprecat",
    "vulnerability",
    "cve",
    "open source",
    "layoff",
    "hiring",
    "laid off",
    "headcount",
    "restructuring",
    "acquisition",
    "funding round",
    "ipo",
    "startup",
  ],
  genz: [
    "gen z",
    "genz",
    "gen-z",
    "tiktok",
    "slang",
    "meme",
    "brainrot",
    "rizz",
    "viral",
    "trend",
    "teen",
    "student",
    "dating",
    "hẹn hò",
    "giới trẻ",
    "học đường",
    "sinh viên",
    "đời sống",
    "trào lưu",
    "gu",
    "influencer",
    "creator",
    "aesthetic",
  ],
  // Deliberately empty. Media is decided by its source, never by its words.
  //
  // The first version listed video, review, tutorial, stream and the rest, and
  // "Laion Big Video Dataset" — a Hacker News link to a research dataset —
  // landed on the Media tab next to actual uploads. Those words are far too
  // common in AI and Stack headlines to mean "this is a video", and every media
  // source is categoryExclusive anyway, so the lexicon was never load-bearing.
  media: [],
};

const TIE_ORDER: NewsCategory[] = ["ai", "stack", "genz", "media"];

export interface ClassifySourceContext {
  category: NewsCategory | null;
  categoryExclusive: boolean;
}

export interface ClassifyResult {
  category: NewsCategory;
  reason: string;
}

function hostOf(canonical: string) {
  if (!canonical.startsWith("https://")) return "";
  try {
    return new URL(canonical).hostname;
  } catch {
    return "";
  }
}

function registrableSuffixMatch(host: string): NewsCategory | null {
  if (HOST_CATEGORY[host]) return HOST_CATEGORY[host];
  for (const [known, category] of Object.entries(HOST_CATEGORY)) {
    if (host.endsWith(`.${known}`)) return category;
  }
  return null;
}

/**
 * First confident match wins. A single-topic source short-circuits; a mixed one
 * such as Hacker News only nudges the lexicon, because it genuinely carries all
 * three categories and letting it decide would file half the feed wrongly.
 */
export function classify(
  item: Pick<RawNewsItem, "title" | "excerpt" | "categoryHint">,
  canonical: string,
  source: ClassifySourceContext,
): ClassifyResult {
  if (source.categoryExclusive && source.category) {
    return { category: source.category, reason: "source" };
  }

  if (item.categoryHint) {
    return { category: item.categoryHint, reason: "hint" };
  }

  const hostCategory = registrableSuffixMatch(hostOf(canonical));
  if (hostCategory) return { category: hostCategory, reason: "host" };

  const haystack = `${item.title} ${item.excerpt}`.toLowerCase();
  const scores: Record<NewsCategory, number> = {
    ai: 0,
    stack: 0,
    genz: 0,
    media: 0,
  };

  for (const category of TIE_ORDER) {
    for (const term of LEXICON[category]) {
      if (haystack.includes(term)) scores[category] += 1;
    }
  }

  if (source.category) scores[source.category] += 2;

  const best = TIE_ORDER.reduce((winner, category) =>
    scores[category] > scores[winner] ? category : winner,
  );

  if (scores[best] === 0) {
    return { category: source.category ?? "stack", reason: "fallback" };
  }

  return { category: best, reason: "lexicon" };
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

const MAX_BACKFILL_MS = 48 * 60 * 60 * 1_000;

/**
 * Feeds lie in both directions. first_seen_at alone makes the entire world new
 * the first time the collector runs; published_at alone lets an archive dump or
 * a 2001-dated feed repopulate the front page.
 */
export function effectiveAt(
  publishedAt: string | null,
  firstSeenAt: Date,
): Date {
  if (!publishedAt) return firstSeenAt;
  const published = new Date(publishedAt);
  if (Number.isNaN(published.getTime())) return firstSeenAt;
  if (published > firstSeenAt) return firstSeenAt;
  if (firstSeenAt.getTime() - published.getTime() > MAX_BACKFILL_MS) {
    return new Date(firstSeenAt.getTime() - MAX_BACKFILL_MS);
  }
  return published;
}

// ---------------------------------------------------------------------------
// Hotness
// ---------------------------------------------------------------------------

/**
 * Comments are engagement, but they are also controversy, so they never carry
 * the same weight as a vote. Sources with no counter at all return null and are
 * ranked on their editorial weight instead — a model release does not need
 * upvotes to be the most important thing on the page.
 */
export function attentionOf(
  family: SourceFamily,
  item: Pick<RawNewsItem, "points" | "comments" | "attentionOverride">,
): number | null {
  if (item.attentionOverride !== null) {
    return Math.max(item.attentionOverride, 0);
  }
  const points = item.points ?? 0;
  const comments = item.comments ?? 0;
  switch (family) {
    case "hn":
      return points + 0.5 * comments;
    case "reddit":
      return points + 0.4 * comments;
    case "lobsters":
    case "devto":
      return points + 0.5 * comments;
    default:
      return null;
  }
}

export const HALF_LIFE_HOURS: Record<SourceFamily, number> = {
  hn: 5,
  reddit: 4,
  lobsters: 6,
  devto: 12,
  github: 24,
  hf: 36,
  rss: 8,
};

export const CATEGORY_HALF_LIFE_MULTIPLIER: Record<NewsCategory, number> = {
  ai: 1.3,
  stack: 1.5,
  genz: 0.7,
  // A video stays worth watching longer than a headline stays worth reading.
  media: 2.0,
};

/** Damps percentage growth on tiny counters: 2 to 6 upvotes is not a story. */
export const GROWTH_PRIOR: Record<SourceFamily, number> = {
  hn: 10,
  reddit: 25,
  lobsters: 8,
  devto: 8,
  github: 5,
  hf: 2,
  rss: 1,
};

/** Roughly the growth rate of an item that is visibly climbing, in nats/hour. */
const VELOCITY_REFERENCE = 0.15;

const EDITORIAL_BASE = 1;

export function halfLifeFor(family: SourceFamily, category: NewsCategory) {
  return HALF_LIFE_HOURS[family] * CATEGORY_HALF_LIFE_MULTIPLIER[category];
}

/**
 * Null rather than zero when there is no previous snapshot. Scoring a
 * first-seen item as zero velocity would weight 40% of its score against it and
 * keep new items permanently out of a feed whose entire job is newness.
 */
export function velocityOf(
  family: SourceFamily,
  current: number,
  previous: number | null,
  hoursBetween: number,
): number | null {
  if (previous === null || hoursBetween < 0.25) return null;
  const prior = GROWTH_PRIOR[family];
  // APIs serve cached values and can report a lower count than the last poll.
  const clamped = Math.max(current, previous);
  return Math.log((clamped + prior) / (previous + prior)) / hoursBetween;
}

export interface HotnessInput {
  attention: number | null;
  /** Median of ln(1 + attention) for this source, over its recent history. */
  sourceMedianLogAttention: number | null;
  velocity: number | null;
  weight: number;
}

/**
 * Time-independent by construction. The decay belongs at read time — a stored
 * score that has now() baked into it is wrong the moment it is written.
 */
export function hotnessOf({
  attention,
  sourceMedianLogAttention,
  velocity,
  weight,
}: HotnessInput): number {
  const relative =
    attention === null
      ? EDITORIAL_BASE
      : Math.log1p(attention) / Math.max(sourceMedianLogAttention ?? 0, 0.5);

  const blended =
    velocity === null
      ? relative
      : 0.6 * relative +
        0.4 * Math.min(Math.max(velocity / VELOCITY_REFERENCE, -1), 3);

  return Math.max(blended, 0) * weight;
}

/** Applied at read time, on both the collector's side and the browser's. */
export function decayedHotness(
  hotness: number,
  effective: Date,
  halfLifeHours: number,
  now: Date,
): number {
  const ageHours = (now.getTime() - effective.getTime()) / 3_600_000;
  if (ageHours <= 0) return hotness;
  return hotness * Math.exp((-Math.LN2 * ageHours) / halfLifeHours);
}

export async function contentHash(item: RawNewsItem): Promise<string> {
  const parts = [
    item.title,
    item.excerpt,
    String(item.points ?? ""),
    String(item.comments ?? ""),
    String(item.attentionOverride ?? ""),
  ].join("\u0000");
  return await urlKey(parts);
}
