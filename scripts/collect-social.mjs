// Reads the feeds a server cannot, from a browser you are signed into.
//
// LinkedIn, X and TikTok all answer a login wall to anything without a session,
// so they have no connector in news-sync. This drives a real Chrome, reads the
// page the way you would, and posts what it found to the news-ingest function.
//
// Three things about how it is meant to be run, because they are the whole
// reason this is a script and not a cron job:
//
//   * It reads *your feed*, not other people's profiles. No enumeration, no
//     search, no walking connections.
//   * It runs when you run it. There is no schedule, no fixed hour, and no
//     unattended loop — an account that is active at 03:00 every day without
//     exception is the pattern that gets noticed, and none of the browser-level
//     disguises help with it.
//   * It uses its own Chrome profile under .playwright-profile, so your daily
//     browser is never locked or touched. You sign in once; the session
//     persists.
//
// Three steps, in order:
//
//   node scripts/collect-social.mjs --login      open a tab per site, sign in
//   node scripts/collect-social.mjs --collect    read them, write collected/latest.json
//   node scripts/collect-social.mjs --deploy     send that file to Supabase
//
// Collecting and deploying are separate on purpose. What comes back from a
// scraped feed is only as good as selectors written against markup that
// changes, so there is a file to look at before any of it reaches the database
// — and a bad harvest is a file you delete rather than rows you go and clean
// up. Run both at once with --collect --deploy when you trust it.
//
// Add --debug to dump the page's structure when a selector finds nothing.

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PROFILE_DIR = path.join(ROOT, ".playwright-profile");
const OUT_DIR = path.join(ROOT, "collected");
const OUT_FILE = path.join(OUT_DIR, "latest.json");

