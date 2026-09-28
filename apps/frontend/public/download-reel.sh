#!/usr/bin/env bash
# DOWNLOAD REEL — one public TikTok or Facebook video, saved locally.
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  echo "DOWNLOAD REEL requires Python 3. Install python3 and try again." >&2
  exit 1
fi

exec python3 - "$@" <<'PYTHON'
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlsplit
from urllib.request import Request, urlopen


def parse_args(argv=None):
    parser = argparse.ArgumentParser(
        prog="download-reel.sh",
        description="Download one public TikTok or Facebook video with sound.",
        epilog="Requires Python 3. TikTok requires yt-dlp on PATH (or in this Python). "
        "Facebook also tries its public video embed if yt-dlp is unavailable or fails.",
    )
    parser.add_argument("--platform", required=True, choices=("tiktok", "facebook"))
    parser.add_argument("--output-dir", default="~/Downloads", help="Destination folder (default: ~/Downloads)")
    parser.add_argument("--url", help="HTTPS link to one video or reel")
    parser.add_argument("positional_url", nargs="?", metavar="URL",
                        help="Alternative to --url; omit both to paste the link at the prompt")
    args = parser.parse_args(argv)
    if args.url is not None and args.positional_url is not None:
        parser.error("Supply the video link with --url or as a positional URL, not both.")
    if args.url is None:
        args.url = args.positional_url
    try:
        if args.url is None:
            args.url = prompt_url(args.platform)
        validate_url(args.url, args.platform)
    except ValueError as error:
        parser.error(str(error))
    return args


def prompt_url(platform):
    # stdin carries the script for curl | bash and Python's heredoc, so read
    # pasted input from the controlling terminal instead of from that pipe.
    try:
        with open("/dev/tty", "r", encoding="utf-8") as terminal, \
                open("/dev/tty", "w", encoding="utf-8") as display:
            print("Paste %s video URL, then press Enter: " % platform,
                  end="", file=display, flush=True)
            url = terminal.readline().strip()
    except OSError:
        raise ValueError("No interactive terminal. Pass the video URL with --url='VIDEO_URL'.") from None
    if not url:
        raise ValueError("No URL entered. Nothing was downloaded.")
    return url


def validate_url(url, platform):
    parsed = urlsplit(url)
    roots = ("tiktok.com",) if platform == "tiktok" else ("facebook.com", "fb.watch")
    host = parsed.hostname or ""
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port not in (None, 443)
            or not any(host == root or host.endswith("." + root) for root in roots)):
        raise ValueError("Use an HTTPS %s video link matching --platform." % platform)
    path = parsed.path
    if platform == "tiktok":
        video = re.fullmatch(r"/@[^/]+/video/\d+/?", path)
        short = (host in ("vm.tiktok.com", "vt.tiktok.com") and re.fullmatch(r"/[^/]+/?", path))
        share = re.fullmatch(r"/t/[^/]+/?", path)
    else:
        video = facebook_id(url)
        short = host == "fb.watch" and re.fullmatch(r"/[^/]+/?", path)
        share = re.fullmatch(r"/share/[rv]/[^/]+/?", path)
    if not (video or short or share):
        raise ValueError("Use a single video/reel link, not a profile, feed or playlist.")


def facebook_id(url):
    parsed = urlsplit(url)
    match = re.search(r"/(?:reels?|videos)/(?:[^/]+/)?(\d+)/?$", parsed.path)
    if match:
        return match[1]
    value = parse_qs(parsed.query).get("v", [""])[0]
    if parsed.path.rstrip("/") in ("/watch", "/video.php") and re.fullmatch(r"\d+", value):
        return value
    return None


def yt_dlp_command():
    executable = shutil.which("yt-dlp")
    if executable:
        return [executable]
    if importlib.util.find_spec("yt_dlp") is not None:
        return [sys.executable, "-m", "yt_dlp"]
    return None


