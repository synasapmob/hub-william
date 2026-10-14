import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

interface ResolvePayload {
  url?: string;
  platform?: string;
}

interface VideoVariant {
  label: string;
  url: string;
  bitrate?: number;
}

interface ResolvedVideo {
  id: string;
  platform: "x" | "tiktok" | "facebook";
  title: string;
  author: string;
  avatar?: string;
  thumbnail?: string;
  duration?: number;
  videoUrl: string;
  variants: VideoVariant[];
}

interface FxTwitterVariant {
  content_type?: string;
  url?: string;
  bitrate?: number;
}

interface FxTwitterMediaItem {
  type?: string;
  format?: string;
  thumbnail_url?: string;
  duration?: number;
  url?: string;
  variants?: FxTwitterVariant[];
  formats?: FxTwitterVariant[];
}

interface FxTwitterResponse {
  tweet?: {
    text?: string;
    author?: {
      name?: string;
      screen_name?: string;
      avatar_url?: string;
      banner_url?: string;
    };
    media?: {
      videos?: FxTwitterMediaItem[];
      all?: FxTwitterMediaItem[];
    };
  };
}

interface TikWmResponse {
  code: number;
  msg?: string;
  data?: {
    id?: string;
    title?: string;
    cover?: string;
    duration?: number;
    play?: string;
    hdplay?: string;
    wmplay?: string;
    author?: {
      nickname?: string;
      unique_id?: string;
      avatar?: string;
    };
  };
}

function detectPlatform(
  url: string,
  explicitPlatform?: string,
): "x" | "tiktok" | "facebook" | null {
  if (
    explicitPlatform &&
    ["x", "twitter", "tiktok", "facebook"].includes(
      explicitPlatform.toLowerCase(),
    )
  ) {
    return explicitPlatform.toLowerCase() === "twitter"
      ? "x"
      : (explicitPlatform.toLowerCase() as "x" | "tiktok" | "facebook");
  }

  const lowercase = url.toLowerCase();
  if (lowercase.includes("x.com") || lowercase.includes("twitter.com"))
    return "x";
  if (lowercase.includes("tiktok.com")) return "tiktok";
  if (lowercase.includes("facebook.com") || lowercase.includes("fb.watch"))
    return "facebook";
  return null;
}

async function resolveX(url: string): Promise<ResolvedVideo> {
  const match = url.match(/(?:status|statuses)\/(\d+)/);
  if (!match)
    throw new Error("Could not find a Tweet or Video ID in this X link.");
  const tweetId = match[1];

  const res = await fetch(`https://api.fxtwitter.com/i/status/${tweetId}`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) {
    throw new Error(
      `X API returned status ${res.status}. Tweet may be private, sensitive, or deleted.`,
    );
  }

  const data = (await res.json()) as FxTwitterResponse;
  const tweet = data.tweet;
  const videos = tweet?.media?.videos || tweet?.media?.all || [];
  const primaryVideo = videos.find(
    (item) =>
      item.type === "video" ||
      item.format === "video/mp4" ||
      Boolean(item.variants?.length),
  );

  if (!primaryVideo) {
    throw new Error("No video found in this X post.");
  }

  const rawVariants = (
    primaryVideo.variants ||
    primaryVideo.formats ||
    []
  ).filter(
    (v) =>
      v.content_type === "video/mp4" ||
      Boolean(v.url && v.url.includes(".mp4")),
  );

  const variants: VideoVariant[] = rawVariants
    .map((v) => {
      let label = "Standard MP4";
      if (v.bitrate) {
        if (v.bitrate > 20000000) label = "4K UHD";
        else if (v.bitrate > 8000000) label = "1080p FHD";
        else if (v.bitrate > 2000000) label = "720p HD";
        else if (v.bitrate > 700000) label = "360p SD";
        else label = `${Math.round(v.bitrate / 1000)} kbps`;
      }
      return {
        label,
        url: v.url || "",
        bitrate: v.bitrate || 0,
      };
    })
    .sort(
      (a: VideoVariant, b: VideoVariant) => (b.bitrate || 0) - (a.bitrate || 0),
    );

  const bestUrl = variants[0]?.url || primaryVideo.url || "";

  return {
    id: tweetId,
    platform: "x",
    title: tweet?.text || "X Video",
    author: tweet?.author?.name
      ? `${tweet.author.name} (@${tweet.author.screen_name})`
      : "X User",
    avatar: tweet?.author?.avatar_url,
    thumbnail: primaryVideo.thumbnail_url || tweet?.author?.banner_url,
    duration: primaryVideo.duration,
    videoUrl: bestUrl,
    variants: variants.length
      ? variants
      : [{ label: "Original MP4", url: bestUrl }],
  };
}

