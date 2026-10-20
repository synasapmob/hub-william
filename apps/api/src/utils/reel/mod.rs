//! Resolves one public TikTok, Facebook or X video link into direct media URLs, and
//! opens those media URLs for relaying. Every outbound request is limited to known
//! platform and CDN hosts, so neither the link nor a redirect can steer the server
//! at an internal address.

use std::{
    io,
    sync::{Arc, OnceLock},
    time::Duration,
};

use axum::body::Bytes;
use futures_util::{Stream, StreamExt};
use reqwest::{Client, StatusCode, Url, header, redirect::Policy};
use serde::{Deserialize, Serialize};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use utoipa::ToSchema;

use crate::core::ApiError;

const USER_AGENT: &str = "Mozilla/5.0";
const MAX_REDIRECTS: usize = 5;
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(20);
// Platform pages and API replies are small; anything larger is not a video page.
const MAX_PAGE_BYTES: usize = 8 * 1024 * 1024;
// A reel is tens of megabytes. The cap keeps one request from draining bandwidth.
const MAX_MEDIA_BYTES: u64 = 256 * 1024 * 1024;
const MAX_CONCURRENT_RELAYS: usize = 8;
const X_API_URL: &str = "https://api.fxtwitter.com/i/status/";
const TIKTOK_API_URL: &str = "https://www.tikwm.com/api/";
const FACEBOOK_EMBED_URL: &str = "https://www.facebook.com/plugins/video.php";

const X_ROOTS: &[&str] = &["x.com", "twitter.com"];
const TIKTOK_ROOTS: &[&str] = &["tiktok.com"];
const FACEBOOK_ROOTS: &[&str] = &["facebook.com", "fb.watch"];
const MEDIA_ROOTS: &[&str] = &[
    "fbcdn.net",
    "twimg.com",
    "tiktokcdn.com",
    "tiktokcdn-us.com",
    "tikwm.com",
];
// Hosts a redirect may land on besides the platform and media hosts above.
const API_ROOTS: &[&str] = &["fxtwitter.com"];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Platform {
    X,
    Tiktok,
    Facebook,
}

