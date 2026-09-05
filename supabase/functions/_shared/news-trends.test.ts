import { describe, expect, it } from "vitest";

import {
  coverageTerms,
  deriveKeywords,
  type KeywordArticle,
  keywordKey,
  MIN_ARTICLES_PER_KEYWORD,
  normalizeDashes,
  parseApproxTraffic,
  parseTrendsFeed,
} from "./news-trends";

// ---------------------------------------------------------------------------
// Google Trends
// ---------------------------------------------------------------------------

/** Trimmed from the live VN feed, keeping the shape exactly. */
const TRENDS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss">
<channel>
  <item>
    <title>giá heo hơi hôm nay</title>
    <ht:approx_traffic>200+</ht:approx_traffic>
    <description/>
    <link>https://trends.google.com/trending/rss?geo=VN</link>
    <pubDate>Wed, 26 Aug 2026 22:00:00 -0700</pubDate>
    <ht:picture>https://encrypted-tbn2.gstatic.com/images?q=tbn:ANd9GcS7</ht:picture>
    <ht:picture_source>Thanh Niên</ht:picture_source>
    <ht:news_item>
      <ht:news_item_title>Giá heo hơi hôm nay 27.8.2026: Bất ngờ quay đầu giảm</ht:news_item_title>
      <ht:news_item_snippet/>
      <ht:news_item_url>https://thanhnien.vn/gia-heo-hoi-185260827075501941.htm</ht:news_item_url>
      <ht:news_item_source>Thanh Niên</ht:news_item_source>
    </ht:news_item>
    <ht:news_item>
      <ht:news_item_title>Live hog price today August 27: Slight decrease</ht:news_item_title>
      <ht:news_item_url>https://news.laodong.vn/thi-truong/gia-heo-hoi-1757149.ldo</ht:news_item_url>
      <ht:news_item_source>Laodong.vn</ht:news_item_source>
    </ht:news_item>
  </item>
  <item>
    <title>nghệ an</title>
    <ht:approx_traffic>20K+</ht:approx_traffic>
    <link>https://trends.google.com/trending/rss?geo=VN</link>
    <pubDate>Wed, 26 Aug 2026 21:10:00 -0700</pubDate>
    <ht:news_item>
      <ht:news_item_title>Giá đất Nghệ An tăng mạnh</ht:news_item_title>
      <ht:news_item_url>https://vnexpress.net/gia-dat-nghe-an-1.html</ht:news_item_url>
      <ht:news_item_source>VnExpress</ht:news_item_source>
    </ht:news_item>
  </item>
</channel>
</rss>`;

describe("parseTrendsFeed", () => {
  it("keeps the ht: extensions the generic parser drops", () => {
    const trends = parseTrendsFeed(TRENDS_XML);

    expect(trends).toHaveLength(2);
    expect(trends[0].term).toBe("giá heo hơi hôm nay");
    expect(trends[0].approxTraffic).toBe(200);
    expect(trends[0].pictureUrl).toContain("gstatic.com");
    expect(trends[0].coverage).toHaveLength(2);
  });

  it("reads every news item, not just the first", () => {
    const [first] = parseTrendsFeed(TRENDS_XML);

    expect(first.coverage.map((entry) => entry.sourceName)).toEqual([
      "Thanh Niên",
      "Laodong.vn",
    ]);
    expect(first.coverage[1].url).toContain("laodong.vn");
  });

  /**
   * The bug this whole module exists to fix: <link> is the feed's own URL on
   * every item, so canonicalizing it gave all 190 keywords one url_key and
   * dedup merged them into a single cluster per geo.
   */
  it("does not let the shared feed link become the keyword's identity", () => {
    const trends = parseTrendsFeed(TRENDS_XML);
    const coverageUrls = trends.flatMap((trend) =>
      trend.coverage.map((entry) => entry.canonicalUrl),
    );

    expect(new Set(coverageUrls).size).toBe(coverageUrls.length);
    for (const url of coverageUrls) {
      expect(url).not.toContain("trends.google.com");
    }
  });
});

describe("parseApproxTraffic", () => {
  it.each([
    ["200+", 200],
    ["20K+", 20_000],
    ["1M+", 1_000_000],
    ["1,000+", 1_000],
    ["500", 500],
  ])("reads %s as %i", (input, expected) => {
    expect(parseApproxTraffic(input)).toBe(expected);
  });

  it("returns null rather than zero when the feed omits it", () => {
    expect(parseApproxTraffic("")).toBeNull();
    expect(parseApproxTraffic("lots")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Deriving keywords
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-27T05:00:00Z");

function article(
  id: string,
  sourceId: string,
  title: string,
  url: string,
  category: KeywordArticle["category"] = "ai",
  hotness = 1,
): KeywordArticle {
  return {
    id,
    sourceId,
    sourceName: sourceId,
    title,
    url,
    canonicalUrl: url,
    category,
    hotness,
    halfLifeHours: 8,
    effectiveAt: new Date("2026-08-27T04:00:00Z"),
    publishedAt: null,
  };
}

let sequence = 0;
/** Shorthand for the cases where the id is noise. */
function a(
  sourceId: string,
  title: string,
  url: string,
  category: KeywordArticle["category"] = "ai",
  hotness = 1,
): KeywordArticle {
  sequence += 1;
  return article(`a${sequence}`, sourceId, title, url, category, hotness);
}

/** Verbatim from the live table — these are the rows crowding the grid. */
const RELEASE_NOISE: KeywordArticle[] = [
  "b10632",
  "b10635",
  "b10636",
  "b10638",
  "b10639",
  "b10642",
  "b10643",
].map((tag, index) =>
  article(
    `llama-${index}`,
    "github-releases",
    `ggml-org/llama.cpp ${tag}`,
    `https://github.com/ggml-org/llama.cpp/releases/tag/${tag}`,
  ),
);

