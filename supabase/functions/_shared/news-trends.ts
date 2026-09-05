// Turning a wall of articles into the handful of keywords they are actually
// about, and turning Google's trending feed into the same shape.
//
// Free of I/O, like news-rank.ts and for the same two reasons: the rules can be
// tested directly, and a version bump can re-derive every keyword from stored
// items without refetching anything or paying a model.

import {
  canonicalizeUrl,
  decayedHotness,
  type NewsCategory,
} from "./news-rank.ts";

export const TRENDS_PARSER_VERSION = "trends-2026-08-27-v1";

/**
 * A keyword's number means different things depending on where it came from,
 * and the two must never be formatted the same way. Google reports people who
 * searched; derived keywords report articles that mentioned. Showing "200" and
 * "7" side by side without saying which is which would be a lying dashboard.
 */
export type TrendOrigin = "search" | "coverage";

export interface TrendCoverage {
  title: string;
  url: string;
  canonicalUrl: string;
  sourceName: string;
  publishedAt: string | null;
  /** Set when the coverage row is one of our own collected items. */
  itemId: string | null;
}

export interface ParsedTrend {
  term: string;
  approxTraffic: number | null;
  pictureUrl: string | null;
  publishedAt: string | null;
  coverage: TrendCoverage[];
}

// ---------------------------------------------------------------------------
// Google Trends RSS
// ---------------------------------------------------------------------------

function blockText(block: string, tag: string): string {
  const match = block.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i"),
  );
  if (!match) return "";
  return decodeEntities(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1"))
    .replace(/<[^>]+>/g, "")
    .trim();
}

function decodeEntities(value: string) {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * "200+" and "20K+" and "1M+" are the shapes Google publishes. The plus is the
 * point — these are floors, not counts — so the number is stored as the floor
 * and the UI says "200+" rather than pretending to precision.
 */
export function parseApproxTraffic(value: string): number | null {
  const match = value.trim().match(/^([\d,.]+)\s*([KM]?)\+?$/i);
  if (!match) return null;

  const digits = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(digits)) return null;

  const scale = match[2].toUpperCase();
  if (scale === "K") return Math.round(digits * 1_000);
  if (scale === "M") return Math.round(digits * 1_000_000);
  return Math.round(digits);
}

/**
 * A sibling to parseFeed rather than a change to it.
 *
 * This feed is the only one carrying Google's `ht:` extensions, and it breaks
 * every assumption the generic parser makes: <link> is the feed's own URL
 * repeated on every item, <description> is empty, and the payload that matters
 * hangs off repeated <ht:news_item> children. Teaching parseFeed about all that
 * would put one feed's oddities in every other feed's path.
 */