def download_with_yt_dlp(command, args, folder):
    # A combined video/audio format works without installing ffmpeg. Ignore
    # personal yt-dlp config so this command cannot unexpectedly run hooks,
    # download playlists, read browser cookies or overwrite existing files.
    return subprocess.run(command + [
        "--ignore-config", "--no-playlist", "--playlist-end", "1",
        "--no-overwrites", "--restrict-filenames", "--no-progress",
        "--socket-timeout", "30", "--retries", "2",
        "--format", "best[ext=mp4][vcodec!=none][acodec!=none]/best[vcodec!=none][acodec!=none]",
        "--paths", str(folder), "--output", args.platform + "-%(id)s.%(ext)s",
        "--print", "after_move:filepath", "--", args.url,
    ], check=False).returncode


def facebook_media(source):
    # Read JSON strings as data; never evaluate JavaScript from the page.
    for key in ("browser_native_hd_url", "hd_src", "browser_native_sd_url", "sd_src"):
        for match in re.finditer(r'"' + key + r'"\s*:\s*("(?:[^"\\]|\\.)*")', source):
            url = json.loads(match[1])
            parsed = urlsplit(url)
            if (parsed.scheme == "https" and not parsed.username and not parsed.password
                    and parsed.port in (None, 443)
                    and (parsed.hostname or "").endswith(".fbcdn.net")):
                return url
    raise ValueError("Facebook did not expose a public video. It may require login or be unavailable.")


def request(url):
    return urlopen(Request(url, headers={
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.facebook.com/",
    }), timeout=30)


def save_facebook_video(url, destination):
    if destination.exists():
        print("Already exists: %s" % destination)
        return
    temporary = None
    try:
        with request(url) as response, tempfile.NamedTemporaryFile(
            dir=destination.parent, prefix=".download-reel-", suffix=".part", delete=False
        ) as output:
            temporary = Path(output.name)
            first = response.read(64 * 1024)
            if len(first) < 12 or first[4:8] != b"ftyp":
                raise ValueError("Facebook returned an invalid MP4; no video was saved.")
            output.write(first)
            total = len(first)
            while True:
                chunk = response.read(64 * 1024)
                if not chunk:
                    break
                output.write(chunk)
                total += len(chunk)
            expected = response.headers.get("Content-Length")
            if expected and total != int(expected):
                raise ValueError("The download was incomplete; no video was saved. Try again.")
        # Publish only a complete download, without ever replacing another file.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            print("Already exists: %s" % destination)
            return
        print("Saved: %s" % destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def download_facebook(url, folder):
    video_id = facebook_id(url)
    if not video_id:
        with request(url) as response:
            resolved = response.geturl()
        validate_url(resolved, "facebook")
        video_id = facebook_id(resolved)
    if not video_id:
        raise ValueError("Could not resolve this Facebook share link. Copy the reel's full URL and retry.")
    destination = folder / ("facebook-%s.mp4" % video_id)
    if destination.exists():
        print("Already exists: %s" % destination)
        return
    embed = "https://www.facebook.com/plugins/video.php?" + urlencode({
        "href": "https://www.facebook.com/watch/?v=" + video_id,
    })
    with request(embed) as response:
        source = response.read(8 * 1024 * 1024).decode("utf-8")
    save_facebook_video(facebook_media(source), destination)


def main(argv=None):
    args = parse_args(argv)
    command = yt_dlp_command()
    if command is None and args.platform == "tiktok":
        print("TikTok requires yt-dlp. Install it with your package manager "
              "(macOS: brew install yt-dlp), then run this command again.", file=sys.stderr)
        return 1
    folder = Path(args.output_dir).expanduser().resolve()
    folder.mkdir(parents=True, exist_ok=True)
    if command:
        result = download_with_yt_dlp(command, args, folder)
        if result == 0:
            return 0
        if args.platform == "tiktok":
            print("TikTok download failed. Update yt-dlp and check that the video is public "
                  "and playable from your network.", file=sys.stderr)
            return result if result > 0 else 1
    if args.platform == "facebook":
        print("Trying Facebook's public video embed...", flush=True)
        download_facebook(args.url, folder)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except HTTPError as error:
        print("Facebook request failed (HTTP %s). Check the public link and retry." % error.code, file=sys.stderr)
        sys.exit(1)
    except (ValueError, OSError, URLError) as error:
        print("Download failed: %s" % error, file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Download canceled.", file=sys.stderr)
        sys.exit(130)
PYTHON