async function resolveTikTok(url: string): Promise<ResolvedVideo> {
  const res = await fetch(
    `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}`,
    {
      headers: { "User-Agent": "Mozilla/5.0" },
    },
  );

  if (!res.ok) {
    throw new Error(`TikTok resolver failed with status ${res.status}`);
  }

  const json = (await res.json()) as TikWmResponse;
  if (json.code !== 0 || !json.data) {
    throw new Error(
      json.msg ||
        "Could not resolve TikTok video. Check if the link is public.",
    );
  }

  const data = json.data;
  const variants: VideoVariant[] = [];
  if (data.hdplay) {
    variants.push({ label: "HD (No watermark)", url: data.hdplay });
  }
  if (data.play) {
    variants.push({ label: "Standard (No watermark)", url: data.play });
  }
  if (data.wmplay) {
    variants.push({ label: "Original with watermark", url: data.wmplay });
  }

  return {
    id: data.id || "tiktok",
    platform: "tiktok",
    title: data.title || "TikTok Video",
    author: data.author?.nickname
      ? `${data.author.nickname} (@${data.author.unique_id})`
      : "TikTok User",
    avatar: data.author?.avatar,
    thumbnail: data.cover,
    duration: data.duration,
    videoUrl: variants[0]?.url || data.play || "",
    variants,
  };
}