describe("deriveKeywords", () => {
  /**
   * The entire point of the feature. Seven release rows are one keyword, not
   * seven cards.
   */
  it("folds a release bot's whole day into one keyword", () => {
    const keywords = deriveKeywords(RELEASE_NOISE, NOW);
    const llama = keywords.find((entry) => entry.termKey === "llama.cpp");

    expect(llama).toBeDefined();
    expect(llama?.term).toBe("llama.cpp");
    expect(llama?.articleIds).toHaveLength(7);
  });

  it("keeps a generic repo name attached to its owner", () => {
    const keywords = deriveKeywords(
      [
        article(
          "q1",
          "github-releases",
          "TanStack/query @tanstack/vue-query@5.102.6",
          "https://github.com/TanStack/query/releases/tag/v5.102.6",
          "stack",
        ),
        article(
          "q2",
          "github-releases",
          "TanStack/query @tanstack/svelte-query@6.1.45",
          "https://github.com/TanStack/query/releases/tag/v6.1.45",
          "stack",
        ),
      ],
      NOW,
    );

    // "query" alone is not a keyword anybody means.
    expect(keywords.map((entry) => entry.term)).toContain("TanStack/query");
    expect(keywords.map((entry) => entry.termKey)).not.toContain("query");
  });

  /**
   * OpenAI's own posts ship a non-breaking hyphen while Hacker News ships an
   * ASCII one. Untouched, that is two keywords which each sit below the
   * corroboration floor and so neither ever appears.
   */
  it("unifies a product spelled with different Unicode dashes", () => {
    const keywords = deriveKeywords(
      [
        article(
          "g1",
          "openai-blog",
          "The builder’s guide to GPT‑5.6",
          "https://openai.com/a",
        ),
        article(
          "g2",
          "hn-front",
          "OpenAI: GPT-5.6 Sol price reduction",
          "https://news.ycombinator.com/item?id=1",
        ),
        article(
          "g3",
          "openai-blog",
          "Improving GPT‑5.6 Sol in ChatGPT",
          "https://openai.com/b",
        ),
      ],
      NOW,
    );

    const gpt = keywords.find((entry) => entry.termKey === "gpt-5.6");
    expect(gpt).toBeDefined();
    expect(gpt?.articleIds).toHaveLength(3);
  });

  it("folds model size and quantization variants into one model", () => {
    const keywords = deriveKeywords(
      [
        article(
          "m1",
          "hf-models",
          "ornith-ai/Ornith-1.5-9B",
          "https://huggingface.co/ornith-ai/Ornith-1.5-9B",
        ),
        article(
          "m2",
          "hf-models",
          "ornith-ai/Ornith-1.5-9B-GGUF",
          "https://huggingface.co/ornith-ai/Ornith-1.5-9B-GGUF",
        ),
        article(
          "m3",
          "hf-models",
          "ornith-ai/Ornith-1.5-35B-A3B",
          "https://huggingface.co/ornith-ai/Ornith-1.5-35B-A3B",
        ),
      ],
      NOW,
    );

    const ornith = keywords.find((entry) => entry.termKey === "ornith-1.5");
    expect(ornith?.articleIds).toHaveLength(3);
  });

  it("finds multi-word proper names", () => {
    const keywords = deriveKeywords(
      [
        article(
          "h1",
          "hn-front",
          "The Hugging Face incident and the road ahead",
          "https://a.dev/1",
        ),
        article(
          "h2",
          "lobsters",
          "Nvidia agrees to acquire Hugging Face for $13B",
          "https://b.dev/2",
        ),
        article(
          "h3",
          "devto",
          "What Hugging Face means for open weights",
          "https://c.dev/3",
        ),
      ],
      NOW,
    );

    expect(keywords.map((entry) => entry.termKey)).toContain("hugging face");
  });

  it("does not turn a title-cased headline into keywords", () => {
    const keywords = deriveKeywords(
      [
        article(
          "t1",
          "hn-front",
          "The Optimization That Was Too Good",
          "https://a.dev/1",
        ),
        article(
          "t2",
          "hn-front",
          "The Root of The Root of All Evil",
          "https://a.dev/2",
        ),
      ],
      NOW,
    );

    for (const entry of keywords) {
      expect(entry.termKey).not.toMatch(/\bthat\b|\bwas\b|\ball\b|\bthe\b/);
    }
  });

  it("requires corroboration, so one article is never a keyword", () => {
    const keywords = deriveKeywords(
      [
        article(
          "s1",
          "hn-front",
          "Hugging Face ships something",
          "https://a.dev/1",
        ),
      ],
      NOW,
    );

    expect(keywords).toHaveLength(0);
    expect(MIN_ARTICLES_PER_KEYWORD).toBe(2);
  });

  /**
   * Two sources carrying a keyword is a different thing from one source
   * carrying it twice — the second is a release bot. Without the multiplier
   * llama.cpp's twelve daily builds outrank a launch three outlets covered.
   */
  it("ranks corroboration above repetition", () => {
    const covered = [
      article(
        "c1",
        "hn-front",
        "Hugging Face outage explained",
        "https://a.dev/1",
        "ai",
        1,
      ),
      article(
        "c2",
        "lobsters",
        "Hugging Face outage explained",
        "https://b.dev/2",
        "ai",
        1,
      ),
      article(
        "c3",
        "devto",
        "Hugging Face outage explained",
        "https://c.dev/3",
        "ai",
        1,
      ),
    ];
    const keywords = deriveKeywords([...RELEASE_NOISE, ...covered], NOW);

    const hugging = keywords.findIndex((e) => e.termKey === "hugging face");
    const llama = keywords.findIndex((e) => e.termKey === "llama.cpp");

    expect(hugging).toBeLessThan(llama);
  });

  it("files a keyword under the category most of its articles sit in", () => {
    const keywords = deriveKeywords(
      [
        article(
          "x1",
          "hn-front",
          "Hugging Face raises money",
          "https://a.dev/1",
          "stack",
        ),
        article(
          "x2",
          "lobsters",
          "Hugging Face ships weights",
          "https://b.dev/2",
          "ai",
        ),
        article(
          "x3",
          "devto",
          "Hugging Face and open models",
          "https://c.dev/3",
          "ai",
        ),
      ],
      NOW,
    );

    expect(keywords.find((e) => e.termKey === "hugging face")?.category).toBe(
      "ai",
    );
  });

  /** One story cut five ways is one keyword, not five. */
  it("keeps one label per set of articles", () => {
    const title =
      "VoiceMem: Streaming Dual-Brain Memory for Real-Time Interaction";
    const keywords = deriveKeywords(
      [
        a("arxiv-ai", title, "https://arxiv.org/abs/2608.11111"),
        a("hf-papers", title, "https://huggingface.co/papers/2608.11111"),
      ],
      NOW,
    );

    const phrases = keywords.filter((entry) => entry.termKey.includes(" "));
    expect(phrases.length).toBeLessThanOrEqual(1);
  });

  it("does not mistake a year for a version", () => {
    const keywords = deriveKeywords(
      [
        article("y1", "hn-front", "The Limits of AI (1985)", "https://a.dev/1"),
        article(
          "y2",
          "hn-front",
          "The risks of AI are real (2023)",
          "https://a.dev/2",
        ),
      ],
      NOW,
    );

    for (const entry of keywords) {
      expect(entry.term).not.toMatch(/19\d{2}|20\d{2}/);
    }
  });

  /**
   * The cost of the shape rule, recorded rather than hidden: "Codex" is a real
   * product and it is lost, because nothing about the word says so. It comes
   * back the moment it appears beside another proper noun — "ChatGPT Work and
   * Codex" yields the phrase — which is the trade being made. Fourteen junk
   * keywords in a top twenty-four is worse than one missing name.
   */
  it("loses a plain-worded product name, and that is the trade", () => {
    const keywords = deriveKeywords(
      [
        a("openai-blog", "A day with Codex", "https://openai.com/1"),
        a("openai-blog", "Another day with Codex", "https://openai.com/2"),
        a("openai-blog", "A third day with Codex", "https://openai.com/3"),
      ],
      NOW,
    );

    expect(keywords.map((entry) => entry.term)).not.toContain("Codex");
  });

  /**
   * On the real corpus a plain capitalised word was almost always arXiv title
   * vocabulary — Optimization, Scalable, Depth — clearing any corroboration
   * floor honestly and naming nothing.
   */
  it("ignores a plain capitalised word however many articles carry it", () => {
    const keywords = deriveKeywords(
      [
        a("hn-front", "Efficient Optimization for Everyone", "https://a.dev/1"),
        a("lobsters", "Optimization in practice", "https://b.dev/2"),
        a("devto", "Notes on Optimization", "https://c.dev/3"),
        a("hn-front", "More Optimization", "https://d.dev/4"),
      ],
      NOW,
    );

    expect(keywords.map((entry) => entry.termKey)).not.toContain(
      "optimization",
    );
  });

  it("keeps a word whose shape names something", () => {
    const distinctive = deriveKeywords(
      [
        a("openai-blog", "A day with ChatGPT", "https://openai.com/1"),
        a(
          "hn-front",
          "Another day with ChatGPT",
          "https://news.ycombinator.com/2",
        ),
      ],
      NOW,
    );
    expect(distinctive.map((entry) => entry.term)).toContain("ChatGPT");

    const allCaps = deriveKeywords(
      [
        a("hn-front", "Shipping RAG at scale", "https://a.dev/1"),
        a("lobsters", "RAG without the pain", "https://b.dev/2"),
      ],
      NOW,
    );
    expect(allCaps.map((entry) => entry.term)).toContain("RAG");
  });

  /** "Sol" is what trails "GPT-5.6"; alone it names nothing. */
  it("does not promote the word trailing a version token", () => {
    const keywords = deriveKeywords(
      [
        a("openai-blog", "GPT-5.6 Sol price reduction", "https://openai.com/1"),
        a(
          "openai-blog",
          "Previewing GPT-5.6 Sol at 14X the speed",
          "https://openai.com/2",
        ),
        a(
          "openai-blog",
          "Improving GPT-5.6 Sol in ChatGPT",
          "https://openai.com/3",
        ),
        a("openai-blog", "Model ML uses GPT-5.6 Sol", "https://openai.com/4"),
      ],
      NOW,
    );

    expect(keywords.map((entry) => entry.termKey)).not.toContain("sol");
    expect(keywords.map((entry) => entry.term)).toContain("GPT-5.6");
  });

  /** "Intelligence" beside "Intelligence Age" is one keyword shown twice. */
  it("lets a longer name absorb the bare word inside it", () => {
    const keywords = deriveKeywords(
      [
        a(
          "openai-blog",
          "Introducing Intelligence Age",
          "https://openai.com/1",
        ),
        a(
          "openai-blog",
          "New policy ideas for the Intelligence Age",
          "https://openai.com/2",
        ),
        a(
          "hn-front",
          "Intelligence everywhere",
          "https://news.ycombinator.com/3",
        ),
      ],
      NOW,
    );

    const terms = keywords.map((entry) => entry.termKey);
    expect(terms).toContain("intelligence age");
    expect(terms).not.toContain("intelligence");
  });

  it("keeps release-note furniture out of the keyword list", () => {
    const keywords = deriveKeywords(
      [
        a(
          "github-releases",
          "nodejs/node Version 26.8.0 (Current), @aduh95",
          "https://github.com/nodejs/node/releases/tag/v26.8.0",
          "stack",
        ),
        a(
          "github-releases",
          "nodejs/node Version 26.8.1 (Current), @aduh95",
          "https://github.com/nodejs/node/releases/tag/v26.8.1",
          "stack",
        ),
        a(
          "github-releases",
          "nodejs/node Version 24.20.0 (Current), @aduh95",
          "https://github.com/nodejs/node/releases/tag/v24.20.0",
          "stack",
        ),
      ],
      NOW,
    );

    expect(keywords.map((entry) => entry.termKey)).not.toContain("current");
    // "node" alone reads as a graph node, so the owner stays attached.
    expect(keywords.map((entry) => entry.term)).toContain("nodejs/node");
  });

  it("skips Hugging Face papers, whose id is a number nobody searches", () => {
    const keywords = deriveKeywords(
      [
        article(
          "p1",
          "hf-papers",
          "Some Paper",
          "https://huggingface.co/papers/2608.20169",
        ),
        article(
          "p2",
          "hf-papers",
          "Other Paper",
          "https://huggingface.co/papers/2608.20170",
        ),
      ],
      NOW,
    );

    expect(keywords.map((e) => e.termKey)).not.toContain("2608.20169");
  });
});

