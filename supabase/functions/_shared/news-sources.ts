// One connector per upstream shape, all returning the same RawNewsItem.
//
// Every endpoint here was fetched and confirmed working on 2026-08-25. The
// comments record the ones that bite, because most of them are invisible until
// a source has been silently returning nothing for a week.

import type { NewsCategory, RawNewsItem, SourceFamily } from "./news-rank.ts";
import { type ParsedTrend, parseTrendsFeed } from "./news-trends.ts";

export interface SourceDefinition {
  id: string;
  name: string;
  type: SourceType;
  family: SourceFamily;
  category: NewsCategory | null;
  categoryExclusive: boolean;
  weight: number;
  requiresSecret?: boolean;
}

export type SourceType =
  | "hn-algolia-front"
  | "hn-algolia-query"
  | "hnrss"
  | "lobsters-tag"
  | "lobsters-hot"
  | "hf-models"
  | "hf-papers"
  | "arxiv"
  | "github-trending"
  | "github-releases"
  | "devto"
  | "rss"
  | "statuspage-incidents"
  | "statuspage-summary"
  | "sec-edgar"
  | "google-trends"
  | "leetcode"
  | "youtube"
  | "reddit-atom";

const USER_AGENT = "Hub-William-News/1.0 (+https://hub-william.site)";
const REQUEST_TIMEOUT_MS = 25_000;
const MAX_BODY_BYTES = 8_000_000;

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

async function fetchWithLimit(url: string, accept: string) {
  const response = await fetch(url, {
    headers: { Accept: accept, "User-Agent": USER_AGENT },
    redirect: "follow",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  }
  const text = await response.text();
  // A hostile or merely careless source is allowed to be enormous; the parser
  // is not allowed to find out the hard way.
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) : text;
}

async function fetchJson(url: string) {
  return JSON.parse(await fetchWithLimit(url, "application/json")) as unknown;
}

async function fetchXml(url: string) {
  return await fetchWithLimit(
    url,
    "application/xml,text/xml,application/atom+xml,text/plain",
  );
}

// ---------------------------------------------------------------------------
// Feed parsing
// ---------------------------------------------------------------------------

const HTML_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#039": "'",
};

function decodeEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    const named = HTML_ENTITIES[code.toLowerCase()];
    if (named) return named;
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const point = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    if (code.startsWith("#")) {
      const point = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : match;
    }
    return match;
  });
}

