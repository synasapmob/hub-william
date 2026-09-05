import { describe, expect, it } from "vitest";

import {
  attentionOf,
  canonicalizeUrl,
  classify,
  contentHash,
  decayedHotness,
  effectiveAt,
  halfLifeFor,
  hotnessOf,
  type RawNewsItem,
  TITLE_MATCH_MIN_SIMILARITY,
  titleKey,
  titleSimilarity,
  velocityOf,
} from "./news-rank";

function item(overrides: Partial<RawNewsItem> = {}): RawNewsItem {
  return {
    sourceId: "hn-frontpage",
    externalId: "1",
    url: "https://example.com/story",
    title: "A story",
    author: null,
    excerpt: "",
    publishedAt: null,
    points: null,
    comments: null,
    attentionOverride: null,
    categoryHint: null,
    payload: {},
    ...overrides,
  };
}

describe("canonicalizeUrl", () => {
  it("strips tracking parameters, the hash and the trailing slash", () => {
    expect(
      canonicalizeUrl(
        "https://www.example.com/post/?utm_source=x&utm_campaign=y&fbclid=z#section",
      ),
    ).toBe("https://example.com/post");
  });

  it("sorts the parameters that survive so order cannot fork a key", () => {
    expect(canonicalizeUrl("https://example.com/a?b=2&a=1")).toBe(
      canonicalizeUrl("https://example.com/a?a=1&b=2"),
    );
  });

  it("keeps a parameter that is identity rather than decoration", () => {
    expect(
      canonicalizeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42"),
    ).toBe("yt:dQw4w9WgXcQ");
  });

  it("collapses an arXiv version so v1 and v3 are one paper", () => {
    expect(canonicalizeUrl("https://arxiv.org/abs/2608.20169v3")).toBe(
      canonicalizeUrl("https://arxiv.org/pdf/2608.20169"),
    );
  });

  it("collapses a repository tree URL onto its root", () => {
    expect(canonicalizeUrl("https://github.com/Owner/Repo/tree/main/src")).toBe(
      "github:owner/repo",
    );
  });

  it("keeps an issue distinct from the repository it belongs to", () => {
    expect(canonicalizeUrl("https://github.com/owner/repo/issues/12")).not.toBe(
      canonicalizeUrl("https://github.com/owner/repo"),
    );
  });

  it("treats a non-URL, such as a trending search term, as its own key", () => {
    expect(canonicalizeUrl("Hiệu Trưởng")).toBe("hiệu trưởng");
  });
});

describe("titleSimilarity", () => {
  function similarity(left: string, right: string) {
    return titleSimilarity(titleKey(left), titleKey(right));
  }

  it("matches two wordings of the same headline", () => {
    expect(
      similarity(
        "OpenAI releases GPT-5.6 for developers today",
        "OpenAI releases GPT-5.6 for developers",
      ),
    ).toBeGreaterThanOrEqual(TITLE_MATCH_MIN_SIMILARITY);
  });

  it("does not merge two angles on one subject", () => {
    // The failure modes are not symmetric. A false split shows a duplicate,
    // which is untidy; a false merge buries a story inside another one's
    // "also on" line, where nobody will find it. So the threshold stays where
    // sharing a subject is not enough, and genuine duplicates are caught by the
    // canonical URL instead — which is the case that actually occurs.
    expect(
      similarity(
        "Vite 8.2 released with faster HMR",
        "Vite 8.2 released with a new plugin API",
      ),
    ).toBeLessThan(TITLE_MATCH_MIN_SIMILARITY);
  });

  it("merges the same story submitted to two sites, by URL", () => {
    expect(canonicalizeUrl("https://example.com/post?utm_source=hn")).toBe(
      canonicalizeUrl("https://www.example.com/post/"),
    );
  });

  it("keeps unrelated headlines apart", () => {
    expect(
      similarity(
        "Postgres 19 adds asynchronous IO to the planner",
        "Gen Z has decided that email is for old people",
      ),
    ).toBeLessThan(TITLE_MATCH_MIN_SIMILARITY);
  });

  it("refuses to match short titles on a coincidental overlap", () => {
    // Two of three words shared, and two entirely different stories.
    expect(similarity("Postgres 19 released", "Postgres 19 benchmarks")).toBe(
      0,
    );
  });

  it("still matches short titles when they are actually identical", () => {
    expect(similarity("Vite 8.2 released", "vite 8.2 released!")).toBe(1);
  });

  it("ignores case, punctuation and diacritics", () => {
    expect(titleKey("Vite 8.2 is out!")).toBe(titleKey("vite 8 2 is out"));
  });
});

describe("classify", () => {
  it("short-circuits on a single-topic source", () => {
    expect(
      classify(item({ title: "Anything at all" }), "https://example.com/x", {
        category: "genz",
        categoryExclusive: true,
      }),
    ).toEqual({ category: "genz", reason: "source" });
  });

  it("routes on the host before reading any words", () => {
    expect(
      classify(
        item({ title: "A release with no obvious keywords" }),
        "https://huggingface.co/org/model",
        { category: null, categoryExclusive: false },
      ).category,
    ).toBe("ai");
  });

  it("falls back to the lexicon for a mixed source", () => {
    expect(
      classify(
        item({ title: "Show HN: an agent harness for local LLM inference" }),
        "https://example.com/x",
        { category: null, categoryExclusive: false },
      ).category,
    ).toBe("ai");
  });

  it("files a layoff story under stack", () => {
    expect(
      classify(
        item({ title: "Big Corp confirms a further round of layoffs" }),
        "https://example.com/x",
        { category: null, categoryExclusive: false },
      ).category,
    ).toBe("stack");
  });

  it("uses the source prior as a nudge, not a verdict", () => {
    // A mixed source hinting at AI, carrying an unmistakably Stack story.
    expect(
      classify(
        item({
          title:
            "Postgres 19 adds asynchronous IO, kubernetes operator updated",
          excerpt: "A rust rewrite of the vite plugin also shipped.",
        }),
        "https://example.com/x",
        { category: "ai", categoryExclusive: false },
      ).category,
    ).toBe("stack");
  });
});

