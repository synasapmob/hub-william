# DOWNLOAD REEL

Download a public TikTok video or Facebook reel to your computer with one shell
command. Choose the platform explicitly; videos are saved with sound in your
Downloads folder. Existing files are kept.

## Requirements

Use Bash and Python 3 on macOS, Linux or WSL. TikTok uses
[yt-dlp](https://pypi.org/project/yt-dlp/), installed on your PATH or in the
Python environment running the script. On macOS, install it with
`brew install yt-dlp`. For other systems, follow yt-dlp's installation guide.
Keep yt-dlp up to date when either site changes.

Facebook uses yt-dlp when available, then tries Facebook's public video embed
if the extractor fails or yt-dlp is missing. The script selects a format with
both video and audio, so ffmpeg is not required; this may be lower resolution
than separate video/audio streams.

## TikTok

Replace `REEL_URL` with your TikTok video link, keep the quotes, and run:

```sh
curl -fsSL https://hub-william.site/download-reel.sh | bash -s -- --platform=tiktok --url='REEL_URL'
```

## Facebook

```sh
curl -fsSL https://hub-william.site/download-reel.sh | bash -s -- --platform=facebook --url='https://www.facebook.com/reel/28447394274902429'
```

Pass your Facebook reel link in `--url='...'`. The script runs directly from
curl; no shell script file needs to be saved first. Quoting the URL preserves
query parameters such as `?v=123&share=1` as one argument.

## Choose a folder

```sh
curl -fsSL https://hub-william.site/download-reel.sh | bash -s -- --platform=facebook --url='REEL_URL' --output-dir='./videos'
```

## Optional interactive prompt

Omit `--url` to paste the link at a terminal prompt instead:

```sh
curl -fsSL https://hub-william.site/download-reel.sh | bash -s -- --platform=facebook
```

Append `--help` for usage. Both `--platform=facebook` and
`--platform facebook` work, as do `--url='REEL_URL'` and `--url 'REEL_URL'`.
The URL must match the selected platform. Profile
and playlist URLs are rejected. An empty URL or Ctrl+C cancels without starting
a download. A command without an interactive terminal must supply `--url` or
a positional URL. Supplying both is an error.

## Availability

Downloads run on your computer; Hub William serves the script and does not
process or store the video. This tool does not read browser cookies or ask for
a Facebook/TikTok password. Private, deleted, login-only or region-restricted
videos may fail. A failure exits with a nonzero status; the Facebook fallback
removes partial files instead of reporting them as downloaded videos.
