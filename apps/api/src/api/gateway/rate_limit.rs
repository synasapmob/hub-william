//! What a provider's 429 says and how long an account then rests: the answer is
//! relayed to the client unchanged, and the provider's own retry delay, when it
//! sends one, decides the cooldown.

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, header},
    response::Response,
};
use chrono::Duration;
use futures_util::{StreamExt, stream};
use serde_json::Value;

use super::{
    proxy::{retry_delay, should_forward_response_header},
    upstream_network_error,
};
use crate::{core::ApiError, utils::provider_catalogue::AgentProvider};

/// How long an account rests when the provider does not say when to retry. Short,
/// because a 429 can belong to one request and not to the account; the probe that
/// follows finds out, and a limit that holds is met with another short rest.
const DEFAULT_COOLDOWN_SECONDS: i64 = 60;
/// A provider delay is followed down to this, so a 429 that clears in seconds
/// does not shut the account for a minute.
const MIN_COOLDOWN_SECONDS: i64 = 1;
/// The longest an account rests, whatever the provider asks.
const MAX_COOLDOWN_MINUTES: i64 = 30;
/// After a 429 the same account is sent the request again this many times
/// before it rests: three sends in all, counting the first.
pub(super) const RATE_LIMIT_RETRIES: usize = 2;
/// A retry waits no longer than this; a provider that asks for more is believed.
const MAX_RETRY_WAIT_MS: i64 = 2_000;
const MAX_ERROR_INSPECTION_BYTES: usize = 64 * 1024;
const LOG_PREVIEW_BYTES: usize = 300;

/// A provider's 429, ready to send to the client as it came.
pub(super) struct RateLimitAnswer {
    pub(super) response: Response,
    /// When the provider said the account may be used again, if it said.
    pub(super) delay: Option<Duration>,
    /// The start of the body on one line, for the log.
    pub(super) preview: String,
}

pub(super) async fn relay_rate_limited(
    provider: AgentProvider,
    mut upstream: reqwest::Response,
) -> Result<RateLimitAnswer, ApiError> {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut prefix = Vec::new();
    let mut overflow = None;
    while prefix.len() < MAX_ERROR_INSPECTION_BYTES {
        let chunk = upstream
            .chunk()
            .await
            .map_err(|error| upstream_network_error(provider, error))?;
        let Some(chunk) = chunk else {
            break;
        };
        let take = chunk.len().min(MAX_ERROR_INSPECTION_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            overflow = Some(chunk.slice(take..));
            break;
        }
    }
    let delay = requested_delay(&headers, &prefix);
    let preview = body_preview(&prefix);
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    let chunks = std::iter::once(Bytes::from(prefix)).chain(overflow);
    let body = Body::from_stream(
        stream::iter(chunks.map(Ok::<_, reqwest::Error>)).chain(upstream.bytes_stream()),
    );
    Ok(RateLimitAnswer {
        response: response.body(body).map_err(|_| ApiError::Internal)?,
        delay,
        preview,
    })
}

/// The longest wait the provider asked for: the `Retry-After` header, a
/// `RetryInfo` detail's `retryDelay`, or a detail's `quotaResetDelay`.
pub(super) fn requested_delay(headers: &HeaderMap, body: &[u8]) -> Option<Duration> {
    let from_header = headers
        .get(header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
        .map(|seconds| seconds as f64);
    let from_body = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|payload| {
            let details = payload.pointer("/error/details")?.as_array()?.clone();
            details
                .iter()
                .flat_map(|detail| {
                    [
                        detail.get("retryDelay"),
                        detail.pointer("/metadata/quotaResetDelay"),
                    ]
                })
                .flatten()
                .filter_map(Value::as_str)
                .filter_map(parse_delay)
                .max_by(f64::total_cmp)
        });
    [from_header, from_body]
        .into_iter()
        .flatten()
        .max_by(f64::total_cmp)
        .map(|seconds| Duration::milliseconds((seconds * 1000.0).round() as i64))
}

/// Seconds in a Google duration such as `34s`, `1.5s`, `250ms` or `2m30s`.
fn parse_delay(text: &str) -> Option<f64> {
    let mut rest = text.trim();
    let mut total = 0.0;
    let mut parsed = false;
    while !rest.is_empty() {
        let number_end =
            rest.find(|character: char| !(character.is_ascii_digit() || character == '.'))?;
        let number: f64 = rest.get(..number_end)?.parse().ok()?;
        rest = &rest[number_end..];
        let (factor, unit_length) = if rest.starts_with("ms") {
            (0.001, 2)
        } else if rest.starts_with('s') {
            (1.0, 1)
        } else if rest.starts_with('m') {
            (60.0, 1)
        } else if rest.starts_with('h') {
            (3600.0, 1)
        } else {
            return None;
        };
        total += number * factor;
        rest = &rest[unit_length..];
        parsed = true;
    }
    parsed.then_some(total)
}

/// How long to rest an account after a 429: what the provider asked for, kept
/// between a second and 30 minutes; the short default when it did not ask.
pub(super) fn cooldown_for(delay: Option<Duration>) -> Duration {
    delay.map_or(Duration::seconds(DEFAULT_COOLDOWN_SECONDS), |delay| {
        delay.clamp(
            Duration::seconds(MIN_COOLDOWN_SECONDS),
            Duration::minutes(MAX_COOLDOWN_MINUTES),
        )
    })
}

/// How long to wait before sending a request to an account again after its 429,
/// or none when it should rest instead. `retries_done` counts the retries
/// already sent. A probe is a single call, and a provider that asks for a wait
/// longer than a retry would take is believed rather than asked again.
pub(super) fn rate_limit_retry(
    asked: Option<Duration>,
    retries_done: usize,
    probe: bool,
) -> Option<std::time::Duration> {
    if probe
        || retries_done >= RATE_LIMIT_RETRIES
        || asked.is_some_and(|asked| asked > Duration::milliseconds(MAX_RETRY_WAIT_MS))
    {
        return None;
    }
    let backoff = retry_delay(retries_done + 1, None);
    Some(
        asked
            .and_then(|asked| asked.to_std().ok())
            .map_or(backoff, |asked| asked.max(backoff)),
    )
}

pub(super) fn body_preview(body: &[u8]) -> String {
    let end = body.len().min(LOG_PREVIEW_BYTES);
    String::from_utf8_lossy(&body[..end])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}