async function resolveFacebook(url: string): Promise<ResolvedVideo> {
  let targetUrl = url;
  if (url.includes("/share/") || url.includes("fb.watch")) {
    try {
      const headRes = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        redirect: "follow",
      });
      targetUrl = headRes.url || url;
    } catch {
      // ignore redirect failure and fallback to original url
      void 0;
    }
  }

  const match =
    targetUrl.match(/(?:reels?|videos)\/(?:[^/]+\/)?(\d+)/) ||
    targetUrl.match(/[?&]v=(\d+)/);
  const videoId = match ? match[1] : "fb-video";

  const embedUrl = `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(
    videoId !== "fb-video"
      ? `https://www.facebook.com/watch/?v=${videoId}`
      : targetUrl,
  )}`;
  const res = await fetch(embedUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.facebook.com/",
    },
  });

  if (!res.ok) {
    throw new Error(`Facebook embed request returned ${res.status}`);
  }

  const html = await res.text();
  const variants: VideoVariant[] = [];

  const hdMatch =
    html.match(/"browser_native_hd_url"\s*:\s*("(?:[^"\\]|\\.)*")/) ||
    html.match(/"hd_src"\s*:\s*("(?:[^"\\]|\\.)*")/);
  const sdMatch =
    html.match(/"browser_native_sd_url"\s*:\s*("(?:[^"\\]|\\.)*")/) ||
    html.match(/"sd_src"\s*:\s*("(?:[^"\\]|\\.)*")/);

  if (hdMatch) {
    try {
      variants.push({
        label: "HD Quality",
        url: JSON.parse(hdMatch[1]) as string,
      });
    } catch {
      void 0;
    }
  }
  if (sdMatch) {
    try {
      variants.push({
        label: "SD Quality",
        url: JSON.parse(sdMatch[1]) as string,
      });
    } catch {
      void 0;
    }
  }

  if (!variants.length) {
    throw new Error(
      "Facebook did not expose a public video stream. It may require login or be private.",
    );
  }

  return {
    id: videoId,
    platform: "facebook",
    title: "Facebook Reel",
    author: "Facebook Creator",
    videoUrl: variants[0].url,
    variants,
  };
}

export function handleReelRequest(
  req: IncomingMessage,
  res: ServerResponse,
): boolean {
  const fullUrl = req.url || "";
  const pathname = fullUrl.split("?")[0];

  // 1. Resolve metadata
  if (req.method === "POST" && pathname === "/api/reel/resolve") {
    let body = "";
    req.on("data", (chunk: Buffer | string) => {
      body += chunk.toString();
    });

    req.on("end", async () => {
      try {
        const payload = (body ? JSON.parse(body) : {}) as ResolvePayload;
        const { url, platform: explicitPlatform } = payload;

        if (!url || typeof url !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "URL is required." }));
          return;
        }

        const platform = detectPlatform(url, explicitPlatform);
        if (!platform) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              message: "Unsupported platform. Use TikTok, Facebook, or X.",
            }),
          );
          return;
        }

        let result: ResolvedVideo;
        if (platform === "x") {
          result = await resolveX(url);
        } else if (platform === "tiktok") {
          result = await resolveTikTok(url);
        } else {
          result = await resolveFacebook(url);
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to resolve video";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message }));
      }
    });
    return true;
  }

  // 2. Stream video for preview player (with Range support)
  if (
    req.method === "GET" &&
    (pathname === "/api/reel/stream" || pathname === "/api/reel/download")
  ) {
    (async () => {
      try {
        const urlObj = new URL(fullUrl, "http://localhost");
        const targetUrl = urlObj.searchParams.get("url");
        const filename = urlObj.searchParams.get("filename") || "video.mp4";
        const isDownload = pathname === "/api/reel/download";

        if (!targetUrl) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ message: "url query parameter is required." }),
          );
          return;
        }

        const headers: Record<string, string> = {
          "User-Agent": "Mozilla/5.0",
        };
        if (targetUrl.includes("twimg.com")) {
          headers.Referer = "https://x.com/";
        } else if (targetUrl.includes("fbcdn.net")) {
          headers.Referer = "https://www.facebook.com/";
        } else if (
          targetUrl.includes("tiktokcdn") ||
          targetUrl.includes("tikwm")
        ) {
          headers.Referer = "https://www.tiktok.com/";
        }

        if (req.headers.range) {
          headers.Range = req.headers.range;
        }

        const mediaRes = await fetch(targetUrl, { headers });

        const outHeaders: Record<string, string> = {
          "Content-Type": mediaRes.headers.get("content-type") || "video/mp4",
          "Accept-Ranges": "bytes",
        };

        const cl = mediaRes.headers.get("content-length");
        if (cl) outHeaders["Content-Length"] = cl;

        const cr = mediaRes.headers.get("content-range");
        if (cr) outHeaders["Content-Range"] = cr;

        if (isDownload) {
          outHeaders["Content-Disposition"] =
            `attachment; filename="${encodeURIComponent(filename)}"`;
        }

        res.writeHead(mediaRes.status, outHeaders);

        if (mediaRes.body) {
          const nodeStream = Readable.fromWeb(
            mediaRes.body as unknown as Parameters<typeof Readable.fromWeb>[0],
          );
          nodeStream.on("error", () => {
            // Client closed or aborted stream
          });
          res.on("close", () => {
            nodeStream.destroy();
          });
          nodeStream.pipe(res);
        } else {
          res.end();
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Streaming failed";
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message }));
      }
    })();
    return true;
  }

  return false;
}

export function reelEndpoint(): Plugin {
  return {
    name: "hub-william-reel-endpoint",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const handled = handleReelRequest(req, res);
        if (handled) return;
        next();
      });
    },
  };
}
