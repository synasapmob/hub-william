import { useState } from "react";
import { Download, Loader2, AlertCircle, Sparkles } from "lucide-react";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const reelStyles = tv({
  slots: {
    container: "space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4",
    formRow: "flex items-center gap-2",
    select:
      "h-9 shrink-0 rounded-lg border border-zinc-300 bg-white px-3 text-xs font-medium text-zinc-800 transition-colors focus:border-zinc-500 focus:outline-hidden",
    previewCard:
      "space-y-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-xs",
    videoWrapper:
      "relative overflow-hidden rounded-lg bg-black aspect-video flex items-center justify-center max-h-80 w-full",
    videoPlayer: "object-contain size-full",
    errorBanner:
      "flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800",
  },
});

interface ResolvedVideo {
  id: string;
  platform: "x" | "tiktok" | "facebook";
  videoUrl: string;
  thumbnail?: string;
}

export default function ToolsCatalogDownloadReel() {
  const {
    container,
    formRow,
    select,
    previewCard,
    videoWrapper,
    videoPlayer,
    errorBanner,
  } = reelStyles();

  const [url, setUrl] = useState("");
  const [platform, setPlatform] = useState<"x" | "tiktok" | "facebook">("x");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [video, setVideo] = useState<ResolvedVideo | null>(null);

  const handleUrlChange = (value: string) => {
    setUrl(value);
    const lowercase = value.toLowerCase();
    if (lowercase.includes("facebook.com") || lowercase.includes("fb.watch")) {
      setPlatform("facebook");
    } else if (lowercase.includes("tiktok.com")) {
      setPlatform("tiktok");
    } else if (
      lowercase.includes("x.com") ||
      lowercase.includes("twitter.com")
    ) {
      setPlatform("x");
    }
  };

  const handleResolve = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!url.trim()) return;

    setLoading(true);
    setError(null);
    setVideo(null);

    try {
      const res = await fetch("/api/reel/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          url: url.trim(),
          platform,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.message || "Failed to fetch video information.");
      }

      setVideo(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Network error occurred");
    } finally {
      setLoading(false);
    }
  };

  const downloadFilename = video
    ? `${video.platform}-${video.id}.mp4`
    : "video.mp4";

  return (
    <div className={container()}>
      <form onSubmit={handleResolve} className="space-y-3">
        <div className={formRow()}>
          <Input
            type="url"
            placeholder={
              platform === "x"
                ? "Paste X video URL..."
                : platform === "tiktok"
                  ? "Paste TikTok video URL..."
                  : "Paste Facebook reel URL..."
            }
            value={url}
            onChange={(e) => handleUrlChange(e.target.value)}
            className="h-9 flex-1 bg-white text-xs"
            required
          />

          <select
            value={platform}
            onChange={(e) =>
              setPlatform(e.target.value as "x" | "tiktok" | "facebook")
            }
            className={select()}
            aria-label="Select Platform"
          >
            <option value="x">X (Twitter)</option>
            <option value="tiktok">TikTok</option>
            <option value="facebook">Facebook</option>
          </select>
        </div>

        <Button
          type="submit"
          disabled={loading || !url.trim()}
          className="h-9 w-full gap-1.5 font-mono text-xs font-semibold"
        >
          {loading ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          Fetch & Preview
        </Button>
      </form>

      {error && (
        <div className={errorBanner()}>
          <AlertCircle className="size-4 shrink-0 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {video && (
        <div className={previewCard()}>
          <div className={videoWrapper()}>
            <video
              key={video.videoUrl}
              src={`/api/reel/stream?url=${encodeURIComponent(video.videoUrl)}`}
              poster={video.thumbnail}
              controls
              autoPlay={false}
              playsInline
              className={videoPlayer()}
            />
          </div>

          <a
            href={`/api/reel/download?url=${encodeURIComponent(video.videoUrl)}&filename=${encodeURIComponent(downloadFilename)}`}
            download={downloadFilename}
            className="flex h-10 w-full items-center justify-center gap-1.5 rounded-lg bg-emerald-600 font-mono text-xs font-semibold text-white transition-colors hover:bg-emerald-500 focus-visible:outline-hidden"
          >
            <Download className="size-3.5" />
            Download Video
          </a>
        </div>
      )}
    </div>
  );
}