// Node does not read .env on its own. The first real run harvested nine posts
// from X and then had nowhere to send them, which is a maddening way to learn
// that.
const ENV_FILE = path.join(ROOT, ".env");
if (fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE);
  } catch {
    for (const line of fs.readFileSync(ENV_FILE, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (match) process.env[match[1]] ??= match[2].replace(/^["']|["']$/g, "");
    }
  }
}

/**
 * Each target names where to go, how to recognise a post, and which registered
 * source it lands in. Selectors are the fragile part by construction — a class
 * name changes and this returns nothing — so each one reports what it found and
 * the script refuses to post an empty harvest silently.
 */
const TARGETS = {
  linkedin: {
    sourceId: "linkedin-feed",
    url: "https://www.linkedin.com/feed/",
    signedOut: /\/(login|checkpoint|authwall)/,
    ready: '[data-testid="expandable-text-box"]',
    scrolls: 8,
    // Written against the markup as it actually is, probed while signed in.
    // Everything the previous versions relied on is gone: data-urn and data-id
    // return zero elements, and every class name is hashed per build
    // (_42fbde90, ff70163b), so nothing can be selected by name.
    //
    // What survives is data-testid, because tests need it.
    extract: () => {
      // Stable across runs for the same post, which is all externalId has to
      // be. djb2 rather than anything cryptographic — this identifies, it does
      // not protect.
      const clip = (value, max) => {
        let out = (value ?? "").slice(0, max);
        if (/[\uD800-\uDBFF]$/.test(out)) out = out.slice(0, -1);
        return out.replace(
          /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
          "",
        );
      };

      const hash = (value) => {
        let h = 5381;
        for (let i = 0; i < value.length; i += 1) {
          h = ((h << 5) + h + value.charCodeAt(i)) >>> 0;
        }
        return h.toString(36);
      };

      // "Commentary" is LinkedIn's word for the body of a post, so filtering on
      // the word "comment" threw away every post on the page. Only an actual
      // urn:li:comment: ancestor means this text is somebody's reply.
      const isReply = (el) => {
        let up = el;
        for (let i = 0; i < 14 && up.parentElement; i += 1) {
          up = up.parentElement;
          if (/urn:li:comment:/.test(up.getAttribute?.("componentkey") ?? "")) {
            return true;
          }
        }
        return false;
      };

      const seen = new Set();

      return Array.from(
        document.querySelectorAll('[data-testid="expandable-text-box"]'),
      )
        .filter((box) => !isReply(box))
        .map((box) => {
          const body = (box.innerText ?? "").replace(/\s+/g, " ").trim();
          if (body.length < 25) return null;

          // Up to whichever ancestor first carries the author's link.
          let card = box;
          for (let i = 0; i < 8 && card.parentElement; i += 1) {
            card = card.parentElement;
            if (card.querySelector('a[href*="/in/"], a[href*="/company/"]')) {
              break;
            }
          }
          const link = card.querySelector(
            'a[href*="/in/"], a[href*="/company/"]',
          );
          const profile = (link?.getAttribute("href") ?? "").split("?")[0];
          const slug = profile.match(/\/(?:in|company)\/([^/]+)/)?.[1] ?? "";
          const named = (link?.innerText ?? "").replace(/\s+/g, " ").trim();
          // The slug is percent-encoded in the href, so a Vietnamese name
          // arrives as ph%C6%B0%C6%A1ng-trang and would be stored that way.
          const readable = (() => {
            try {
              return decodeURIComponent(slug).replace(/-+/g, " ").trim();
            } catch {
              return slug;
            }
          })();
          const author = named && named !== "Feed post" ? named : readable;

          const id = hash(`${slug}:${body.slice(0, 160)}`);
          if (seen.has(id)) return null;
          seen.add(id);

          return {
            externalId: `post:${id}`,
            // There is no permalink in the markup any more, so this points at
            // whoever wrote it — which is the useful destination anyway. The
            // query parameter is what keeps two posts by one author from
            // canonicalising to the same URL and clustering into one story;
            // LinkedIn ignores it and still opens the profile.
            url: profile
              ? `${profile}?post=${id}`
              : `https://www.linkedin.com/feed/?post=${id}`,
            title: clip(body, 200),
            excerpt: clip(body, 600),
            author: clip(author, 120),
          };
        })
        .filter(Boolean);
    },
  },

  x: {
    sourceId: "x-timeline",
    url: "https://x.com/home",
    signedOut: /\/(i\/flow\/login|i\/jf\/onboarding)/,
    ready: 'article[data-testid="tweet"]',
    scrolls: 10,
    extract: () =>
      Array.from(document.querySelectorAll("article[data-testid='tweet']"))
        .map((post) => {
          const link = post.querySelector("a[href*='/status/']");
          const href = link?.getAttribute("href") ?? "";
          const id = href.match(/status\/(\d+)/)?.[1];
          const body =
            post
              .querySelector("div[data-testid='tweetText']")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() ?? "";
          const author =
            post
              .querySelector("div[data-testid='User-Name'] span")
              ?.textContent?.trim() ?? "";
          const time =
            post.querySelector("time")?.getAttribute("datetime") ?? "";
          if (!id || !body) return null;
          return {
            externalId: id,
            url: `https://x.com${href}`,
            title: body.slice(0, 200),
            excerpt: body.slice(0, 600),
            author,
            publishedAt: time || undefined,
          };
        })
        .filter(Boolean),
  },

  tiktok: {
    sourceId: "tiktok-trends",
    // Signed in, the Creative Center drops the three-row cap it shows to
    // anonymous visitors.
    url: "https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?region=VN&period=7",
    // TikTok does not redirect when signed out, it just truncates. Three rows
    // exactly is the anonymous cap, so treat it as "not signed in" rather than
    // as a quiet day.
    signedOut: null,
    minSignedIn: 4,
    // Class names here are hashed per build, so nothing stable can be selected
    // by name. The hashtag text itself is the anchor: find the elements whose
    // whole content is one hashtag, then walk up to the row that carries its
    // numbers.
    extract: () => {
      const seen = new Set();
      const tags = Array.from(
        document.querySelectorAll("span, div, a, h3"),
      ).filter((el) => {
        const text = el.textContent?.trim() ?? "";
        return /^#[\p{L}\p{N}_]{2,60}$/u.test(text) && el.children.length === 0;
      });

      return tags
        .map((el) => {
          const name = (el.textContent ?? "").trim().replace(/^#/, "");
          const key = name.toLowerCase();
          if (seen.has(key)) return null;
          seen.add(key);

          // Up to whichever ancestor first carries a count alongside the tag.
          let row = el;
          for (let up = 0; up < 6 && row.parentElement; up += 1) {
            row = row.parentElement;
            if (
              /\d[\d.,]*\s*[KMB]?\s*(posts|views|lượt)/i.test(
                row.textContent ?? "",
              )
            ) {
              break;
            }
          }
          const stats = (row.textContent ?? "")
            .replace(/\s+/g, " ")
            .match(/\d[\d.,]*\s*[KMB]?\s*(?:posts|views)/gi);

          return {
            externalId: `vn:${key}`,
            url: `https://www.tiktok.com/tag/${encodeURIComponent(name)}`,
            title: `#${name}`,
            excerpt: (stats ?? []).join(" · "),
          };
        })
        .filter(Boolean);
    },
  },
};

function arg(name) {
  return process.argv.includes(`--${name}`);
}

/** --flag value, or --flag=value. */
function value(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index !== -1 && process.argv[index + 1]?.startsWith("-") === false) {
    return process.argv[index + 1];
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : null;
}

const CHROME_DIR = path.join(
  process.env.HOME ?? "",
  "Library/Application Support/Google/Chrome",
);

/**
 * Three ways to get a browser, because "just use my Chrome" is not one thing.
 *
 * Chrome holds an exclusive lock on a user-data directory while it runs, so
 * nothing can drive the profile you already have open. That leaves:
 *
 *   --attach            Connect to a Chrome you started yourself with
 *                       --remote-debugging-port=9222. Your real profile, your
 *                       real sessions, nothing to sign in to again, and the
 *                       browser stays yours — this script only opens a tab in
 *                       it. Chrome has to have been started with the flag.
 *
 *   --profile <name>    Drive your actual profile directory. No signing in
 *                       again either, but Chrome must be fully quit first, and
 *                       a crash here writes to the profile you use every day.
 *
 *   (default)           A profile of this script's own under
 *                       .playwright-profile. You sign in once. Nothing can
 *                       touch your daily browser, and quitting Chrome is never
 *                       required. Slowest to start, safest to run.
 */
async function browser() {
  const attach = arg("attach");
  const profile = value("profile");

  if (attach) {
    const endpoint = value("cdp") ?? "http://localhost:9222";
    try {
      const connected = await chromium.connectOverCDP(endpoint);
      return connected.contexts()[0] ?? (await connected.newContext());
    } catch {
      console.error(
        `Could not reach a Chrome at ${endpoint}.\n\n` +
          "Quit Chrome, then start it once with the debugging port open:\n" +
          '  open -a "Google Chrome" --args --remote-debugging-port=9222\n\n' +
          "Your profiles and sessions are untouched; the flag only lets a\n" +
          "script open a tab in the browser you are already using.",
      );
      process.exit(1);
    }
  }

  const options = {
    // Real Chrome, not bundled Chromium: the bundled build advertises itself in
    // a dozen small ways, and there is no reason to look like something you are
    // not when you are reading your own feed.
    channel: "chrome",
    headless: false,
    viewport: { width: 1280, height: 900 },
    args: ["--disable-blink-features=AutomationControlled"],
  };

  if (profile) {
    if (fs.existsSync(path.join(CHROME_DIR, "SingletonLock"))) {
      console.error(
        `Chrome is running and holds a lock on ${CHROME_DIR}.\n\n` +
          "Either quit Chrome completely and run this again, or use --attach,\n" +
          "which drives the Chrome you already have open.",
      );
      process.exit(1);
    }
    return await chromium.launchPersistentContext(CHROME_DIR, {
      ...options,
      args: [...options.args, `--profile-directory=${profile}`],
    });
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  return await chromium.launchPersistentContext(PROFILE_DIR, options);
}

/**
 * Opens one tab per target and waits.
 *
 * You sign in by hand, in a real browser, exactly as you would any other day —
 * the script never sees a password and never stores one. What it keeps is the
 * session cookie Chrome writes itself, in a profile directory that belongs to
 * this script alone.
 *
 * Sign in to whichever sites you actually want; the rest can stay signed out.
 * Each collect run checks and will tell you which one is missing.
 */
async function login() {
  const context = await browser();
  const names = Object.keys(TARGETS);

  const first = context.pages()[0] ?? (await context.newPage());
  await first.goto(TARGETS[names[0]].url).catch(() => {});
  for (const name of names.slice(1)) {
    const tab = await context.newPage();
    await tab.goto(TARGETS[name].url).catch(() => {});
  }

  if (arg("attach") || value("profile")) {
    console.log(
      "You are already signed in on that profile — --login is only needed for\n" +
        "this script's own profile. Run a target directly.",
    );
    await context.close().catch(() => {});
    return;
  }

  console.log(
    `Opened ${names.length} tabs: ${names.join(", ")}.\n` +
      "Sign in to the ones you want, then close the whole window.\n" +
      "Nothing you type is read by this script — only the cookies Chrome saves.",
  );

  // Waiting on the context, not one page, so closing any tab does not end it
  // early and closing the window ends it cleanly.
  await new Promise((resolve) => context.on("close", resolve));
  console.log(`Session saved to ${path.relative(ROOT, PROFILE_DIR)}/`);
}

/**
 * Reads one target in a context that is already open.
 *
 * Returns rather than exits, because --collect wants the other targets tried
 * even when this one is signed out. A caller running a single target turns the
 * failure into an exit code itself.
 */
async function harvest(context, name) {
  const target = TARGETS[name];
  const page = await context.newPage();

  try {
    await page.goto(target.url, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // Wait for the feed to actually render rather than for a fixed three
    // seconds. The fixed wait passed most of the time and then returned zero
    // items on a slow load, which reads exactly like a broken selector and sent
    // me looking in the wrong place once already.
    if (target.ready) {
      await page
        .waitForSelector(target.ready, { timeout: 30_000 })
        .catch(() => {});
    }
    await page.waitForTimeout(1_500);

    if (target.signedOut?.test(page.url())) {
      return { name, items: [], error: "not signed in" };
    }

    // window.scrollBy rather than mouse.wheel: the mouse only reaches whichever
    // tab is focused, so with three open at once two of them sat still and
    // reported nothing found. Timing stays irregular because a feed needs time
    // to render what it loads lazily.
    for (let i = 0; i < target.scrolls; i += 1) {
      const by = 600 + Math.floor(Math.random() * 900);
      await page.evaluate((y) => window.scrollBy(0, y), by);
      await page.waitForTimeout(900 + Math.floor(Math.random() * 1_400));
    }

    const items = await page.evaluate(target.extract);

    if (target.minSignedIn && items.length < target.minSignedIn) {
      return {
        name,
        items,
        error: `only ${items.length} items — that is the signed-out cap`,
      };
    }
    if (items.length === 0) {
      const rendered = target.ready
        ? await page.$(target.ready).then(Boolean)
        : true;
      if (!rendered) {
        return {
          name,
          items,
          error: "the feed never rendered — try again, or scroll it yourself",
        };
      }
      // Silence here would look like a quiet day rather than a broken
      // selector, which is the failure this codebase keeps trying not to ship.
      if (arg("debug")) {
        const shape = await page.evaluate(() => {
          const counts = {};
          for (const el of document.querySelectorAll(
            "div,article,li,section",
          )) {
            for (const cls of el.classList) {
              if (cls.length > 3) counts[cls] = (counts[cls] ?? 0) + 1;
            }
          }
          const attrs = ["data-urn", "data-id", "data-testid"].map((a) => [
            a,
            document.querySelectorAll(`[${a}]`).length,
          ]);
          return {
            url: location.href,
            top: Object.entries(counts)
              .sort((a, b) => b[1] - a[1])
              .slice(0, 25),
            attrs,
          };
        });
        console.log(`\n  --debug ${name}: ${shape.url}`);
        console.log("  attributes:", JSON.stringify(shape.attrs));
        console.log("  commonest classes:");
        for (const [cls, n] of shape.top) console.log(`    ${n}x ${cls}`);
      }
      return {
        name,
        items,
        error:
          "nothing matched — selectors have changed" +
          (arg("debug") ? "" : " (re-run with --debug to dump the page)"),
      };
    }
    return { name, items, error: null };
  } catch (error) {
    return { name, items: [], error: error.message?.slice(0, 120) ?? "failed" };
  } finally {
    await page.close().catch(() => {});
  }
}

async function post(name, items) {
  // VITE_SUPABASE_URL is what .env actually carries — the app needs it prefixed
  // to reach the browser bundle, and there is no second copy of the same URL
  // under a different name just for scripts.
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const secret = process.env.PROVIDER_SYNC_SECRET;
  if (!url || !secret) {
    return {
      error:
        "no Supabase URL or sync secret — .env needs VITE_SUPABASE_URL " +
        "(or SUPABASE_URL) and PROVIDER_SYNC_SECRET",
    };
  }

  const response = await fetch(`${url}/functions/v1/news-ingest`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-secret": secret },
    body: JSON.stringify({ sourceId: TARGETS[name].sourceId, items }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { error: `ingest ${response.status}: ${payload.error ?? ""}` };
  }
  return payload;
}

async function collectAll(names) {
  const context = await browser();

  // All tabs at once. Each scrolls with window.scrollBy, which works in a
  // background tab, so three feeds load in the time one used to — and it looks
  // like opening three tabs, because that is what it is.
  console.log(`Opening ${names.length} tab${names.length === 1 ? "" : "s"}…`);
  const harvested = await Promise.all(
    names.map((name) => harvest(context, name)),
  );
  await context.close().catch(() => {});

  const targets = {};
  for (const result of harvested) {
    console.log(`\n${result.name}: ${result.items.length} items`);
    for (const item of result.items.slice(0, 4)) {
      console.log(`  ${item.title.slice(0, 76)}`);
    }
    if (result.error) console.log(`  ! ${result.error}`);
    // A target that failed is written as an empty list rather than left out, so
    // --deploy cannot mistake "it broke" for "nothing new today".
    targets[result.name] = result.error ? [] : result.items;
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(
    OUT_FILE,
    JSON.stringify({ collectedAt: new Date().toISOString(), targets }, null, 2),
  );

  const total = Object.values(targets).reduce((n, list) => n + list.length, 0);
  const empty = Object.entries(targets)
    .filter(([, list]) => list.length === 0)
    .map(([name]) => name);
  console.log(
    `\nWrote ${total} items to ${path.relative(ROOT, OUT_FILE)}` +
      (empty.length ? `. Empty: ${empty.join(", ")}` : "."),
  );
  return total;
}

async function deployAll() {
  if (!fs.existsSync(OUT_FILE)) {
    console.error(
      `Nothing to deploy — ${path.relative(ROOT, OUT_FILE)} does not exist.\n` +
        "Run: node scripts/collect-social.mjs --collect",
    );
    process.exit(1);
  }

  const saved = JSON.parse(fs.readFileSync(OUT_FILE, "utf8"));
  const age = Date.now() - new Date(saved.collectedAt).getTime();
  console.log(
    `Deploying ${path.relative(ROOT, OUT_FILE)}, collected ` +
      `${Math.round(age / 60_000)} minutes ago.`,
  );

  let stored = 0;
  let failed = 0;
  for (const [name, items] of Object.entries(saved.targets ?? {})) {
    if (!TARGETS[name]) {
      console.log(`\n${name}: unknown target, skipped`);
      continue;
    }
    if (!items.length) {
      console.log(`\n${name}: nothing collected, skipped`);
      continue;
    }
    const posted = await post(name, items);
    if (posted.error) {
      console.log(`\n${name}: ! ${posted.error}`);
      failed += 1;
    } else {
      console.log(`\n${name}: stored ${posted.stored} (${posted.created} new)`);
      stored += posted.stored;
    }
  }

  console.log(`\n${stored} items stored${failed ? `, ${failed} failed` : ""}.`);
  if (failed) process.exit(1);
}

const target = process.argv[2];
const names = TARGETS[target] ? [target] : Object.keys(TARGETS);

if (arg("login")) {
  await login();
} else if (arg("collect") || arg("deploy")) {
  let collected = null;
  if (arg("collect")) collected = await collectAll(names);
  if (arg("deploy")) {
    if (collected === 0) {
      console.error("\nNothing collected, so nothing to deploy.");
      process.exit(1);
    }
    await deployAll();
  } else if (arg("collect")) {
    console.log(
      "\nLook it over, then: node scripts/collect-social.mjs --deploy",
    );
  }
} else {
  console.log(
    "Usage:\n" +
      "  node scripts/collect-social.mjs --login      open a tab per site, sign in\n" +
      "  node scripts/collect-social.mjs --collect    read them, write collected/latest.json\n" +
      "  node scripts/collect-social.mjs --deploy     send that file to Supabase\n" +
      "  node scripts/collect-social.mjs --collect --deploy\n\n" +
      `Add a target to narrow it: <${Object.keys(TARGETS).join("|")}>\n` +
      "Add --debug to dump the page when a selector finds nothing.\n\n" +
      "Which browser:\n" +
      "  (nothing)            this script's own profile, sign in once\n" +
      "  --attach             a Chrome you started with --remote-debugging-port=9222\n" +
      "  --profile Default    your real profile, with Chrome fully quit",
  );
}