describe("effectiveAt", () => {
  const seen = new Date("2026-08-25T12:00:00Z");

  it("uses first_seen_at when the feed publishes no date", () => {
    expect(effectiveAt(null, seen)).toEqual(seen);
  });

  it("refuses a future publication date", () => {
    expect(effectiveAt("2026-08-26T00:00:00Z", seen)).toEqual(seen);
  });

  it("clamps an archive backfill to 48 hours", () => {
    // A feed that dumps its 2021 archive must not repopulate the front page.
    expect(effectiveAt("2021-01-01T00:00:00Z", seen).toISOString()).toBe(
      "2026-08-23T12:00:00.000Z",
    );
  });

  it("keeps a normal publication date", () => {
    expect(effectiveAt("2026-08-25T09:00:00Z", seen).toISOString()).toBe(
      "2026-08-25T09:00:00.000Z",
    );
  });

  it("ignores an unparseable date rather than producing an invalid one", () => {
    expect(effectiveAt("not a date", seen)).toEqual(seen);
  });
});

describe("attentionOf", () => {
  it("weights comments below votes", () => {
    expect(attentionOf("hn", item({ points: 100, comments: 100 }))).toBe(150);
  });

  it("returns null for a source that publishes no popularity signal", () => {
    expect(attentionOf("rss", item())).toBeNull();
  });

  it("prefers an explicit override, such as a star delta", () => {
    expect(
      attentionOf("github", item({ points: 9999, attentionOverride: 12 })),
    ).toBe(12);
  });
});

describe("velocityOf", () => {
  it("is null on the first sighting, so a new item is not scored against it", () => {
    expect(velocityOf("hn", 40, null, 1)).toBeNull();
  });

  it("is null when two snapshots are too close together to mean anything", () => {
    expect(velocityOf("hn", 40, 20, 0.1)).toBeNull();
  });

  it("damps growth on tiny counters", () => {
    const tiny = velocityOf("hn", 6, 2, 1) ?? 0;
    const large = velocityOf("hn", 1_100, 800, 1) ?? 0;
    // 2 to 6 is +200% and 800 to 1100 is +37%, yet the second is the real story.
    expect(large).toBeGreaterThan(tiny);
  });

  it("clamps a counter that went backwards, which caches routinely cause", () => {
    expect(velocityOf("hn", 30, 40, 1)).toBeGreaterThanOrEqual(0);
  });
});

describe("hotnessOf", () => {
  it("scores an item against its own source's median", () => {
    const quiet = hotnessOf({
      attention: 40,
      sourceMedianLogAttention: Math.log1p(40),
      velocity: null,
      weight: 1,
    });
    const loud = hotnessOf({
      attention: 400,
      sourceMedianLogAttention: Math.log1p(400),
      velocity: null,
      weight: 1,
    });
    // A typical Lobsters post and a typical Hacker News post both score ~1.
    expect(quiet).toBeCloseTo(loud, 5);
  });

  it("gives a source with no counter an editorial score driven by its weight", () => {
    expect(
      hotnessOf({
        attention: null,
        sourceMedianLogAttention: null,
        velocity: null,
        weight: 0.5,
      }),
    ).toBe(0.5);
  });

  it("lifts an item that is climbing over an equal one that is not", () => {
    const base = {
      attention: 100,
      sourceMedianLogAttention: Math.log1p(100),
      weight: 1,
    };
    expect(hotnessOf({ ...base, velocity: 0.3 })).toBeGreaterThan(
      hotnessOf({ ...base, velocity: null }),
    );
  });

  it("never returns a negative score for a falling item", () => {
    expect(
      hotnessOf({
        attention: 1,
        sourceMedianLogAttention: 5,
        velocity: -10,
        weight: 1,
      }),
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("decayedHotness", () => {
  const now = new Date("2026-08-25T12:00:00Z");

  it("halves the score after one half-life", () => {
    expect(
      decayedHotness(10, new Date("2026-08-25T07:00:00Z"), 5, now),
    ).toBeCloseTo(5, 6);
  });

  it("leaves an item published in the future untouched rather than inflating it", () => {
    expect(decayedHotness(10, new Date("2026-08-25T13:00:00Z"), 5, now)).toBe(
      10,
    );
  });

  it("decays a Gen Z story faster than an AI one", () => {
    const effective = new Date("2026-08-25T06:00:00Z");
    const genz = decayedHotness(10, effective, halfLifeFor("rss", "genz"), now);
    const ai = decayedHotness(10, effective, halfLifeFor("rss", "ai"), now);
    expect(genz).toBeLessThan(ai);
  });
});

describe("contentHash", () => {
  it("changes when a counter moves, so an update is detected", async () => {
    const before = await contentHash(item({ points: 10 }));
    const after = await contentHash(item({ points: 11 }));
    expect(before).not.toBe(after);
  });

  it("does not collide when a field boundary shifts", async () => {
    const left = await contentHash(item({ title: "ab", excerpt: "c" }));
    const right = await contentHash(item({ title: "a", excerpt: "bc" }));
    expect(left).not.toBe(right);
  });
});