impl Platform {
    fn roots(self) -> &'static [&'static str] {
        match self {
            Self::X => X_ROOTS,
            Self::Tiktok => TIKTOK_ROOTS,
            Self::Facebook => FACEBOOK_ROOTS,
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ResolveRequest {
    /// Link to one public video or reel.
    #[serde(default)]
    pub url: String,
    /// `x`, `twitter`, `tiktok` or `facebook`; detected from the link when omitted.
    pub platform: Option<String>,
}

#[derive(Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct VideoVariant {
    pub label: String,
    pub url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bitrate: Option<u64>,
}

#[derive(Debug, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVideo {
    pub id: String,
    pub platform: Platform,
    pub title: String,
    pub author: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration: Option<f64>,
    pub video_url: String,
    pub variants: Vec<VideoVariant>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxTwitterResponse {
    tweet: Option<FxTweet>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxTweet {
    text: Option<String>,
    author: Option<FxAuthor>,
    media: Option<FxMedia>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxAuthor {
    name: Option<String>,
    screen_name: Option<String>,
    avatar_url: Option<String>,
    banner_url: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxMedia {
    videos: Option<Vec<FxMediaItem>>,
    all: Option<Vec<FxMediaItem>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxMediaItem {
    #[serde(rename = "type")]
    kind: Option<String>,
    format: Option<String>,
    thumbnail_url: Option<String>,
    duration: Option<f64>,
    url: Option<String>,
    variants: Option<Vec<FxVariant>>,
    formats: Option<Vec<FxVariant>>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct FxVariant {
    content_type: Option<String>,
    url: Option<String>,
    bitrate: Option<u64>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TikWmResponse {
    code: i64,
    msg: Option<String>,
    data: Option<TikWmData>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TikWmData {
    id: Option<String>,
    title: Option<String>,
    cover: Option<String>,
    duration: Option<f64>,
    play: Option<String>,
    hdplay: Option<String>,
    wmplay: Option<String>,
    author: Option<TikWmAuthor>,
}

#[derive(Default, Deserialize)]
#[serde(default)]
struct TikWmAuthor {
    nickname: Option<String>,
    unique_id: Option<String>,
    avatar: Option<String>,
}

fn host_matches(host: &str, roots: &[&str]) -> bool {
    roots.iter().any(|root| {
        host == *root
            || host
                .strip_suffix(root)
                .is_some_and(|prefix| prefix.ends_with('.'))
    })
}

/// An HTTPS URL on the default port without embedded credentials.
fn public_https(raw: &str) -> Option<Url> {
    let url = Url::parse(raw.trim()).ok()?;
    let plain = url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none();
    plain.then_some(url)
}

fn host_allowed(url: &Url, roots: &[&[&str]]) -> bool {
    url.host_str()
        .is_some_and(|host| roots.iter().any(|group| host_matches(host, group)))
}

fn is_media_url(url: &Url) -> bool {
    host_allowed(url, &[MEDIA_ROOTS])
}

fn media_url(raw: &str) -> Option<String> {
    public_https(raw)
        .filter(is_media_url)
        .map(|url| url.to_string())
}

fn is_redirect_target(url: &Url) -> bool {
    url.scheme() == "https"
        && url.username().is_empty()
        && url.password().is_none()
        && url.port().is_none()
        && host_allowed(
            url,
            &[
                X_ROOTS,
                TIKTOK_ROOTS,
                FACEBOOK_ROOTS,
                MEDIA_ROOTS,
                API_ROOTS,
            ],
        )
}

fn client() -> &'static Client {
    static CLIENT: OnceLock<Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        Client::builder()
            .user_agent(USER_AGENT)
            .connect_timeout(Duration::from_secs(10))
            // Media streams run long; only a stalled connection should time out.
            .read_timeout(Duration::from_secs(30))
            .redirect(Policy::custom(|attempt| {
                if attempt.previous().len() >= MAX_REDIRECTS {
                    attempt.error("too many redirects")
                } else if is_redirect_target(attempt.url()) {
                    attempt.follow()
                } else {
                    attempt.stop()
                }
            }))
            .build()
            .expect("reel HTTP client should build")
    })
}

fn referer_for(url: &Url) -> Option<&'static str> {
    let host = url.host_str()?;
    if host_matches(host, &["twimg.com"]) {
        Some("https://x.com/")
    } else if host_matches(host, &["fbcdn.net"]) {
        Some("https://www.facebook.com/")
    } else if host_matches(host, &["tiktokcdn.com", "tiktokcdn-us.com", "tikwm.com"]) {
        Some("https://www.tiktok.com/")
    } else {
        None
    }
}

fn unreachable_error(service: &str, error: reqwest::Error) -> ApiError {
    ApiError::Provider(format!(
        "Could not reach {service}: {}",
        error.without_url()
    ))
}

fn detect_platform(url: &Url, explicit: Option<&str>) -> Result<Platform, ApiError> {
    let from_name = match explicit.map(str::to_ascii_lowercase).as_deref() {
        Some("x" | "twitter") => Some(Platform::X),
        Some("tiktok") => Some(Platform::Tiktok),
        Some("facebook") => Some(Platform::Facebook),
        _ => None,
    };
    let platform = from_name
        .or_else(|| {
            [Platform::X, Platform::Tiktok, Platform::Facebook]
                .into_iter()
                .find(|platform| host_allowed(url, &[platform.roots()]))
        })
        .ok_or(ApiError::Validation(
            "Unsupported platform. Use TikTok, Facebook, or X.",
        ))?;

    if host_allowed(url, &[platform.roots()]) {
        Ok(platform)
    } else {
        Err(ApiError::Validation(
            "The link does not match the selected platform.",
        ))
    }
}

pub async fn resolve_video(request: &ResolveRequest) -> Result<ResolvedVideo, ApiError> {
    let url = request.url.trim();
    if url.is_empty() {
        return Err(ApiError::Validation("URL is required."));
    }
    let url = public_https(url).ok_or(ApiError::Validation("Use an HTTPS video link."))?;

    match detect_platform(&url, request.platform.as_deref())? {
        Platform::X => resolve_x(&url).await,
        Platform::Tiktok => resolve_tiktok(&url).await,
        Platform::Facebook => resolve_facebook(&url).await,
    }
}

fn digits_segment(segment: Option<&str>) -> Option<String> {
    segment
        .filter(|value| !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .map(str::to_owned)
}

fn x_status_id(url: &Url) -> Option<String> {
    let mut segments = url.path_segments()?;
    segments.find(|segment| matches!(*segment, "status" | "statuses"))?;
    digits_segment(segments.next())
}

fn facebook_video_id(url: &Url) -> Option<String> {
    let segments: Vec<&str> = url.path_segments()?.collect();
    let marker = segments
        .iter()
        .position(|segment| matches!(*segment, "reel" | "reels" | "videos"))?;
    // `/reel/<id>`, or `/<page>/videos/<name>/<id>` where a name precedes the id.
    digits_segment(segments.get(marker + 1).copied())
        .or_else(|| digits_segment(segments.get(marker + 2).copied()))
}

fn facebook_query_id(url: &Url) -> Option<String> {
    url.query_pairs()
        .find(|(key, _)| key == "v")
        .and_then(|(_, value)| digits_segment(Some(value.as_ref())))
}

fn bitrate_label(bitrate: Option<u64>) -> String {
    match bitrate {
        None | Some(0) => "Standard MP4".to_owned(),
        Some(rate) if rate > 20_000_000 => "4K UHD".to_owned(),
        Some(rate) if rate > 8_000_000 => "1080p FHD".to_owned(),
        Some(rate) if rate > 2_000_000 => "720p HD".to_owned(),
        Some(rate) if rate > 700_000 => "360p SD".to_owned(),
        Some(rate) => format!("{} kbps", (rate as f64 / 1000.0).round() as u64),
    }
}

async fn read_capped(mut response: reqwest::Response, service: &str) -> Result<Vec<u8>, ApiError> {
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| unreachable_error(service, error))?
    {
        if body.len() + chunk.len() > MAX_PAGE_BYTES {
            return Err(ApiError::Provider(format!(
                "{service} returned an unexpectedly large response."
            )));
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

fn parse_reply<T: serde::de::DeserializeOwned>(body: &[u8], service: &str) -> Result<T, ApiError> {
    serde_json::from_slice(body)
        .map_err(|_| ApiError::Provider(format!("{service} returned an unreadable response.")))
}

async fn resolve_x(url: &Url) -> Result<ResolvedVideo, ApiError> {
    let tweet_id = x_status_id(url).ok_or(ApiError::Validation(
        "Could not find a Tweet or Video ID in this X link.",
    ))?;

    let response = client()
        .get(format!("{X_API_URL}{tweet_id}"))
        .timeout(RESOLVE_TIMEOUT)
        .send()
        .await
        .map_err(|error| unreachable_error("X", error))?;
    if !response.status().is_success() {
        return Err(ApiError::Provider(format!(
            "X API returned status {}. Tweet may be private, sensitive, or deleted.",
            response.status().as_u16()
        )));
    }
    let data: FxTwitterResponse = parse_reply(&read_capped(response, "X").await?, "X")?;

    x_video(&tweet_id, data)
}

fn x_video(tweet_id: &str, data: FxTwitterResponse) -> Result<ResolvedVideo, ApiError> {
    let tweet = data.tweet.unwrap_or_default();
    let media = tweet.media.unwrap_or_default();
    let primary = media
        .videos
        .filter(|items| !items.is_empty())
        .or(media.all)
        .unwrap_or_default()
        .into_iter()
        .find(|item| {
            item.kind.as_deref() == Some("video")
                || item.format.as_deref() == Some("video/mp4")
                || item.variants.as_ref().is_some_and(|list| !list.is_empty())
        })
        .ok_or_else(|| ApiError::Provider("No video found in this X post.".to_owned()))?;

    let mut variants: Vec<VideoVariant> = primary
        .variants
        .as_deref()
        .or(primary.formats.as_deref())
        .unwrap_or_default()
        .iter()
        .filter(|variant| {
            variant.content_type.as_deref() == Some("video/mp4")
                || variant
                    .url
                    .as_deref()
                    .is_some_and(|url| url.contains(".mp4"))
        })
        .filter_map(|variant| {
            Some(VideoVariant {
                label: bitrate_label(variant.bitrate),
                url: media_url(variant.url.as_deref()?)?,
                bitrate: variant.bitrate,
            })
        })
        .collect();
    variants.sort_by_key(|variant| std::cmp::Reverse(variant.bitrate.unwrap_or(0)));

    let best_url = variants
        .first()
        .map(|variant| variant.url.clone())
        .or_else(|| primary.url.as_deref().and_then(media_url))
        .ok_or_else(|| ApiError::Provider("No video found in this X post.".to_owned()))?;
    if variants.is_empty() {
        variants.push(VideoVariant {
            label: "Original MP4".to_owned(),
            url: best_url.clone(),
            bitrate: None,
        });
    }

    let author = tweet.author.unwrap_or_default();
    Ok(ResolvedVideo {
        id: tweet_id.to_owned(),
        platform: Platform::X,
        title: tweet.text.unwrap_or_else(|| "X Video".to_owned()),
        author: match (&author.name, &author.screen_name) {
            (Some(name), Some(handle)) => format!("{name} (@{handle})"),
            (Some(name), None) => name.clone(),
            _ => "X User".to_owned(),
        },
        avatar: author.avatar_url,
        thumbnail: primary.thumbnail_url.or(author.banner_url),
        duration: primary.duration,
        video_url: best_url,
        variants,
    })
}

async fn resolve_tiktok(url: &Url) -> Result<ResolvedVideo, ApiError> {
    let response = client()
        .get(TIKTOK_API_URL)
        .query(&[("url", url.as_str())])
        .timeout(RESOLVE_TIMEOUT)
        .send()
        .await
        .map_err(|error| unreachable_error("TikTok", error))?;
    if !response.status().is_success() {
        return Err(ApiError::Provider(format!(
            "TikTok resolver failed with status {}",
            response.status().as_u16()
        )));
    }
    let body: TikWmResponse = parse_reply(&read_capped(response, "TikTok").await?, "TikTok")?;

    tiktok_video(body)
}

fn tiktok_video(body: TikWmResponse) -> Result<ResolvedVideo, ApiError> {
    let Some(data) = body.data.filter(|_| body.code == 0) else {
        return Err(ApiError::Provider(body.msg.unwrap_or_else(|| {
            "Could not resolve TikTok video. Check if the link is public.".to_owned()
        })));
    };

    let variants: Vec<VideoVariant> = [
        ("HD (No watermark)", &data.hdplay),
        ("Standard (No watermark)", &data.play),
        ("Original with watermark", &data.wmplay),
    ]
    .into_iter()
    .filter_map(|(label, url)| {
        Some(VideoVariant {
            label: label.to_owned(),
            url: media_url(url.as_deref()?)?,
            bitrate: None,
        })
    })
    .collect();
    let video_url = variants
        .first()
        .map(|variant| variant.url.clone())
        .ok_or_else(|| ApiError::Provider("TikTok did not expose a video stream.".to_owned()))?;

    let author = data.author.unwrap_or_default();
    Ok(ResolvedVideo {
        id: data.id.unwrap_or_else(|| "tiktok".to_owned()),
        platform: Platform::Tiktok,
        title: data.title.unwrap_or_else(|| "TikTok Video".to_owned()),
        author: match (&author.nickname, &author.unique_id) {
            (Some(name), Some(handle)) => format!("{name} (@{handle})"),
            (Some(name), None) => name.clone(),
            _ => "TikTok User".to_owned(),
        },
        avatar: author.avatar,
        thumbnail: data.cover,
        duration: data.duration,
        video_url,
        variants,
    })
}

/// Reads the JSON string that follows `"key":` as data; the page is never evaluated.
fn json_string_value(source: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut offset = 0;
    while let Some(position) = source[offset..].find(&needle) {
        let after_key = offset + position + needle.len();
        offset = after_key;
        let Some(rest) = source[after_key..].trim_start().strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        if !rest.starts_with('"') {
            continue;
        }
        let mut escaped = false;
        for (index, character) in rest.char_indices().skip(1) {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                if let Ok(value) = serde_json::from_str::<String>(&rest[..=index]) {
                    return Some(value);
                }
                break;
            }
        }
    }
    None
}

fn facebook_variants(source: &str) -> Vec<VideoVariant> {
    [
        ("HD Quality", ["browser_native_hd_url", "hd_src"]),
        ("SD Quality", ["browser_native_sd_url", "sd_src"]),
    ]
    .into_iter()
    .filter_map(|(label, keys)| {
        let url = keys
            .into_iter()
            .filter_map(|key| json_string_value(source, key))
            .find_map(|value| media_url(&value))?;
        Some(VideoVariant {
            label: label.to_owned(),
            url,
            bitrate: None,
        })
    })
    .collect()
}

async fn resolve_facebook(url: &Url) -> Result<ResolvedVideo, ApiError> {
    let mut target = url.clone();
    if target.path().contains("/share/")
        || host_matches(target.host_str().unwrap_or(""), &["fb.watch"])
    {
        // Share links redirect to the real reel URL; keep the original if that fails.
        if let Ok(response) = client()
            .get(url.clone())
            .timeout(RESOLVE_TIMEOUT)
            .send()
            .await
        {
            target = response.url().clone();
        }
    }

    let video_id = facebook_video_id(&target).or_else(|| facebook_query_id(&target));
    let href = match &video_id {
        Some(id) => format!("https://www.facebook.com/watch/?v={id}"),
        None => target.to_string(),
    };

    let response = client()
        .get(FACEBOOK_EMBED_URL)
        .query(&[("href", href.as_str())])
        .header(header::REFERER, "https://www.facebook.com/")
        .timeout(RESOLVE_TIMEOUT)
        .send()
        .await
        .map_err(|error| unreachable_error("Facebook", error))?;
    if !response.status().is_success() {
        return Err(ApiError::Provider(format!(
            "Facebook embed request returned {}",
            response.status().as_u16()
        )));
    }
    let html = String::from_utf8_lossy(&read_capped(response, "Facebook").await?).into_owned();

    let variants = facebook_variants(&html);
    let video_url = variants
        .first()
        .map(|variant| variant.url.clone())
        .ok_or_else(|| {
            ApiError::Provider(
                "Facebook did not expose a public video stream. It may require login or be private."
                    .to_owned(),
            )
        })?;

    Ok(ResolvedVideo {
        id: video_id.unwrap_or_else(|| "fb-video".to_owned()),
        platform: Platform::Facebook,
        title: "Facebook Reel".to_owned(),
        author: "Facebook Creator".to_owned(),
        avatar: None,
        thumbnail: None,
        duration: None,
        video_url,
        variants,
    })
}

fn relay_slots() -> &'static Arc<Semaphore> {
    static SLOTS: OnceLock<Arc<Semaphore>> = OnceLock::new();
    SLOTS.get_or_init(|| Arc::new(Semaphore::new(MAX_CONCURRENT_RELAYS)))
}

/// An open upstream video that holds one relay slot until its body is dropped.
pub struct RelayedMedia {
    pub response: reqwest::Response,
    slot: OwnedSemaphorePermit,
}

impl RelayedMedia {
    /// The body bytes, ending in an error once the relay size cap is exceeded.
    pub fn into_body(self) -> impl Stream<Item = Result<Bytes, io::Error>> {
        let chunks = self
            .response
            .bytes_stream()
            .map(|chunk| chunk.map_err(|error| io::Error::other(error.without_url())));

        cap_stream(chunks, self.slot, MAX_MEDIA_BYTES)
    }
}

/// Passes chunks through while `slot` stays held, failing once more than
/// `limit` bytes have gone by.
fn cap_stream<S>(
    stream: S,
    slot: OwnedSemaphorePermit,
    limit: u64,
) -> impl Stream<Item = Result<Bytes, io::Error>>
where
    S: Stream<Item = Result<Bytes, io::Error>>,
{
    let mut sent = 0_u64;

    stream.map(move |chunk| {
        let _held = &slot;
        let chunk = chunk?;
        sent += chunk.len() as u64;
        if sent > limit {
            return Err(io::Error::other("the video exceeds the relay size limit"));
        }

        Ok(chunk)
    })
}

/// Opens a resolved media URL, forwarding the browser's `Range` header so the
/// preview player can seek. Only known CDN hosts are accepted, only a few relays
/// run at once, and a video larger than the relay cap is refused.
pub async fn open_media(raw_url: &str, range: Option<&str>) -> Result<RelayedMedia, ApiError> {
    open_media_with(relay_slots(), raw_url, range).await
}

async fn open_media_with(
    slots: &Arc<Semaphore>,
    raw_url: &str,
    range: Option<&str>,
) -> Result<RelayedMedia, ApiError> {
    let url = public_https(raw_url)
        .filter(is_media_url)
        .ok_or(ApiError::Validation(
            "This link is not a supported media URL.",
        ))?;
    let slot = slots
        .clone()
        .try_acquire_owned()
        .map_err(|_| ApiError::Busy)?;

    let mut request = client().get(url.clone());
    if let Some(referer) = referer_for(&url) {
        request = request.header(header::REFERER, referer);
    }
    if let Some(range) = range {
        request = request.header(header::RANGE, range);
    }
    let response = request
        .send()
        .await
        .map_err(|error| unreachable_error("the media host", error))?;

    let status = response.status();
    if !(status.is_success() || status == StatusCode::RANGE_NOT_SATISFIABLE) {
        return Err(ApiError::Provider(format!(
            "The media host returned status {}.",
            status.as_u16()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_MEDIA_BYTES)
    {
        return Err(ApiError::Validation("This video is too large to download."));
    }

    Ok(RelayedMedia { response, slot })
}

/// Keeps a download name safe inside a `Content-Disposition` header.
pub fn safe_filename(requested: Option<&str>) -> String {
    let cleaned: String = requested
        .unwrap_or("")
        .chars()
        .take(100)
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.trim_matches('.').is_empty() {
        "video.mp4".to_owned()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(raw: &str) -> Url {
        Url::parse(raw).expect("test URL should parse")
    }

    #[test]
    fn host_matching_requires_a_label_boundary() {
        assert!(host_matches("www.facebook.com", FACEBOOK_ROOTS));
        assert!(host_matches("fb.watch", FACEBOOK_ROOTS));
        assert!(!host_matches("evilfacebook.com", FACEBOOK_ROOTS));
        assert!(!host_matches("facebook.com.evil.test", FACEBOOK_ROOTS));
    }

    #[test]
    fn platform_follows_the_link_host_not_its_text() {
        let tweet = url("https://x.com/jack/status/20");
        assert_eq!(detect_platform(&tweet, None).unwrap(), Platform::X);
        assert_eq!(
            detect_platform(&tweet, Some("twitter")).unwrap(),
            Platform::X
        );
        assert!(detect_platform(&tweet, Some("facebook")).is_err());
        assert!(detect_platform(&url("https://evil.test/x.com/status/1"), None).is_err());
    }

    #[test]
    fn media_urls_are_limited_to_known_cdns() {
        assert!(media_url("https://video.fsgn2-10.fna.fbcdn.net/o1/v/video.mp4").is_some());
        assert!(media_url("https://video.twimg.com/ext_tw_video/1/vid/a.mp4").is_some());
        assert!(media_url("http://video.twimg.com/a.mp4").is_none());
        assert!(media_url("https://user:pass@video.twimg.com/a.mp4").is_none());
        assert!(media_url("https://video.twimg.com:8443/a.mp4").is_none());
        assert!(media_url("https://169.254.169.254/latest/meta-data").is_none());
        assert!(media_url("https://fbcdn.net.evil.test/a.mp4").is_none());
    }

    #[test]
    fn redirects_may_not_leave_known_hosts() {
        assert!(is_redirect_target(&url("https://www.facebook.com/reel/1")));
        assert!(is_redirect_target(&url("https://video.fbcdn.net/a.mp4")));
        assert!(!is_redirect_target(&url("https://internal.example/")));
        assert!(!is_redirect_target(&url("http://www.facebook.com/reel/1")));
    }

    #[test]
    fn extracts_video_ids_from_supported_link_shapes() {
        assert_eq!(
            x_status_id(&url("https://x.com/jack/status/20?s=46")).as_deref(),
            Some("20")
        );
        assert_eq!(x_status_id(&url("https://x.com/jack")), None);
        assert_eq!(
            facebook_video_id(&url("https://www.facebook.com/reel/28447394274902429")).as_deref(),
            Some("28447394274902429")
        );
        assert_eq!(
            facebook_video_id(&url("https://www.facebook.com/page/videos/title/123/")).as_deref(),
            Some("123")
        );
        assert_eq!(
            facebook_query_id(&url("https://www.facebook.com/watch/?v=987")).as_deref(),
            Some("987")
        );
        assert_eq!(
            facebook_video_id(&url("https://www.facebook.com/share/r/abc/")),
            None
        );
    }

    #[test]
    fn reads_escaped_json_strings_from_page_source() {
        let source =
            r#"x{"sd_src":null,"hd_src":"https:\/\/video.fbcdn.net\/a.mp4?x=1&y=2","k" : "v"}"#;
        assert_eq!(
            json_string_value(source, "hd_src").as_deref(),
            Some("https://video.fbcdn.net/a.mp4?x=1&y=2")
        );
        assert_eq!(json_string_value(source, "sd_src"), None);
        assert_eq!(json_string_value(source, "k").as_deref(), Some("v"));
        assert_eq!(json_string_value(source, "missing"), None);
    }

    #[test]
    fn facebook_variants_drop_non_cdn_urls() {
        let source = r#"{"browser_native_hd_url":"https://evil.test/a.mp4","hd_src":"https://video.fbcdn.net/hd.mp4","sd_src":"https://video.fbcdn.net/sd.mp4"}"#;
        let variants = facebook_variants(source);

        assert_eq!(variants.len(), 2);
        assert_eq!(variants[0].label, "HD Quality");
        assert_eq!(variants[0].url, "https://video.fbcdn.net/hd.mp4");
        assert_eq!(variants[1].url, "https://video.fbcdn.net/sd.mp4");
    }

    #[test]
    fn x_variants_are_sorted_by_bitrate_and_labelled() {
        let data: FxTwitterResponse = serde_json::from_str(
            r#"{"tweet":{"text":"hi","author":{"name":"Jack","screen_name":"jack"},
            "media":{"videos":[{"type":"video","thumbnail_url":"https://t/x.jpg","variants":[
              {"content_type":"application/x-mpegURL","url":"https://video.twimg.com/a.m3u8"},
              {"content_type":"video/mp4","url":"https://video.twimg.com/low.mp4","bitrate":832000},
              {"content_type":"video/mp4","url":"https://video.twimg.com/high.mp4","bitrate":2176000}]}]}}}"#,
        )
        .unwrap();
        let video = x_video("20", data).unwrap();

        assert_eq!(video.video_url, "https://video.twimg.com/high.mp4");
        assert_eq!(video.author, "Jack (@jack)");
        assert_eq!(video.variants.len(), 2);
        assert_eq!(video.variants[0].label, "720p HD");
        assert_eq!(video.variants[1].label, "360p SD");
    }

    #[test]
    fn x_without_video_reports_a_provider_error() {
        let data: FxTwitterResponse =
            serde_json::from_str(r#"{"tweet":{"text":"no media"}}"#).unwrap();

        assert!(matches!(x_video("1", data), Err(ApiError::Provider(_))));
    }

    #[test]
    fn tiktok_failure_surfaces_the_resolver_message() {
        let body: TikWmResponse =
            serde_json::from_str(r#"{"code":-1,"msg":"Url parsing is failed!"}"#).unwrap();

        match tiktok_video(body) {
            Err(ApiError::Provider(message)) => assert_eq!(message, "Url parsing is failed!"),
            other => panic!("expected a provider error, got {other:?}"),
        }
    }

    #[test]
    fn download_names_cannot_break_out_of_the_header() {
        assert_eq!(safe_filename(Some("facebook-123.mp4")), "facebook-123.mp4");
        assert_eq!(safe_filename(Some("a\"; x=\r\nb.mp4")), "a___x___b.mp4");
        assert_eq!(safe_filename(Some("..")), "video.mp4");
        assert_eq!(safe_filename(None), "video.mp4");
    }

    fn chunks(sizes: &[usize]) -> impl Stream<Item = Result<Bytes, io::Error>> + use<> {
        futures_util::stream::iter(
            sizes
                .iter()
                .map(|size| Ok(Bytes::from(vec![0_u8; *size])))
                .collect::<Vec<_>>(),
        )
    }

    #[tokio::test]
    async fn relay_stream_stops_once_the_size_cap_is_passed() {
        let slots = Arc::new(Semaphore::new(1));
        let slot = slots.clone().try_acquire_owned().unwrap();
        let results: Vec<_> = cap_stream(chunks(&[4, 4, 4]), slot, 10).collect().await;

        assert_eq!(results.len(), 3);
        assert!(results[0].is_ok() && results[1].is_ok());
        assert!(results[2].is_err());
    }

    #[tokio::test]
    async fn relay_slot_is_held_until_the_body_is_dropped() {
        let slots = Arc::new(Semaphore::new(1));
        let slot = slots.clone().try_acquire_owned().unwrap();
        let body = cap_stream(chunks(&[1]), slot, 10);
        assert_eq!(slots.available_permits(), 0);

        drop(body);
        assert_eq!(slots.available_permits(), 1);
    }

    #[tokio::test]
    async fn relay_refuses_new_media_when_every_slot_is_busy() {
        let slots = Arc::new(Semaphore::new(0));
        let result = open_media_with(&slots, "https://video.fbcdn.net/a.mp4", None).await;

        assert!(matches!(result, Err(ApiError::Busy)));
    }

    #[tokio::test]
    #[ignore = "needs network access to facebook.com"]
    async fn live_facebook_reel_resolves_to_a_cdn_mp4() {
        let video = resolve_video(&ResolveRequest {
            url: "https://www.facebook.com/reel/28447394274902429".to_owned(),
            platform: Some("facebook".to_owned()),
        })
        .await
        .expect("public reel should resolve");
        assert_eq!(video.id, "28447394274902429");

        let response = open_media(&video.video_url, Some("bytes=0-1023"))
            .await
            .expect("media should open");
        assert_eq!(response.response.status(), StatusCode::PARTIAL_CONTENT);
        let bytes = response
            .response
            .bytes()
            .await
            .expect("media should stream");
        assert_eq!(&bytes[4..8], b"ftyp");
    }
}