export function parseTrendsFeed(xml: string): ParsedTrend[] {
  const items = xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? [];

  return items.flatMap((block) => {
    const term = blockText(block, "title");
    if (!term) return [];

    const newsBlocks =
      block.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) ?? [];

    const coverage = newsBlocks.flatMap((entry) => {
      const url = blockText(entry, "ht:news_item_url");
      const title = blockText(entry, "ht:news_item_title");
      if (!url || !title) return [];
      return [
        {
          title,
          url,
          canonicalUrl: canonicalizeUrl(url),
          sourceName: blockText(entry, "ht:news_item_source") || "Unknown",
          publishedAt: null,
          itemId: null,
        },
      ];
    });

    return [
      {
        term,
        approxTraffic: parseApproxTraffic(
          blockText(block, "ht:approx_traffic"),
        ),
        pictureUrl: blockText(block, "ht:picture") || null,
        publishedAt: blockText(block, "pubDate") || null,
        coverage,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Deriving keywords from collected articles
// ---------------------------------------------------------------------------

export interface KeywordArticle {
  id: string;
  sourceId: string;
  sourceName: string;
  title: string;
  url: string;
  canonicalUrl: string;
  category: NewsCategory;
  hotness: number;
  halfLifeHours: number;
  effectiveAt: Date;
  publishedAt: string | null;
}

export interface DerivedKeyword {
  term: string;
  termKey: string;
  category: NewsCategory;
  score: number;
  articleIds: string[];
  sourceIds: string[];
}

/**
 * A keyword needs corroboration to exist at all. One article mentioning
 * something is that article, not a trend, and without this floor every
 * title-cased headline fragment becomes a keyword.
 */
export const MIN_ARTICLES_PER_KEYWORD = 2;

/** Repo names too generic to stand alone: "query" is not a keyword, TanStack/query is. */
const GENERIC_REPO_NAMES = new Set([
  "query",
  "core",
  "api",
  "docs",
  "www",
  "app",
  "cli",
  "sdk",
  "web",
  "server",
  "client",
  "ui",
  "lib",
  "utils",
  "common",
  "main",
  "test",
  "demo",
  "example",
  "website",
  "blog",
  "spec",
  "tools",
  "cookbook",
  "examples",
  "starter",
  // "node" alone reads as a graph node as readily as the runtime.
  "node",
  "go",
  "rust",
  "python",
  "java",
  "swift",
  "kit",
  "runtime",
]);

/**
 * Model cards multiply along size, quantization and tuning axes:
 * Ornith-1.5-9B, Ornith-1.5-9B-GGUF and Ornith-1.5-35B-A3B are one model. The
 * suffixes are stripped so they become one keyword rather than three cards.
 */
const MODEL_VARIANT_SUFFIX =
  /[-_](?:GGUF|AWQ|GPTQ|EXL2|MLX|FP8|INT4|INT8|BF16|Instruct|Chat|Base|IT|SFT|DPO|RL|Preview|Thinking|MoT|MoE|mini|small|large|tiny|XL|A\d+B|\d+(?:\.\d+)?B|\d{4})$/i;

/** Words that make a capitalised phrase a sentence fragment rather than a name. */
const PHRASE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "can",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "i",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "may",
  "my",
  "no",
  "not",
  "of",
  "on",
  "or",
  "our",
  "out",
  "over",
  "so",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "to",
  "up",
  "us",
  "was",
  "we",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
  "your",
  "new",
  "now",
  "why",
  "all",
  "more",
  "most",
  "some",
  "any",
  "show",
  "ask",
  "tell",
  "using",
  "used",
  "use",
  "make",
  "made",
  "get",
  "got",
  "why",
  "part",
  "version",
  "chapter",
  "figure",
  "table",
  "section",
  "issue",
  "update",
  "release",
  "released",
  "introducing",
  "announcing",
  "building",
  "built",
  "why",
  "day",
  "week",
  "year",
  "today",
  "first",
  "last",
  "next",
  "best",
  "top",
  "good",
  "great",
  "real",
  "own",
  "one",
  "two",
  "three",
]);

/** Leading words that turn a version token into a sentence, not a product. */
const VERSION_LEAD_STOPWORDS = new Set([
  "part",
  "version",
  "chapter",
  "figure",
  "table",
  "section",
  "issue",
  "day",
  "week",
  "year",
  "top",
  "no",
  "vol",
  "step",
  "phase",
  "round",
  "q",
  "level",
]);

/**
 * Unicode dashes are the quiet killer here. OpenAI's own posts ship
 * "GPT‑5.6" with a non-breaking hyphen while Hacker News carries
 * "GPT-5.6" with an ASCII one; untouched, those are two keywords that never
 * merge and each sit below the corroboration floor.
 */
export function normalizeDashes(value: string) {
  return value.replace(/[‐-―−]/g, "-");
}

export function keywordKey(term: string) {
  return normalizeDashes(term)
    .toLowerCase()
    .replace(/[^a-z0-9À-ỹ./+#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function foldModelVariants(name: string) {
  let folded = name;
  // Repeatedly, because Ornith-1.5-35B-A3B carries two suffixes.
  for (let pass = 0; pass < 3; pass += 1) {
    const next = folded.replace(MODEL_VARIANT_SUFFIX, "");
    if (next === folded) break;
    folded = next;
  }
  return folded;
}

/**
 * Rule 1: the entity the URL already names.
 *
 * Read off the raw URL rather than canonical_url, for two reasons the stored
 * rows make plain. A release URL keeps its whole path — the entity rule in
 * news-rank.ts stops at a bare repo, so
 * github.com/ggml-org/llama.cpp/releases/tag/b10632 never collapses to
 * `github:ggml-org/llama.cpp`. And the Hugging Face rule lowercases, which
 * would put "qwen3.8-27b" on the card instead of "Qwen3.8-27B".
 */
function entityCandidate(article: KeywordArticle): string | null {
  const url = article.url;

  const github = url.match(
    /^https?:\/\/(?:www\.)?github\.com\/([^/?#]+)\/([^/?#]+)/i,
  );
  if (github) {
    const owner = github[1];
    const repo = github[2].replace(/\.git$/i, "");
    return GENERIC_REPO_NAMES.has(repo.toLowerCase())
      ? `${owner}/${repo}`
      : repo;
  }

  const hf = url.match(/^https?:\/\/huggingface\.co\/(.+)$/i);
  if (hf) {
    const segments = hf[1].split(/[/?#]/).filter(Boolean);
    // A paper is not a model, and its id is a number nobody searches for.
    if (segments[0] === "papers") return null;
    const owned =
      segments[0] === "datasets" || segments[0] === "spaces"
        ? segments.slice(1)
        : segments;
    if (owned.length < 2) return null;
    return foldModelVariants(owned[1]);
  }

  return null;
}

/**
 * Rule 2: product tokens carrying a version — GPT-5.6, Qwen3.8, GLM-5.3-Flash.
 *
 * The matched text is kept verbatim rather than rebuilt from its groups.
 * Rebuilding turns "Qwen3.8" into "Qwen-3.8", which is a keyword nobody writes
 * and which therefore never merges with the way everyone else spells it.
 */
function versionCandidates(title: string): string[] {
  const normalized = normalizeDashes(title);
  const found: string[] = [];

  const pattern =
    /\b([A-Z][A-Za-z]{1,14}(?:\.[a-z]{2,4})?)[-\s]?(\d+(?:\.\d+){0,2})(-[A-Z][A-Za-z]{1,10})?\b/g;

  for (const match of normalized.matchAll(pattern)) {
    const [whole, lead, version] = match;
    if (VERSION_LEAD_STOPWORDS.has(lead.toLowerCase())) continue;
    // A bare year is a date, not a product version.
    if (/^(?:19|20)\d{2}$/.test(version)) continue;
    found.push(whole.trim());
  }

  return found;
}

/**
 * Common nouns that a title-cased headline capitalises without them naming
 * anything. Only consulted for single words, where there is no second word to
 * disambiguate.
 */
const SINGLE_WORD_STOPWORDS = new Set([
  "ai",
  "model",
  "models",
  "users",
  "user",
  "time",
  "data",
  "code",
  "work",
  "team",
  "teams",
  "world",
  "people",
  "state",
  "post",
  "posts",
  "story",
  "guide",
  "report",
  "results",
  "access",
  "price",
  "pricing",
  "speed",
  "mode",
  "support",
  "tool",
  "tools",
  "agent",
  "agents",
  "system",
  "systems",
  "api",
  "app",
  "apps",
  "web",
  "site",
  "cloud",
  "open",
  "source",
  "learning",
  "memory",
  "search",
  "chat",
  "video",
  "image",
  "images",
  "text",
  "training",
  "research",
  "company",
  "startup",
  "engineering",
  "developers",
  "developer",
  "software",
  "internet",
  "security",
  "privacy",
  "future",
  "history",
  "science",
  "business",
  // Research-paper vocabulary. arXiv is the loudest source in the corpus and
  // its titles are built from these — "Efficient Multimodal Reasoning for
  // Generation" is four of them in a row. Every one passed the corroboration
  // floor easily and told a reader nothing. Product names keep their own
  // shape and survive: MCP, RAG, Codex, ChatGPT, Qwen3.8 are all still here.
  "llm",
  "llms",
  "gpt",
  "generation",
  "generative",
  "reasoning",
  "multimodal",
  "coding",
  "efficient",
  "efficiency",
  "beyond",
  "harness",
  "benchmark",
  "benchmarks",
  "evaluation",
  "eval",
  "method",
  "methods",
  "approach",
  "dataset",
  "datasets",
  "scaling",
  "alignment",
  "inference",
  "embedding",
  "embeddings",
  "transformer",
  "transformers",
  "diffusion",
  "robust",
  "robustness",
  "adaptive",
  "dynamic",
  "unified",
  "novel",
  "towards",
  "understanding",
  "reinforcement",
  "supervised",
  "prompt",
  "prompting",
  "token",
  "tokens",
  "context",
  "attention",
  "vision",
  "language",
  "visual",
  "audio",
  "speech",
  "policy",
  // "Show HN:" and "Ask HN:" lead a large share of Hacker News titles.
  "hn",
  // Release-note furniture: "Version 26.8.0 (Current)" is not a keyword.
  "current",
  "latest",
  "stable",
  "beta",
  "alpha",
  "preview",
  "canary",
  "lts",
  "performance",
  "analysis",
  "intelligence",
  "announcement",
  "changelog",
]);

/**
 * A candidate and the corroboration it must reach.
 *
 * Most candidates need two articles. A bare capitalised word needs three,
 * because in a title-cased headline every word is capitalised and two
 * coincidental matches are cheap. Distinctively shaped names — ChatGPT's
 * internal capital, MCP's all-caps, llama.cpp's dot — carry their own evidence
 * that they name something, so they stay at two.
 */
interface Candidate {
  term: string;
  minArticles: number;
}

function isDistinctivelyShaped(word: string) {
  return (
    /[a-z][A-Z]/.test(word) || /^[A-Z0-9]{2,}$/.test(word) || /[.+#]/.test(word)
  );
}

/** Rule 3: proper names, one to three words — Hugging Face, ChatGPT Work, MCP. */
function phraseCandidates(title: string): Candidate[] {
  const words = normalizeDashes(title).split(/\s+/);
  const found: Candidate[] = [];

  const clean = (word: string) => word.replace(/^[^\w]+|[^\w.+#-]+$/g, "");
  const isProper = (word: string) =>
    /^[A-Z][A-Za-z0-9.+#-]{1,}$/.test(word) &&
    !PHRASE_STOPWORDS.has(word.toLowerCase());

  for (let start = 0; start < words.length; start += 1) {
    for (const size of [3, 2]) {
      const slice = words.slice(start, start + size).map(clean);
      if (slice.length < size) continue;
      if (!slice.every(isProper)) continue;
      // "GPT-5.6 Sol" would otherwise stand beside "GPT-5.6" as its own card.
      // A phrase led by a version token is that version wearing an adjective.
      if (/\d/.test(slice[0])) continue;
      found.push({
        term: slice.join(" "),
        minArticles: MIN_ARTICLES_PER_KEYWORD,
      });
    }

    const single = clean(words[start]);
    if (!isProper(single) || single.length < 2) continue;
    if (/\d/.test(single)) continue;
    if (SINGLE_WORD_STOPWORDS.has(single.toLowerCase())) continue;
    // "Sol" and "Luna" are what follows "GPT-5.6", never what precedes it.
    // A word that only ever trails a version token is that release's
    // adjective, and on its own it names nothing.
    if (start > 0 && /\d/.test(clean(words[start - 1]))) continue;
    // A bare capitalised word is only a keyword when its shape says it names
    // something: ChatGPT's internal capital, MCP's all-caps, llama.cpp's dot.
    //
    // Plain ones were tried with a higher corroboration floor and a stopword
    // list, and both lost. On the real corpus the top AI keywords came back as
    // Optimization, Scalable, Depth, Runtime, Verifiable, Emergent — arXiv
    // title vocabulary, every one clearing the floor honestly and telling a
    // reader nothing. Fifty stopwords later fourteen of the top twenty-four
    // were still bare words, because in a title-cased headline every word is
    // capitalised and there is nothing left to distinguish a name from an
    // adjective. Two words that agree are evidence; one capital letter is not.
    if (!isDistinctivelyShaped(single)) continue;
    found.push({ term: single, minArticles: MIN_ARTICLES_PER_KEYWORD });
  }

  return found;
}

interface Bucket {
  term: string;
  articles: Map<string, KeywordArticle>;
  sources: Set<string>;
  /** The easiest floor any rule asked for — a URL entity needs no extra proof. */
  minArticles: number;
}

/**
 * Repetition inside one source compresses; distinct sources add.
 *
 * This is the whole ranking argument, and the naive sum gets it backwards.
 * Summing decayed hotness linearly made seven `llama.cpp b106xx` rows from one
 * release bot outscore three separate outlets covering one story — which is
 * precisely the noise this feature exists to remove. A bot publishing all day
 * is one source being busy, not seven independent signals.
 *
 * So each source's articles are summed and then passed through log1p, which
 * saturates: its second release is worth much less than its first, and its
 * seventh barely registers. Sources are then added across, and corroboration
 * takes a further multiplier on top.
 */
export function keywordScore(articles: KeywordArticle[], now: Date) {
  const bySource = new Map<string, number>();

  for (const item of articles) {
    const decayed = decayedHotness(
      item.hotness,
      item.effectiveAt,
      item.halfLifeHours,
      now,
    );
    bySource.set(item.sourceId, (bySource.get(item.sourceId) ?? 0) + decayed);
  }

  const heat = [...bySource.values()].reduce(
    (total, sourceHeat) => total + Math.log1p(sourceHeat),
    0,
  );

  return heat * (1 + Math.log1p(Math.max(bySource.size - 1, 0)));
}

export function deriveKeywords(
  articles: KeywordArticle[],
  now = new Date(),
): DerivedKeyword[] {
  const buckets = new Map<string, Bucket>();

  const add = (
    term: string,
    article: KeywordArticle,
    minArticles = MIN_ARTICLES_PER_KEYWORD,
  ) => {
    const trimmed = term.trim();
    if (trimmed.length < 2 || trimmed.length > 60) return;
    const key = keywordKey(trimmed);
    if (!key || key.length < 2) return;
    if (PHRASE_STOPWORDS.has(key)) return;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        term: trimmed,
        articles: new Map(),
        sources: new Set(),
        minArticles,
      };
      buckets.set(key, bucket);
    }
    bucket.minArticles = Math.min(bucket.minArticles, minArticles);
    bucket.articles.set(article.id, article);
    bucket.sources.add(article.sourceId);
  };

  for (const article of articles) {
    const entity = entityCandidate(article);
    if (entity) add(entity, article);
    for (const candidate of versionCandidates(article.title)) {
      add(candidate, article);
    }
    for (const candidate of phraseCandidates(article.title)) {
      add(candidate.term, article, candidate.minArticles);
    }
  }

  const derived: DerivedKeyword[] = [];

  for (const [termKey, bucket] of buckets) {
    const articleList = [...bucket.articles.values()];
    if (articleList.length < bucket.minArticles) continue;

    // The category most of its articles sit in; ties fall to the hottest one,
    // so a keyword never lands in a tab by alphabetical accident.
    const tally: Record<string, number> = {};
    for (const article of articleList) {
      tally[article.category] = (tally[article.category] ?? 0) + 1;
    }
    const hottest = articleList.reduce((best, article) =>
      article.hotness > best.hotness ? article : best,
    );
    const category = (Object.entries(tally).sort(
      (left, right) =>
        right[1] - left[1] || (left[0] === hottest.category ? -1 : 1),
    )[0]?.[0] ?? hottest.category) as NewsCategory;

    derived.push({
      term: bucket.term,
      termKey,
      category,
      score: keywordScore(articleList, now),
      articleIds: articleList.map((article) => article.id),
      sourceIds: [...bucket.sources],
    });
  }

  return dropSubsumed(derived).sort((left, right) => right.score - left.score);
}

/** How much of a bare word's coverage a longer name must own to absorb it. */
const SUBSUMPTION_OVERLAP = 0.6;

/**
 * "Intelligence" beside "Intelligence Age" is one keyword shown twice, and the
 * shorter of the two is the one that names nothing. A multi-word keyword
 * absorbs a single-word one when it contains that word and covers most of the
 * same articles — most, not all, because the bare word also catches passing
 * mentions that are not the same story.
 */
export function dropSubsumed(keywords: DerivedKeyword[]): DerivedKeyword[] {
  const phrases = keywords.filter((entry) => entry.termKey.includes(" "));

  const withoutBareWords = keywords.filter((entry) => {
    if (entry.termKey.includes(" ")) return true;

    return !phrases.some((phrase) => {
      if (!phrase.termKey.split(" ").includes(entry.termKey)) return false;
      const covered = phrase.articleIds.filter((id) =>
        entry.articleIds.includes(id),
      ).length;
      return covered / entry.articleIds.length >= SUBSUMPTION_OVERLAP;
    });
  });

  return dropOverlappingPhrases(withoutBareWords);
}

/**
 * One label per set of articles.
 *
 * The two- and three-word windows slide, so a title where every word is
 * capitalised yields a fistful of overlapping fragments. "VoiceMem: Streaming
 * Dual-Brain Memory for Real-Time Interaction" produced five keywords —
 * "VoiceMem Streaming", "Streaming Dual-Brain", "Dual-Brain Memory",
 * "Streaming Dual-Brain Memory", "VoiceMem Streaming Dual-Brain" — every one
 * carrying the same two articles, because they are the same story cut five
 * ways.
 *
 * Phrases covering exactly the same articles are therefore one keyword, and the
 * shortest wins: it is the label most likely to appear again next week, where
 * the longer ones are this headline's phrasing and nothing else's.
 */
function dropOverlappingPhrases(keywords: DerivedKeyword[]): DerivedKeyword[] {
  const bestForArticles = new Map<string, DerivedKeyword>();

  for (const entry of keywords) {
    if (!entry.termKey.includes(" ")) continue;
    const identity = [...entry.articleIds].sort().join(",");
    const held = bestForArticles.get(identity);
    if (
      !held ||
      entry.termKey.split(" ").length < held.termKey.split(" ").length ||
      (entry.termKey.split(" ").length === held.termKey.split(" ").length &&
        entry.termKey < held.termKey)
    ) {
      bestForArticles.set(identity, entry);
    }
  }

  const kept = new Set(bestForArticles.values());
  return keywords.filter(
    (entry) => !entry.termKey.includes(" ") || kept.has(entry),
  );
}

// ---------------------------------------------------------------------------
// Terms appearing across a keyword's coverage
// ---------------------------------------------------------------------------

/**
 * Vietnamese words are multi-syllable with spaces between the syllables, so a
 * unigram split turns "giá đất" into two meaningless halves. Bigrams are
 * generated alongside unigrams and both compete on frequency, which lets the
 * real word win wherever it actually repeats.
 */
const COVERAGE_STOPWORDS = new Set([
  ...PHRASE_STOPWORDS,
  "về",
  "của",
  "và",
  "các",
  "có",
  "cho",
  "được",
  "trong",
  "người",
  "khi",
  "này",
  "đã",
  "với",
  "là",
  "những",
  "một",
  "không",
  "đến",
  "ra",
  "từ",
  "sau",
  "trên",
  "tại",
  "hôm",
  "nay",
  "vào",
  "bị",
  "để",
  "còn",
  "như",
  "vẫn",
  "vừa",
  "ahead",
  "road",
  "back",
  "down",
  "off",
  "again",
  "still",
  "just",
  "sẽ",
  "đang",
  "phải",
  "nhiều",
  "lại",
  "mới",
  "chỉ",
  "thì",
  "nếu",
  "vì",
]);

export interface CoverageTerm {
  term: string;
  weight: number;
  articleCount: number;
}

export function coverageTerms(
  titles: string[],
  exclude: string,
  limit = 8,
): CoverageTerm[] {
  const excluded = keywordKey(exclude);
  const counts = new Map<string, { term: string; articles: Set<number> }>();

  const record = (term: string, index: number) => {
    const key = keywordKey(term);
    if (!key || key.length < 2) return;
    if (key === excluded || excluded.includes(key)) return;
    if (/^\d+$/.test(key)) return;
    // Every word, not the phrase as a whole. Testing only the joined string let
    // "and the", "The Hugging" and "road ahead" through, because the bigram is
    // not itself in the list even though both its halves are — and a keyword
    // page offering "and the" as a term to explore is worse than offering
    // nothing.
    if (key.split(" ").some((word) => COVERAGE_STOPWORDS.has(word))) return;

    let entry = counts.get(key);
    if (!entry) {
      entry = { term: term.trim(), articles: new Set() };
      counts.set(key, entry);
    }
    entry.articles.add(index);
  };

  titles.forEach((title, index) => {
    const words = normalizeDashes(title)
      .split(/[^\p{L}\p{N}.+#-]+/u)
      .map((word) => word.replace(/^[.+#-]+|[.+#-]+$/g, ""))
      .filter(Boolean);

    words.forEach((word, position) => {
      if (!COVERAGE_STOPWORDS.has(keywordKey(word))) record(word, index);
      if (position + 1 < words.length) {
        record(`${word} ${words[position + 1]}`, index);
      }
    });
  });

  return (
    [...counts.values()]
      .map((entry) => ({
        term: entry.term,
        weight: entry.articles.size,
        articleCount: entry.articles.size,
      }))
      // Once is not a pattern, and a term that appears in every title is the
      // keyword restated rather than something else about it.
      .filter(
        (entry) =>
          entry.articleCount >= 2 &&
          entry.articleCount < Math.max(titles.length, 2),
      )
      .sort(
        (left, right) =>
          right.weight - left.weight || left.term.localeCompare(right.term),
      )
      .slice(0, limit)
  );
}