function stripTags(value: string) {
  return decodeEntities(value.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** Handles `<tag>`, `<tag attr="…">` and CDATA, which RSS uses interchangeably. */
function tagText(xml: string, tag: string): string {
  const match = xml.match(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"),
  );
  if (!match) return "";
  return decodeEntities(
    match[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, ""),
  ).trim();
}

function tagAttribute(xml: string, tag: string, attribute: string): string {
  const match = xml.match(
    new RegExp(`<${tag}\\s[^>]*${attribute}=["']([^"']+)["']`, "i"),
  );
  return match ? decodeEntities(match[1]) : "";
}

export interface FeedEntry {
  id: string;
  title: string;
  link: string;
  summary: string;
  published: string | null;
  author: string | null;
}

/**
 * RSS and Atom in one pass. Atom puts the link in an attribute and the date in
 * `published` or `updated`; RSS puts both in element text. Sources move between
 * the two without warning — Vercel's `/changelog/rss.xml` is a 308 to an Atom
 * feed — so the parser handles whichever arrives.
 */
export function parseFeed(xml: string): FeedEntry[] {
  const blocks = [
    ...(xml.match(/<item(?:\s[^>]*)?>[\s\S]*?<\/item>/gi) ?? []),
    ...(xml.match(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi) ?? []),
  ];

  return blocks.flatMap((block) => {
    const title = stripTags(tagText(block, "title"));
    const link =
      tagText(block, "link") ||
      tagAttribute(block, "link", "href") ||
      tagText(block, "guid") ||
      tagText(block, "id");
    if (!title || !link) return [];

    const summary = stripTags(
      tagText(block, "description") ||
        tagText(block, "summary") ||
        tagText(block, "content:encoded") ||
        tagText(block, "content"),
    );

    const published =
      tagText(block, "pubDate") ||
      tagText(block, "published") ||
      tagText(block, "updated") ||
      tagText(block, "dc:date") ||
      null;

    const author =
      stripTags(tagText(block, "dc:creator")) ||
      stripTags(tagText(block, "author")) ||
      null;

    return [
      {
        id: tagText(block, "guid") || tagText(block, "id") || link,
        title,
        link,
        summary: summary.slice(0, 600),
        published,
        author: author || null,
      },
    ];
  });
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function baseItem(
  sourceId: string,
  fields: Partial<RawNewsItem> &
    Pick<RawNewsItem, "externalId" | "url" | "title">,
): RawNewsItem {
  return {
    sourceId,
    author: null,
    excerpt: "",
    publishedAt: null,
    points: null,
    comments: null,
    attentionOverride: null,
    categoryHint: null,
    payload: {},
    ...fields,
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Kept in step with the seed rows in the create_news migration. */
export const newsSources: SourceDefinition[] = [
  {
    id: "hn-frontpage",
    name: "Hacker News front page",
    type: "hn-algolia-front",
    family: "hn",
    category: null,
    categoryExclusive: false,
    weight: 1.0,
  },
  {
    id: "hn-ai-watch",
    name: "Hacker News AI watch",
    type: "hn-algolia-query",
    family: "hn",
    category: "ai",
    categoryExclusive: false,
    weight: 0.8,
  },
  {
    id: "lobsters-ai",
    name: "Lobsters AI",
    type: "lobsters-tag",
    family: "lobsters",
    category: "ai",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "hf-models",
    name: "Hugging Face trending models",
    type: "hf-models",
    family: "hf",
    category: "ai",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "hf-papers",
    name: "Hugging Face daily papers",
    type: "hf-papers",
    family: "hf",
    category: "ai",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "openai-news",
    name: "OpenAI news",
    type: "rss",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "deepmind-blog",
    name: "Google DeepMind blog",
    type: "rss",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "mistral-news",
    name: "Mistral AI news",
    type: "rss",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "anthropic-news",
    name: "Anthropic news (community mirror)",
    type: "rss",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "openai-status",
    name: "OpenAI status",
    type: "statuspage-incidents",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "claude-status",
    name: "Claude status",
    type: "statuspage-summary",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "arxiv-ai",
    name: "arXiv cs.AI and cs.CL",
    type: "arxiv",
    family: "rss",
    category: "ai",
    categoryExclusive: true,
    weight: 0.5,
  },
  {
    id: "github-trending-ai",
    name: "GitHub trending (AI)",
    type: "github-trending",
    family: "github",
    category: "ai",
    categoryExclusive: false,
    weight: 0.8,
  },
  {
    id: "hn-stack",
    name: "Hacker News 100+ points",
    type: "hnrss",
    family: "hn",
    category: null,
    categoryExclusive: false,
    weight: 1.0,
  },
  {
    id: "lobsters-hot",
    name: "Lobsters hottest",
    type: "lobsters-hot",
    family: "lobsters",
    category: null,
    categoryExclusive: false,
    weight: 0.9,
  },
  {
    id: "devto-top",
    name: "dev.to top of the week",
    type: "devto",
    family: "devto",
    category: "stack",
    categoryExclusive: false,
    weight: 0.6,
  },
  {
    id: "github-releases",
    name: "GitHub releases",
    type: "github-releases",
    family: "github",
    category: null,
    categoryExclusive: false,
    weight: 1.0,
  },
  {
    id: "supabase-blog",
    name: "Supabase blog",
    type: "rss",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "vercel-changelog",
    name: "Vercel changelog",
    type: "rss",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 0.7,
  },
  {
    id: "techcrunch-layoffs",
    name: "TechCrunch layoffs",
    type: "rss",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "techcrunch-hiring",
    name: "TechCrunch hiring",
    type: "rss",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "verge-tech",
    name: "The Verge tech",
    type: "rss",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "leetcode-daily",
    name: "LeetCode daily and contests",
    type: "leetcode",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 0.6,
  },
  {
    id: "sec-restructuring",
    name: "SEC 8-K restructuring filings",
    type: "sec-edgar",
    family: "rss",
    category: "stack",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "trends-vn",
    name: "Google Trends Vietnam",
    type: "google-trends",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "trends-us",
    name: "Google Trends United States",
    type: "google-trends",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "kenh14-hoc-duong",
    name: "Kênh14 học đường",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "kenh14-doi-song",
    name: "Kênh14 đời sống",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "tuoitre-nhip-song-tre",
    name: "Tuổi Trẻ nhịp sống trẻ",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "thanhnien-gioi-tre",
    name: "Thanh Niên giới trẻ",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "vnexpress-doi-song",
    name: "VnExpress đời sống",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "merriam-wotd",
    name: "Merriam-Webster word of the day",
    type: "rss",
    family: "rss",
    category: "genz",
    categoryExclusive: true,
    weight: 0.5,
  },
  // MEDIA. Channel ids live in YOUTUBE_CHANNELS below, resolved once by hand
  // from each channel's own canonical link.
  {
    id: "yt-fireship",
    name: "Fireship",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 1.0,
  },
  {
    id: "yt-theo",
    name: "Theo - t3.gg",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "yt-primeagen",
    name: "ThePrimeagen",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 0.9,
  },
  {
    id: "yt-mkbhd",
    name: "Marques Brownlee",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 0.8,
  },
  {
    id: "yt-networkchuck",
    name: "NetworkChuck",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 0.7,
  },
  {
    id: "yt-arjancodes",
    name: "ArjanCodes",
    type: "youtube",
    family: "rss",
    category: "media",
    categoryExclusive: true,
    weight: 0.7,
  },
  // reddit-genz is deliberately absent. Its feeds answer 200 from a laptop and
  // 403 from Supabase's edge — Reddit blocks datacenter ranges regardless of
  // User-Agent — so it failed on every one of its runs and never stored a row.
  // The connector below is kept: it works from anywhere Reddit will talk to,
  // and re-adding the registry entry is the whole change if that day comes.
];

const RSS_ENDPOINTS: Record<string, string> = {
  "openai-news": "https://openai.com/news/rss.xml",
  "deepmind-blog": "https://deepmind.google/blog/rss.xml",
  "mistral-news": "https://mistral.ai/news/rss",
  "anthropic-news":
    "https://raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml",
  "supabase-blog": "https://supabase.com/rss.xml",
  "vercel-changelog": "https://vercel.com/atom",
  "techcrunch-layoffs": "https://techcrunch.com/tag/layoffs/feed/",
  "techcrunch-hiring": "https://techcrunch.com/tag/hiring/feed/",
  "verge-tech": "https://www.theverge.com/rss/tech/index.xml",
  "kenh14-hoc-duong": "https://kenh14.vn/hoc-duong.rss",
  "kenh14-doi-song": "https://kenh14.vn/doi-song.rss",
  "tuoitre-nhip-song-tre": "https://tuoitre.vn/rss/nhip-song-tre.rss",
  "thanhnien-gioi-tre": "https://thanhnien.vn/rss/gioi-tre.rss",
  "vnexpress-doi-song": "https://vnexpress.net/rss/doi-song.rss",
  "merriam-wotd": "https://www.merriam-webster.com/wotd/feed/rss2",
};

const GOOGLE_TRENDS_ENDPOINTS: Record<string, string> = {
  "trends-vn": "https://trends.google.com/trending/rss?geo=VN",
  "trends-us": "https://trends.google.com/trending/rss?geo=US",
};

/** The vendors worth a dedicated Algolia query rather than lexicon luck. */
const HN_WATCH_TERMS = [
  "anthropic",
  "openai",
  "claude code",
  "gpt-5",
  "gemini",
  "deepmind",
  "mistral",
  "llm agent",
  "benchmark",
  "model context protocol",
];

/** Releases are the highest-signal Stack source and cost nothing to watch. */
const RELEASE_REPOS = [
  "facebook/react",
  "vercel/next.js",
  "vitejs/vite",
  "oven-sh/bun",
  "denoland/deno",
  "microsoft/TypeScript",
  "tailwindlabs/tailwindcss",
  "supabase/supabase",
  "remix-run/react-router",
  "postgres/postgres",
  "nodejs/node",
  "TanStack/query",
  "langchain-ai/langchain",
  "ollama/ollama",
  "ggml-org/llama.cpp",
];

const REDDIT_SUBREDDITS = [
  "GenZ",
  "OutOfTheLoop",
  "teenagers",
  "Zoomers",
  "VietNam",
];

const DEVTO_TAGS = ["typescript", "react", "webdev", "postgres"];

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

interface AlgoliaHit {
  objectID: string;
  title: string | null;
  url: string | null;
  points: number | null;
  num_comments: number | null;
  created_at: string | null;
  author: string | null;
  story_text: string | null;
}

function algoliaItems(sourceId: string, hits: AlgoliaHit[]): RawNewsItem[] {
  return hits.flatMap((hit) => {
    if (!hit.title) return [];
    const discussion = `https://news.ycombinator.com/item?id=${hit.objectID}`;
    return [
      baseItem(sourceId, {
        externalId: hit.objectID,
        // Ask HN and other self-posts have no external URL; the thread is the
        // story, and it is also the only key dedup can match them on.
        url: hit.url ?? discussion,
        title: hit.title,
        author: hit.author,
        excerpt: (hit.story_text ?? "").slice(0, 600),
        publishedAt: toIso(hit.created_at),
        points: hit.points ?? 0,
        comments: hit.num_comments ?? 0,
        payload: { objectID: hit.objectID, discussion },
      }),
    ];
  });
}

async function fetchHnFrontPage(source: SourceDefinition) {
  const payload = (await fetchJson(
    "https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=50",
  )) as { hits?: AlgoliaHit[] };
  return algoliaItems(source.id, payload.hits ?? []);
}

async function fetchHnWatch(source: SourceDefinition) {
  const since = Math.floor(Date.now() / 1000) - 3 * 24 * 60 * 60;
  const items: RawNewsItem[] = [];
  const seen = new Set<string>();

  for (const term of HN_WATCH_TERMS) {
    // The comparator must be percent-encoded. An unencoded '>' is accepted and
    // then silently ignored, which reads as "this vendor had no news".
    const url =
      `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(term)}` +
      `&tags=story&numericFilters=created_at_i%3E${since},points%3E5&hitsPerPage=25`;
    const payload = (await fetchJson(url)) as { hits?: AlgoliaHit[] };
    for (const item of algoliaItems(source.id, payload.hits ?? [])) {
      if (seen.has(item.externalId)) continue;
      seen.add(item.externalId);
      items.push(item);
    }
  }
  return items;
}

async function fetchHnRss(source: SourceDefinition) {
  const xml = await fetchXml("https://hnrss.org/frontpage?points=100&count=50");
  return parseFeed(xml).map((entry) =>
    baseItem(source.id, {
      externalId: entry.id,
      url: entry.link,
      title: entry.title,
      author: entry.author,
      excerpt: entry.summary,
      publishedAt: toIso(entry.published),
      payload: { guid: entry.id },
    }),
  );
}

interface LobstersStory {
  short_id: string;
  title: string;
  url: string;
  score: number;
  comment_count: number;
  created_at: string;
  short_id_url: string;
  description_plain?: string;
  submitter_user?: string | { username?: string };
  tags?: string[];
}

function lobstersUser(value: LobstersStory["submitter_user"]) {
  if (!value) return null;
  return typeof value === "string" ? value : (value.username ?? null);
}

async function fetchLobsters(source: SourceDefinition, endpoint: string) {
  const stories = (await fetchJson(endpoint)) as LobstersStory[];
  return stories.map((story) =>
    baseItem(source.id, {
      externalId: story.short_id,
      url: story.url || story.short_id_url,
      title: story.title,
      author: lobstersUser(story.submitter_user),
      excerpt: (story.description_plain ?? "").slice(0, 600),
      publishedAt: toIso(story.created_at),
      // A Lobsters score is upvotes minus downvotes and can go negative.
      points: Math.max(story.score ?? 0, 0),
      comments: story.comment_count ?? 0,
      payload: { tags: story.tags ?? [], discussion: story.short_id_url },
    }),
  );
}

interface HuggingFaceModel {
  id: string;
  author?: string;
  trendingScore?: number;
  likes?: number;
  downloads?: number;
  createdAt?: string;
  lastModified?: string;
  pipeline_tag?: string;
  tags?: string[];
}

async function fetchHuggingFaceModels(source: SourceDefinition) {
  const models = (await fetchJson(
    "https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=50&full=true",
  )) as HuggingFaceModel[];

  const seenBase = new Set<string>();

  return models.flatMap((model) => {
    // Trending is dominated by quantisation mirrors of one release. The
    // base_model tag is what tells five copies of Qwen apart from five models.
    const baseTag = (model.tags ?? []).find((tag) =>
      tag.startsWith("base_model:"),
    );
    const family = baseTag
      ? baseTag.replace(/^base_model:(?:\w+:)?/, "")
      : model.id;
    if (seenBase.has(family)) return [];
    seenBase.add(family);

    return [
      baseItem(source.id, {
        externalId: model.id,
        url: `https://huggingface.co/${model.id}`,
        title: model.id,
        author: model.author ?? null,
        excerpt: [model.pipeline_tag, `${model.likes ?? 0} likes`]
          .filter(Boolean)
          .join(" · "),
        publishedAt: toIso(model.createdAt ?? null),
        attentionOverride: model.trendingScore ?? 0,
        payload: {
          likes: model.likes ?? 0,
          downloads: model.downloads ?? 0,
          pipeline_tag: model.pipeline_tag ?? null,
        },
      }),
    ];
  });
}

interface HuggingFacePaper {
  title: string;
  publishedAt?: string;
  numComments?: number;
  submittedBy?: { name?: string } | string;
  paper?: {
    id: string;
    upvotes?: number;
    summary?: string;
    githubRepo?: string;
    githubStars?: number;
  };
}

async function fetchHuggingFacePapers(source: SourceDefinition) {
  const papers = (await fetchJson(
    "https://huggingface.co/api/daily_papers?limit=50",
  )) as HuggingFacePaper[];

  return papers.flatMap((entry) => {
    const paper = entry.paper;
    if (!paper?.id) return [];
    const submitter =
      typeof entry.submittedBy === "string"
        ? entry.submittedBy
        : (entry.submittedBy?.name ?? null);

    return [
      baseItem(source.id, {
        externalId: paper.id,
        url: `https://arxiv.org/abs/${paper.id}`,
        title: entry.title,
        author: submitter,
        excerpt: (paper.summary ?? "").slice(0, 600),
        publishedAt: toIso(entry.publishedAt ?? null),
        // Upvotes are nested on `paper`; the top level only carries comments,
        // which is a reliable way to score every paper zero by accident.
        attentionOverride: paper.upvotes ?? 0,
        comments: entry.numComments ?? 0,
        payload: {
          arxivId: paper.id,
          githubRepo: paper.githubRepo ?? null,
          githubStars: paper.githubStars ?? 0,
        },
      }),
    ];
  });
}

async function fetchArxiv(source: SourceDefinition) {
  const items: RawNewsItem[] = [];
  for (const category of ["cs.AI", "cs.CL"]) {
    const xml = await fetchXml(
      `https://export.arxiv.org/api/query?search_query=cat:${category}` +
        "&sortBy=submittedDate&sortOrder=descending&max_results=40",
    );
    for (const entry of parseFeed(xml)) {
      items.push(
        baseItem(source.id, {
          externalId: entry.link,
          url: entry.link,
          title: entry.title,
          author: entry.author,
          excerpt: entry.summary,
          publishedAt: toIso(entry.published),
          categoryHint: "ai",
          payload: { arxivCategory: category },
        }),
      );
    }
  }
  return items;
}

interface TrendingRepo {
  author?: string;
  name?: string;
  url?: string;
  description?: string;
  language?: string;
  increased?: string;
  stars?: string;
}

async function fetchGithubTrending(source: SourceDefinition) {
  // GitHub publishes no trending API. This mirror is the only free source of a
  // real star delta, so it is treated as best-effort: a failure here is a
  // failed source, never a failed run.
  const repos = (await fetchJson(
    "https://githubtrending.lessx.xyz/trending?since=weekly",
  )) as TrendingRepo[];

  return repos.flatMap((repo) => {
    const full =
      repo.author && repo.name ? `${repo.author}/${repo.name}` : null;
    if (!full) return [];
    const delta = Number.parseInt(
      (repo.increased ?? "").replace(/\D/g, ""),
      10,
    );
    return [
      baseItem(source.id, {
        externalId: full,
        url: repo.url ?? `https://github.com/${full}`,
        title: full,
        author: repo.author ?? null,
        excerpt: (repo.description ?? "").slice(0, 600),
        // Lifetime stars rank a 2019 repo above everything that happened this
        // week. Only the weekly delta is a hotness signal.
        attentionOverride: Number.isFinite(delta) ? delta : 0,
        payload: { language: repo.language ?? null, stars: repo.stars ?? null },
      }),
    ];
  });
}

async function fetchGithubReleases(source: SourceDefinition) {
  const items: RawNewsItem[] = [];
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1_000;

  for (const repo of RELEASE_REPOS) {
    try {
      const xml = await fetchXml(`https://github.com/${repo}/releases.atom`);
      for (const entry of parseFeed(xml).slice(0, 5)) {
        const published = toIso(entry.published);
        if (published && new Date(published).getTime() < cutoff) continue;
        items.push(
          baseItem(source.id, {
            externalId: entry.id,
            url: entry.link,
            title: `${repo} ${entry.title}`,
            author: repo.split("/")[0],
            excerpt: entry.summary,
            publishedAt: published,
            payload: { repo },
          }),
        );
      }
    } catch {
      // One archived or renamed repository must not take the other fourteen
      // down with it.
      continue;
    }
  }
  return items;
}

interface DevtoArticle {
  id: number;
  title: string;
  url: string;
  description: string;
  published_at: string;
  public_reactions_count: number;
  comments_count: number;
  tag_list: string[];
  user?: { username?: string };
}

async function fetchDevto(source: SourceDefinition) {
  const items: RawNewsItem[] = [];
  const seen = new Set<number>();

  for (const tag of DEVTO_TAGS) {
    const articles = (await fetchJson(
      `https://dev.to/api/articles?tag=${tag}&top=7&per_page=20`,
    )) as DevtoArticle[];
    for (const article of articles) {
      if (seen.has(article.id)) continue;
      seen.add(article.id);
      items.push(
        baseItem(source.id, {
          externalId: String(article.id),
          url: article.url,
          title: article.title,
          author: article.user?.username ?? null,
          excerpt: (article.description ?? "").slice(0, 600),
          publishedAt: toIso(article.published_at),
          points: article.public_reactions_count ?? 0,
          comments: article.comments_count ?? 0,
          payload: { tags: article.tag_list ?? [] },
        }),
      );
    }
  }
  return items;
}

async function fetchRss(source: SourceDefinition) {
  const endpoint = RSS_ENDPOINTS[source.id];
  if (!endpoint)
    throw new Error(`No RSS endpoint is configured for ${source.id}.`);
  const xml = await fetchXml(endpoint);
  const cutoff = Date.now() - 21 * 24 * 60 * 60 * 1_000;

  return parseFeed(xml).flatMap((entry) => {
    const published = toIso(entry.published);
    // VnExpress serves a feed whose newest item is from 2021 and returns a
    // perfectly valid 200 while doing it. A stale feed is dropped rather than
    // trusted.
    if (published && new Date(published).getTime() < cutoff) return [];
    return [
      baseItem(source.id, {
        externalId: entry.id,
        url: entry.link,
        title: entry.title,
        author: entry.author,
        excerpt: entry.summary,
        publishedAt: published,
        payload: { guid: entry.id },
      }),
    ];
  });
}

interface StatuspageIncident {
  id: string;
  name: string;
  status: string;
  impact: string;
  shortlink?: string;
  created_at: string;
  incident_updates?: Array<{ body?: string }>;
}

function statuspageItems(
  source: SourceDefinition,
  host: string,
  incidents: StatuspageIncident[],
) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
  return incidents.flatMap((incident) => {
    const created = toIso(incident.created_at);
    if (created && new Date(created).getTime() < cutoff) return [];
    return [
      baseItem(source.id, {
        externalId: incident.id,
        url: incident.shortlink ?? `${host}/incidents/${incident.id}`,
        title: `${source.name}: ${incident.name}`,
        excerpt: (incident.incident_updates?.[0]?.body ?? "").slice(0, 600),
        publishedAt: created,
        categoryHint: "ai",
        payload: { status: incident.status, impact: incident.impact },
      }),
    ];
  });
}

async function fetchStatuspageIncidents(source: SourceDefinition) {
  // OpenAI's summary.json carries only page/status/components — asking it for
  // incidents returns undefined rather than an error, so this uses the endpoint
  // that actually has them.
  const payload = (await fetchJson(
    "https://status.openai.com/api/v2/incidents.json",
  )) as {
    incidents?: StatuspageIncident[];
  };
  return statuspageItems(
    source,
    "https://status.openai.com",
    payload.incidents ?? [],
  );
}

async function fetchStatuspageSummary(source: SourceDefinition) {
  const payload = (await fetchJson(
    "https://status.claude.com/api/v2/summary.json",
  )) as {
    incidents?: StatuspageIncident[];
  };
  return statuspageItems(
    source,
    "https://status.claude.com",
    payload.incidents ?? [],
  );
}

interface EdgarHit {
  _id: string;
  _source: {
    display_names?: string[];
    file_date?: string;
    ciks?: string[];
    file_type?: string;
  };
}

async function fetchSecEdgar(source: SourceDefinition) {
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1_000);
  const day = (date: Date) => date.toISOString().slice(0, 10);

  const payload = (await fetchJson(
    "https://efts.sec.gov/LATEST/search-index?q=%22Item%202.05%22&forms=8-K" +
      `&startdt=${day(start)}&enddt=${day(end)}`,
  )) as { hits?: { hits?: EdgarHit[] } };

  return (payload.hits?.hits ?? []).flatMap((hit) => {
    const [accession, document] = hit._id.split(":");
    const cik = hit._source.ciks?.[0]?.replace(/^0+/, "");
    if (!accession || !cik) return [];
    const company = hit._source.display_names?.[0] ?? "Unknown filer";
    return [
      baseItem(source.id, {
        externalId: hit._id,
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}/${document ?? ""}`,
        // An 8-K carrying Item 2.05 is a company committing to a restructuring
        // in a filing it is legally obliged to get right — usually days before
        // anybody reports it.
        title: `${company} filed an 8-K restructuring notice`,
        excerpt:
          "Item 2.05 — Costs Associated with Exit or Disposal Activities.",
        publishedAt: toIso(hit._source.file_date ?? null),
        categoryHint: "stack",
        payload: { accession, cik, company },
      }),
    ];
  });
}

interface LeetcodeDaily {
  date?: string;
  link?: string;
  question?: {
    title?: string;
    difficulty?: string;
    topicTags?: Array<{ name?: string }>;
  };
}

interface LeetcodeContest {
  title?: string;
  titleSlug?: string;
  startTime?: number;
  duration?: number;
}

/**
 * LeetCode has no feed, but its GraphQL endpoint answers an unauthenticated
 * POST — the only source here that is not a GET, which is why it does not go
 * through fetchJson.
 *
 * Two queries, both genuinely time-bound. The daily challenge is one item a day
 * and its topicTags are the point: "Hash Table", "Sliding Window" and friends
 * are what feed Stack keyword derivation. Upcoming contests are the same story
 * every day until they run, so their external id is the slug and dedup turns
 * the repeats into updates rather than new rows.
 *
 * The problem list is deliberately not collected. It has no newest-first sort —
 * questionList rejects sortBy — so it would return Two Sum every hour forever.
 */
async function fetchLeetcodeGraphql(query: string) {
  const response = await fetch("https://leetcode.com/graphql", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  }
  const payload = (await response.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message?: string }>;
  };
  if (payload.errors?.length) {
    throw new Error(payload.errors[0]?.message ?? "GraphQL returned an error.");
  }
  return payload.data ?? {};
}

async function fetchLeetcode(source: SourceDefinition) {
  const items: RawNewsItem[] = [];

  const daily = (await fetchLeetcodeGraphql(
    "query{activeDailyCodingChallengeQuestion{date link question{title difficulty topicTags{name}}}}",
  )) as { activeDailyCodingChallengeQuestion?: LeetcodeDaily };

  const today = daily.activeDailyCodingChallengeQuestion;
  if (today?.date && today.question?.title) {
    const tags = (today.question.topicTags ?? [])
      .flatMap((tag) => (tag.name ? [tag.name] : []))
      .join(", ");
    items.push(
      baseItem(source.id, {
        externalId: `daily:${today.date}`,
        url: `https://leetcode.com${today.link ?? ""}`,
        title: `LeetCode daily: ${today.question.title}`,
        excerpt: [today.question.difficulty, tags].filter(Boolean).join(" · "),
        publishedAt: toIso(today.date),
        categoryHint: "stack",
        payload: {
          kind: "daily",
          difficulty: today.question.difficulty ?? null,
        },
      }),
    );
  }

  const contests = (await fetchLeetcodeGraphql(
    "query{upcomingContests{title titleSlug startTime duration}}",
  )) as { upcomingContests?: LeetcodeContest[] };

  for (const contest of contests.upcomingContests ?? []) {
    if (!contest.titleSlug || !contest.title) continue;
    const startsAt =
      typeof contest.startTime === "number"
        ? new Date(contest.startTime * 1_000)
        : null;
    items.push(
      baseItem(source.id, {
        externalId: `contest:${contest.titleSlug}`,
        url: `https://leetcode.com/contest/${contest.titleSlug}`,
        title: `LeetCode ${contest.title}`,
        excerpt: startsAt
          ? `Starts ${startsAt.toISOString().replace("T", " ").slice(0, 16)} UTC.`
          : "",
        // Deliberately null. A contest starts in the future, and effectiveAt
        // would clamp that to first_seen_at anyway — saying so here is clearer
        // than letting the clamp look like an accident.
        publishedAt: null,
        categoryHint: "stack",
        payload: { kind: "contest", slug: contest.titleSlug },
      }),
    );
  }

  return items;
}

/**
 * Every YouTube channel publishes an Atom feed at
 * /feeds/videos.xml?channel_id=..., with no key and no quota. Fifteen entries,
 * which is a fortnight for most channels.
 *
 * The channel id is resolved once, by hand, from the channel's own
 * rel="canonical" link and recorded here — not looked up at runtime from the
 * @handle, because the handle page surfaces featured channels and the first UC
 * id on it is often somebody else's. Resolving that way returned "Beyond
 * Fireship" and "Theo Rants", both dormant since 2024, which would have passed
 * every reachability check and then quietly contributed nothing.
 */
const YOUTUBE_CHANNELS: Record<string, string> = {
  "yt-fireship": "UCsBjURrPoezykLs9EqgamOA",
  "yt-theo": "UCbRP3c757lWg9M-U7TyEkXA",
  "yt-primeagen": "UC8ENHE5xdFSwx71u3fDH5Xw",
  "yt-mkbhd": "UCBJycsmduvYEL83R_U4JriQ",
  "yt-networkchuck": "UC9x0AN7BWHpCDHSm9NiJFJQ",
  "yt-arjancodes": "UCVhQ2NnY5Rskt6UjCUkJ_DA",
};

async function fetchYoutube(source: SourceDefinition) {
  const channelId = YOUTUBE_CHANNELS[source.id];
  if (!channelId) {
    throw new Error(`No YouTube channel is configured for ${source.id}.`);
  }

  const xml = await fetchXml(
    `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`,
  );
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1_000;

  return parseFeed(xml).flatMap((entry) => {
    const published = toIso(entry.published);
    // A channel that has not uploaded in a month is not news, and saying so
    // here keeps a dormant one from sitting on the page forever.
    if (published && new Date(published).getTime() < cutoff) return [];
    return [
      baseItem(source.id, {
        externalId: entry.id,
        url: entry.link,
        title: entry.title,
        author: source.name,
        // The Atom feed carries the full description; a paragraph of it is
        // enough to classify and to derive keywords from.
        excerpt: entry.summary.slice(0, 400),
        publishedAt: published,
        categoryHint: "media",
        payload: { channelId },
      }),
    ];
  });
}

/** Trend sources produce keywords, not articles, and take a different path. */
export function isTrendSource(source: SourceDefinition) {
  return source.type === "google-trends";
}

export function trendGeo(source: SourceDefinition) {
  return GOOGLE_TRENDS_ENDPOINTS[source.id]?.includes("geo=VN") ? "VN" : "US";
}

/**
 * A trending search is a keyword with articles behind it, and this feed says so
 * explicitly: <ht:approx_traffic> is how many people searched, and each
 * <ht:news_item> child is an article about it.
 *
 * It used to be read through parseFeed, which knows none of that and kept only
 * title, link and description. All three were wrong for this feed — the
 * description is empty, and <link> is the feed's own URL repeated on every
 * item, so canonicalizing it gave 190 keywords one url_key and dedup collapsed
 * them into a single cluster per region.
 */
export async function fetchTrends(
  source: SourceDefinition,
): Promise<ParsedTrend[]> {
  const endpoint = GOOGLE_TRENDS_ENDPOINTS[source.id];
  if (!endpoint)
    throw new Error(`No trends endpoint is configured for ${source.id}.`);

  return parseTrendsFeed(await fetchXml(endpoint));
}

async function fetchRedditAtom(source: SourceDefinition) {
  // Reddit's .json endpoints answer 403 with an HTML block page, and the Atom
  // feeds rate-limit hard enough that nine consecutive fetches produce eight
  // 429s. One subreddit per run, rotating, is the shape that survives.
  const index = Math.floor(Date.now() / 3_600_000) % REDDIT_SUBREDDITS.length;
  const subreddit = REDDIT_SUBREDDITS[index];
  const xml = await fetchXml(`https://www.reddit.com/r/${subreddit}/.rss`);

  return parseFeed(xml).map((entry) =>
    baseItem(source.id, {
      externalId: entry.id,
      url: entry.link,
      title: entry.title,
      author: entry.author,
      excerpt: entry.summary,
      publishedAt: toIso(entry.published),
      categoryHint: "genz",
      payload: { subreddit },
    }),
  );
}

export async function fetchSource(
  source: SourceDefinition,
): Promise<RawNewsItem[]> {
  switch (source.type) {
    case "hn-algolia-front":
      return await fetchHnFrontPage(source);
    case "hn-algolia-query":
      return await fetchHnWatch(source);
    case "hnrss":
      return await fetchHnRss(source);
    case "lobsters-tag":
      return await fetchLobsters(source, "https://lobste.rs/t/ai.json");
    case "lobsters-hot":
      return await fetchLobsters(source, "https://lobste.rs/hottest.json");
    case "hf-models":
      return await fetchHuggingFaceModels(source);
    case "hf-papers":
      return await fetchHuggingFacePapers(source);
    case "arxiv":
      return await fetchArxiv(source);
    case "github-trending":
      return await fetchGithubTrending(source);
    case "github-releases":
      return await fetchGithubReleases(source);
    case "devto":
      return await fetchDevto(source);
    case "rss":
      return await fetchRss(source);
    case "statuspage-incidents":
      return await fetchStatuspageIncidents(source);
    case "statuspage-summary":
      return await fetchStatuspageSummary(source);
    case "sec-edgar":
      return await fetchSecEdgar(source);
    case "google-trends":
      // Handled by fetchTrends on the keyword path. Returning nothing here
      // rather than throwing keeps the caller's loop uniform: a trend source
      // still reports a sync run, it just contributes no articles.
      return [];
    case "leetcode":
      return await fetchLeetcode(source);
    case "youtube":
      return await fetchYoutube(source);
    case "reddit-atom":
      return await fetchRedditAtom(source);
  }
}

// ---------------------------------------------------------------------------
// Watch terms
// ---------------------------------------------------------------------------

export interface WatchTermSample {
  wikiViews: number | null;
  definitions: number | null;
  thumbsUp: number | null;
}

/**
 * Gen Z slang has no feed, so a tracked term is measured rather than collected:
 * how many people looked it up, and how hard the internet has tried to define
 * it. Both endpoints are open and neither needs a key.
 */
export async function sampleWatchTerm(
  term: string,
  wikiArticle: string | null,
): Promise<WatchTermSample> {
  const sample: WatchTermSample = {
    wikiViews: null,
    definitions: null,
    thumbsUp: null,
  };

  try {
    const payload = (await fetchJson(
      `https://api.urbandictionary.com/v0/define?term=${encodeURIComponent(term)}`,
    )) as { list?: Array<{ thumbs_up?: number }> };
    const list = payload.list ?? [];
    sample.definitions = list.length;
    sample.thumbsUp = list.reduce(
      (total, entry) => total + (entry.thumbs_up ?? 0),
      0,
    );
  } catch {
    // A term nobody has defined is a fact about the term, not a failed run.
  }

  if (wikiArticle) {
    try {
      const end = new Date();
      const start = new Date(end.getTime() - 2 * 24 * 60 * 60 * 1_000);
      const stamp = (date: Date) =>
        date.toISOString().slice(0, 10).replace(/-/g, "");
      const payload = (await fetchJson(
        "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia" +
          `/all-access/user/${encodeURIComponent(wikiArticle)}/daily/${stamp(start)}/${stamp(end)}`,
      )) as { items?: Array<{ views?: number }> };
      const items = payload.items ?? [];
      sample.wikiViews = items.length
        ? (items[items.length - 1].views ?? null)
        : null;
    } catch {
      // Ditto for a term with no article.
    }
  }

  return sample;
}
