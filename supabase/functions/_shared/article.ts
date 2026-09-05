// Turning a public URL into the plain text a model can summarize.
//
// This half needs no model. Readability-style extraction benchmarks around
// F1 0.94 on news pages, runs in milliseconds, and costs nothing — spending an
// LLM call to find the article inside the page would be paying twice.

import { assertPublicHttpUrl } from "./private-network.ts";
import { parseHTML } from "npm:linkedom@0.18.13";
import {
  isProbablyReaderable,
  Readability,
} from "npm:@mozilla/readability@0.6.0";

const USER_AGENT = "Hub-William-News/1.0 (+https://hub-william.site)";
const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 40_000;

/** Below this, the "article" is a paywall notice, a cookie banner, or a shell. */
export const MIN_USEFUL_TEXT_CHARS = 600;

export interface ExtractedArticle {
  title: string | null;
  byline: string | null;
  text: string;
}

const MAX_REDIRECTS = 5;

/**
 * Follows redirects by hand.
 *
 * `redirect: "follow"` would have the runtime complete the request to the
 * redirect target before any check of ours could run, which makes the guard a
 * detector rather than a preventer — a page that answers
 * `302 Location: http://169.254.169.254/...` would already have had its
 * response read. Checking each hop before issuing it is the difference.
 */
async function fetchFollowingSafely(startUrl: string) {
  let target = assertPublicHttpUrl(startUrl).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(target, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (response.status < 300 || response.status > 399) return response;

    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) throw new Error("Article redirected without a location.");
    target = assertPublicHttpUrl(
      new URL(location, target).toString(),
    ).toString();
  }

  throw new Error("Article redirected too many times.");
}

/**
 * Stops reading at the cap instead of buffering the whole body and slicing
 * afterwards. A hostile origin is otherwise free to push hundreds of megabytes
 * inside the timeout, and the Edge Function's memory limit is the thing that
 * would notice.
 */
async function readCapped(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_HTML_BYTES) {
    await response.body?.cancel();
    throw new Error("Article is larger than the fetch limit.");
  }

  if (!response.body) return "";

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let html = "";
  let bytes = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (bytes >= MAX_HTML_BYTES) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  return html;
}

/**
 * Returns the article's plain text, not its HTML or markdown. Plain text
 * carries no links and no images, so a page that tries to smuggle an
 * instruction or an exfiltration pixel into the summary has nothing to smuggle
 * it in. It is also the cheaper thing to send.
 */
export async function extractArticle(url: string): Promise<ExtractedArticle> {
  const response = await fetchFollowingSafely(url);

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Article returned HTTP ${response.status}.`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    await response.body?.cancel();
    throw new Error(
      `Article is not HTML (${contentType || "no content-type"}).`,
    );
  }

  const html = await readCapped(response);
  const { document } = parseHTML(html);

  if (!isProbablyReaderable(document as never)) {
    throw new Error("Page does not look like an article.");
  }

  const article = new Readability(document as never).parse();
  if (!article?.textContent) {
    throw new Error("Readability found no article text.");
  }

  const text = article.textContent
    .replace(/\s+\n/g, "\n")
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  if (text.length < MIN_USEFUL_TEXT_CHARS) {
    throw new Error("Extracted text is too short to summarize.");
  }

  return {
    title: article.title?.trim() || null,
    byline: article.byline?.trim() || null,
    text,
  };
}