describe("keywordKey", () => {
  it("is case and punctuation insensitive but keeps version identity", () => {
    expect(keywordKey("GPT-5.6")).toBe(keywordKey("gpt-5.6"));
    expect(keywordKey("GPT-5.6")).not.toBe(keywordKey("GPT-5.7"));
  });

  it("keeps Vietnamese diacritics, which are the word", () => {
    expect(keywordKey("Nghệ An")).toBe("nghệ an");
    expect(keywordKey("Nghệ An")).not.toBe(keywordKey("Nghe An"));
  });
});

describe("normalizeDashes", () => {
  it("maps every Unicode dash onto the ASCII one", () => {
    expect(normalizeDashes("GPT‑5.6")).toBe("GPT-5.6");
    expect(normalizeDashes("GPT–5.6")).toBe("GPT-5.6");
    expect(normalizeDashes("GPT−5.6")).toBe("GPT-5.6");
  });
});

// ---------------------------------------------------------------------------
// Coverage terms
// ---------------------------------------------------------------------------

describe("coverageTerms", () => {
  /**
   * Vietnamese words are multi-syllable with spaces inside them, so a unigram
   * split turns "giá đất" into two halves that mean nothing on their own.
   */
  it("finds multi-syllable Vietnamese terms", () => {
    const terms = coverageTerms(
      [
        "Giá đất Nghệ An tăng mạnh trong quý này",
        "Giá đất tại Nghệ An lập đỉnh mới",
        "Người dân đổ xô mua chung cư Nghệ An",
        "Chung cư Nghệ An kín chỗ",
      ],
      "nghệ an",
    );

    const found = terms.map((entry) => entry.term.toLowerCase());
    expect(found).toContain("giá đất");
    expect(found).toContain("chung cư");
  });

  it("excludes the keyword it is describing", () => {
    const terms = coverageTerms(
      ["Nghệ An mở rộng", "Nghệ An thu hút đầu tư", "Nghệ An và du lịch"],
      "nghệ an",
    );

    expect(terms.map((e) => e.term.toLowerCase())).not.toContain("nghệ an");
  });

  it("drops a term that appears in every headline, which is the keyword restated", () => {
    const terms = coverageTerms(
      ["Ollama ships MLX", "Ollama ships CUDA", "Ollama ships Metal"],
      "something-else",
    );

    expect(terms.map((e) => e.term.toLowerCase())).not.toContain("ollama");
  });

  it("drops stopwords in both languages", () => {
    const terms = coverageTerms(
      [
        "The model and the data of the week",
        "The model and the data for the year",
        "Giá của các người và trong khi",
        "Giá của các người và trong khi nữa",
      ],
      "x",
    );

    const found = terms.map((e) => e.term.toLowerCase());
    for (const stop of ["the", "and", "của", "và", "các"]) {
      expect(found).not.toContain(stop);
    }
  });
});
