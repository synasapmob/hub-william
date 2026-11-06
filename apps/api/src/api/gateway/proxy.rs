//! Forwards a request to the provider with failover and retries, and returns the
//! upstream response.

use axum::{
    body::{Body, Bytes},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{StreamExt, stream};
use rand::RngCore;
use serde_json::{Value, json};
use uuid::Uuid;

use super::{
    CLAUDE_COUNT_TOKENS_URL, CLAUDE_MESSAGES_URL, GROK_RESPONSES_URL, OPENAI_RESPONSES_URL,
    keys::authorize_gateway_key,
    selection::{
        GatewaySelection, claim_candidate, mark_active, mark_rate_limited, mark_reauth_required,
        reauthorization_error, release_probe, selected_provider_candidates, served_by,
    },
    upstream_network_error,
    usage::{UsageEvent, UsageGuard, UsageObserver, usage_event},
};
use crate::{
    api::{
        agent::{CredentialLookup, gateway_credential, recover_rejected_credential},
        gateway::providers::gemini::{GeminiOperation, gemini_proxy_request_for_user},
        service,
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub(crate) async fn response_for_user(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
    model: &str,
    body: Bytes,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        key_id: None,
        user_id,
        connection_id: Some(connection_id),
        organization_id: None,
        service: false,
    };
    response_for_selection(state, selection, provider, model, body).await
}

/// A Playground chat in the Service's scope: served by the platform's stock, held
/// to the price list and charged to the user's wallet, like a service key's.
pub(crate) async fn response_for_service_user(
    state: &AppState,
    user_id: Uuid,
    provider: AgentProvider,
    model: &str,
    body: Bytes,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        key_id: None,
        user_id,
        connection_id: None,
        organization_id: None,
        service: true,
    };
    response_for_selection(state, selection, provider, model, body).await
}

pub(crate) async fn response_for_organization_user(
    state: &AppState,
    user_id: Uuid,
    organization_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
    model: &str,
    body: Bytes,
) -> Result<Response, ApiError> {
    response_for_selection(
        state,
        GatewaySelection {
            key_id: None,
            user_id,
            connection_id: Some(connection_id),
            organization_id: Some(organization_id),
            service: false,
        },
        provider,
        model,
        body,
    )
    .await
}

pub(super) async fn response_for_selection(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
    model: &str,
    body: Bytes,
) -> Result<Response, ApiError> {
    if provider == AgentProvider::Gemini {
        return gemini_proxy_request_for_user(
            state,
            selection,
            model,
            GeminiOperation::StreamGenerate,
            body,
        )
        .await;
    }
    let (url, body) = match provider {
        AgentProvider::Chatgpt => (
            OPENAI_RESPONSES_URL.to_owned(),
            strip_unsupported_codex_fields(body),
        ),
        AgentProvider::Claude => (
            CLAUDE_MESSAGES_URL.to_owned(),
            ensure_claude_billing_header(body, &state.config.claude_client_version),
        ),
        AgentProvider::Grok => (GROK_RESPONSES_URL.to_owned(), body),
        AgentProvider::Deepseek => (format!("{}/responses", state.config.deepseek_api_url), body),
        AgentProvider::Groq => (format!("{}/responses", state.config.groq_api_url), body),
        AgentProvider::Gemini => unreachable!("Gemini uses its native gateway path"),
    };
    let mut headers = HeaderMap::new();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        header::ACCEPT,
        HeaderValue::from_static("text/event-stream"),
    );
    proxy_request_for_user(
        state,
        selection,
        GatewayUpstream {
            provider,
            url: &url,
        },
        Method::POST,
        &axum::http::Uri::from_static("/"),
        &headers,
        body,
    )
    .await
}
/// Minimum upstream send budget per request. A larger pool gets one send per
/// account so failover can reach every account before the request fails.
const MAX_UPSTREAM_ATTEMPTS: usize = 4;
const MAX_SAME_CANDIDATE_ATTEMPTS: usize = 2;
const RETRY_BASE_DELAY_MS: u64 = 500;
const RETRY_MAX_DELAY_MS: u64 = 2_000;

#[derive(Debug, PartialEq)]
pub(super) enum UpstreamDisposition {
    Return,
    RateLimit,
    Reauthorize,
    RetryTransient,
    NextPool,
}

pub(crate) fn ensure_claude_billing_header(body: Bytes, version: &str) -> Bytes {
    let Ok(mut value) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };
    let billing_text =
        format!("x-anthropic-billing-header: cc_version={version}.bd6; cc_entrypoint=sdk-cli;");

    let Some(map) = value.as_object_mut() else {
        return body;
    };

    match map.get_mut("system") {
        Some(Value::String(s)) => {
            if !s.contains("x-anthropic-billing-header") {
                *s = format!("{billing_text}\n\n{s}");
            }
        }
        Some(Value::Array(arr)) => {
            let already_has = arr.iter().any(|item| {
                item.get("text")
                    .and_then(Value::as_str)
                    .is_some_and(|t| t.contains("x-anthropic-billing-header"))
            });
            if !already_has {
                arr.insert(0, json!({ "type": "text", "text": billing_text }));
            }
        }
        _ => {
            map.insert(
                "system".to_string(),
                json!([{ "type": "text", "text": billing_text }]),
            );
        }
    }

    serde_json::to_vec(&value).map(Bytes::from).unwrap_or(body)
}

pub(super) async fn proxy_request(
    state: &AppState,
    expected_provider: AgentProvider,
    upstream_url: &str,
    method: Method,
    original_uri: &axum::http::Uri,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(state, request_headers).await?;
    proxy_request_for_user(
        state,
        authorized.into(),
        GatewayUpstream {
            provider: expected_provider,
            url: upstream_url,
        },
        method,
        original_uri,
        request_headers,
        body,
    )
    .await
}

pub(super) struct GatewayUpstream<'a> {
    pub(super) provider: AgentProvider,
    pub(super) url: &'a str,
}

pub(super) async fn proxy_request_for_user(
    state: &AppState,
    selection: GatewaySelection,
    upstream: GatewayUpstream<'_>,
    method: Method,
    original_uri: &axum::http::Uri,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let expected_provider = upstream.provider;
    // A key that pays from the wallet needs a model the service sells and a
    // balance before anything is sent to the provider.
    if method == Method::POST && upstream.url != CLAUDE_COUNT_TOKENS_URL {
        service::authorize_request(
            &state.pool,
            selection.service.then_some(selection.user_id),
            expected_provider,
            request_model(&body).as_deref(),
        )
        .await?;
    }
    let candidates = selected_provider_candidates(state, selection, expected_provider).await?;
    let upstream_url = append_query(upstream.url, original_uri.query());
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
    let mut last_pool_response = None;
    let candidate_count = candidates.len();
    let budget = attempt_budget(candidate_count);
    let mut attempts_used = 0;

    'candidates: for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if attempts_used >= budget {
            break;
        }
        let claimed_probe = match claim_candidate(state, &candidate).await {
            Ok(Some(claimed_probe)) => claimed_probe,
            Ok(None) => {
                if candidate.availability_status == "reauth_required" {
                    saw_reauthorization = true;
                } else {
                    saw_rate_limit = true;
                }
                continue;
            }
            Err(error) => return Err(error),
        };
        let (credential_provider, token) = match gateway_credential(state, candidate.id).await {
            Ok(CredentialLookup::Ready(provider, token)) => (provider, token),
            Ok(CredentialLookup::ReauthorizationRequired) => {
                saw_reauthorization = true;
                continue;
            }
            Err(error) => {
                if claimed_probe {
                    release_probe(state, candidate.id).await?;
                }
                last_error = Some(error);
                continue;
            }
        };
        if credential_provider != expected_provider {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        }
        let mut token = token;
        let mut access_token = match token.get("access_token").and_then(Value::as_str) {
            Some(access_token) => access_token.to_owned(),
            None => {
                if claimed_probe {
                    release_probe(state, candidate.id).await?;
                }
                last_error = Some(ApiError::Forbidden);
                continue;
            }
        };
        let mut credential_retried = false;
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let mut request = state
                .gateway_http
                .request(method.clone(), &upstream_url)
                .bearer_auth(&access_token)
                .body(body.clone());

            for (name, value) in request_headers {
                if should_forward_request_header(name) {
                    request = request.header(name, value);
                }
            }
            request = match expected_provider {
                AgentProvider::Chatgpt => {
                    let mut request = request.header("originator", "codex_cli_rs").header(
                        "user-agent",
                        format!("codex_cli_rs/{}", state.config.codex_client_version),
                    );
                    if let Some(account_id) = chatgpt_account_id(&token) {
                        request = request.header("chatgpt-account-id", account_id);
                    }
                    request
                }
                AgentProvider::Claude => {
                    let version = request_headers
                        .get("anthropic-version")
                        .cloned()
                        .unwrap_or_else(|| HeaderValue::from_static("2023-06-01"));
                    request
                        .header("anthropic-version", version)
                        .header("anthropic-beta", merged_anthropic_beta(request_headers))
                        .header(
                            "user-agent",
                            format!(
                                "claude-cli/{} (external, sdk-cli)",
                                state.config.claude_client_version
                            ),
                        )
                        .header("x-app", "cli")
                        .header("anthropic-dangerous-direct-browser-access", "true")
                }
                AgentProvider::Gemini => request,
                AgentProvider::Deepseek | AgentProvider::Groq => request,
                AgentProvider::Grok => {
                    let grok_headers = grok_proxy_headers(
                        &state.config.grok_client_version,
                        &body,
                        method != Method::GET,
                    );
                    request.headers(grok_headers)
                }
            };

            let upstream = match request.send().await {
                Ok(upstream) => upstream,
                Err(error) => {
                    last_error = Some(upstream_network_error(expected_provider, error));
                    if attempts_used >= budget {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        break 'candidates;
                    }
                    let retry_same = should_retry_same_candidate(
                        attempts_used,
                        candidate_attempts,
                        candidate_index,
                        candidate_count,
                    );
                    if !retry_same {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        eprintln!(
                            "{expected_provider} gateway attempt {attempts_used}/{budget} failed before a response; trying the next account"
                        );
                        continue 'candidates;
                    }
                    let delay = retry_delay(attempts_used, None);
                    eprintln!(
                        "{expected_provider} gateway attempt {attempts_used}/{budget} failed before a response; retrying in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };
            let disposition = match upstream.status() {
                StatusCode::FORBIDDEN if expected_provider == AgentProvider::Grok => {
                    UpstreamDisposition::Reauthorize
                }
                // A 403 (plan, entitlement or policy) or 402 (no balance left)
                // is about this account; another account may still serve.
                StatusCode::FORBIDDEN | StatusCode::PAYMENT_REQUIRED => {
                    UpstreamDisposition::NextPool
                }
                status => upstream_disposition(status),
            };
            match disposition {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    match handle_rejected_credential(
                        state,
                        candidate.id,
                        expected_provider,
                        &access_token,
                        credential_retried,
                    )
                    .await?
                    {
                        RejectedCredential::Retry(refreshed) => {
                            credential_retried = true;
                            access_token = refreshed
                                .get("access_token")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .to_owned();
                            token = refreshed;
                            // A rejected login produced no generation, so its
                            // send does not spend the failover budget.
                            attempts_used -= 1;
                            candidate_attempts -= 1;
                            continue;
                        }
                        RejectedCredential::ReauthorizationRequired => {
                            saw_reauthorization = true;
                            continue 'candidates;
                        }
                        RejectedCredential::NextAccount(error) => {
                            if claimed_probe {
                                release_probe(state, candidate.id).await?;
                            }
                            last_error = Some(error);
                            continue 'candidates;
                        }
                    }
                }
                UpstreamDisposition::RetryTransient => {
                    eprintln!(
                        "{expected_provider} gateway attempt {attempts_used}/{budget} returned HTTP {}",
                        upstream.status()
                    );
                    if attempts_used >= budget {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        return upstream_response(upstream).await;
                    }
                    let retry_same = should_retry_same_candidate(
                        attempts_used,
                        candidate_attempts,
                        candidate_index,
                        candidate_count,
                    );
                    if !retry_same {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        continue 'candidates;
                    }
                    let delay = retry_delay(attempts_used, Some(upstream.headers()));
                    eprintln!(
                        "{expected_provider} gateway retry scheduled in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
                UpstreamDisposition::NextPool => {
                    if claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    last_pool_response = Some(upstream_response(upstream).await?);
                    continue 'candidates;
                }
                UpstreamDisposition::Return => {}
            }
            mark_active(state, candidate.id).await?;
            let usage_event = if method == Method::POST
                && upstream.url().as_str() != CLAUDE_COUNT_TOKENS_URL
                && upstream.status().is_success()
            {
                let requested_model = request_model(&body);
                Some(usage_event(
                    state,
                    selection,
                    candidate.id,
                    expected_provider,
                    requested_model.as_deref(),
                ))
            } else {
                None
            };
            return upstream_response_with_usage(upstream, usage_event)
                .await
                .map(|response| served_by(response, selection, candidate.id));
        }
    }

    if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(reauthorization_error(selection))
    } else if let Some(response) = last_pool_response {
        Ok(response)
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
}

async fn upstream_response(upstream: reqwest::Response) -> Result<Response, ApiError> {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .map_err(|error| {
            eprintln!("gateway response construction failed: {error}");
            ApiError::Internal
        })
}

fn request_model(body: &Bytes) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("model")?
        .as_str()
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
}

pub(super) async fn upstream_response_with_usage(
    upstream: reqwest::Response,
    usage_event: Option<UsageEvent>,
) -> Result<Response, ApiError> {
    let Some(event) = usage_event else {
        return upstream_response(upstream).await;
    };
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let sse = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.starts_with("text/event-stream"));
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }

    let guard = UsageGuard::new(
        event.clone(),
        UsageObserver::new(event.provider, sse),
        &headers,
    );
    let observed_stream = stream::unfold(
        (upstream.bytes_stream(), guard),
        |(mut bytes_stream, mut guard)| async move {
            match bytes_stream.next().await {
                Some(Ok(bytes)) => {
                    guard.push(&bytes);
                    Some((Ok(bytes), (bytes_stream, guard)))
                }
                Some(Err(error)) => {
                    guard.fail();
                    Some((Err(error), (bytes_stream, guard)))
                }
                None => {
                    guard.finish().await;
                    None
                }
            }
        },
    );
    response
        .body(Body::from_stream(observed_stream))
        .map_err(|error| {
            eprintln!("gateway response construction failed: {error}");
            ApiError::Internal
        })
}

pub(super) fn upstream_disposition(status: StatusCode) -> UpstreamDisposition {
    match status {
        StatusCode::TOO_MANY_REQUESTS => UpstreamDisposition::RateLimit,
        StatusCode::UNAUTHORIZED => UpstreamDisposition::Reauthorize,
        StatusCode::REQUEST_TIMEOUT
        | StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => UpstreamDisposition::RetryTransient,
        _ => UpstreamDisposition::Return,
    }
}

pub(super) fn attempt_budget(candidate_count: usize) -> usize {
    MAX_UPSTREAM_ATTEMPTS.max(candidate_count)
}

pub(super) fn should_retry_same_candidate(
    attempts_used: usize,
    candidate_attempts: usize,
    candidate_index: usize,
    candidate_count: usize,
) -> bool {
    let budget = attempt_budget(candidate_count);
    if attempts_used >= budget {
        return false;
    }
    let remaining_candidates = candidate_count.saturating_sub(candidate_index + 1);
    remaining_candidates == 0
        || (candidate_attempts < MAX_SAME_CANDIDATE_ATTEMPTS
            && budget - attempts_used > remaining_candidates)
}

/// What to do after a provider rejected an account's access token.
pub(super) enum RejectedCredential {
    /// Retry the same account once with this refreshed or already rotated credential.
    Retry(Value),
    /// The account now needs its owner to reconnect it.
    ReauthorizationRequired,
    /// Recovery could not finish; try the next account without marking this one.
    NextAccount(ApiError),
}

/// A provider 401 is not proof that the login is gone: the access token may have
/// expired early or been rotated by another request. Refresh it once (or pick up
/// the token another request already rotated in) and retry; mark the account
/// for reconnect only when the refresh credential is rejected or the provider
/// also rejects the fresh token.
pub(super) async fn handle_rejected_credential(
    state: &AppState,
    connection_id: Uuid,
    provider: AgentProvider,
    observed_access_token: &str,
    already_retried: bool,
) -> Result<RejectedCredential, ApiError> {
    if !already_retried {
        return Ok(
            match recover_rejected_credential(state, connection_id, observed_access_token).await {
                Ok(CredentialLookup::Ready(refreshed_provider, token))
                    if refreshed_provider == provider
                        && token.get("access_token").and_then(Value::as_str).is_some() =>
                {
                    RejectedCredential::Retry(token)
                }
                Ok(CredentialLookup::Ready(..)) => {
                    RejectedCredential::NextAccount(ApiError::Forbidden)
                }
                Ok(CredentialLookup::ReauthorizationRequired) => {
                    RejectedCredential::ReauthorizationRequired
                }
                Err(error) => {
                    eprintln!(
                        "{provider} connection {connection_id} was rejected upstream and could not be refreshed: {error:?}"
                    );
                    RejectedCredential::NextAccount(error)
                }
            },
        );
    }
    if mark_reauth_required(state, connection_id, observed_access_token).await? {
        Ok(RejectedCredential::ReauthorizationRequired)
    } else {
        Ok(RejectedCredential::NextAccount(ApiError::Provider(
            format!("{} rejected this account's login.", provider.label()),
        )))
    }
}

pub(super) fn retry_delay(retry_number: usize, headers: Option<&HeaderMap>) -> std::time::Duration {
    let exponent = retry_number.saturating_sub(1).min(usize::BITS as usize - 1);
    let base_ms = RETRY_BASE_DELAY_MS
        .saturating_mul(1_u64 << exponent)
        .min(RETRY_MAX_DELAY_MS);
    let jitter_span = base_ms / 5;
    let jittered_ms = (base_ms.saturating_sub(jitter_span)
        + rand::thread_rng().next_u64() % (jitter_span.saturating_mul(2) + 1))
        .min(RETRY_MAX_DELAY_MS);
    let retry_after_ms = headers
        .and_then(|headers| headers.get(header::RETRY_AFTER))
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u64>().ok())
        .map(|seconds| seconds.saturating_mul(1_000).min(RETRY_MAX_DELAY_MS))
        .unwrap_or_default();
    std::time::Duration::from_millis(jittered_ms.max(retry_after_ms))
}

fn append_query(url: &str, query: Option<&str>) -> String {
    query.map_or_else(|| url.to_owned(), |query| format!("{url}?{query}"))
}

pub(super) fn strip_unsupported_codex_fields(body: Bytes) -> Bytes {
    let Ok(mut payload) = serde_json::from_slice::<Value>(&body) else {
        return body;
    };
    let Some(payload) = payload.as_object_mut() else {
        return body;
    };
    if payload.remove("max_output_tokens").is_none() {
        return body;
    }
    Bytes::from(serde_json::to_vec(&payload).unwrap_or_else(|_| body.to_vec()))
}

pub(super) fn grok_proxy_headers(
    client_version: &str,
    body: &Bytes,
    include_affinity: bool,
) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert("x-xai-token-auth", HeaderValue::from_static("xai-grok-cli"));
    headers.insert(
        "x-authenticateresponse",
        HeaderValue::from_static("authenticate-response"),
    );
    headers.insert(
        "x-grok-client-identifier",
        HeaderValue::from_static("hub-william"),
    );
    headers.insert("x-grok-client-mode", HeaderValue::from_static("headless"));
    if let Ok(version) = HeaderValue::from_str(client_version) {
        headers.insert("x-grok-client-version", version);
    }
    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_static(concat!("hub-william/", env!("CARGO_PKG_VERSION"))),
    );
    if !include_affinity {
        return headers;
    }

    let session_id = Uuid::new_v4().to_string();
    let request_id = Uuid::new_v4().to_string();
    let model = serde_json::from_slice::<Value>(body)
        .ok()
        .and_then(|payload| payload.get("model")?.as_str().map(str::to_owned))
        .unwrap_or_else(|| "grok-build".to_owned());
    for (name, value) in [
        ("x-grok-conv-id", session_id.as_str()),
        ("x-grok-req-id", request_id.as_str()),
        ("x-grok-model-override", model.as_str()),
        ("x-grok-session-id", session_id.as_str()),
    ] {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
    headers
}

fn should_forward_request_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "authorization"
            | "connection"
            | "content-length"
            | "cookie"
            | "host"
            | "proxy-authorization"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
            | "x-api-key"
            | "x-goog-api-key"
    )
}

pub(super) fn should_forward_response_header(name: &HeaderName) -> bool {
    !matches!(
        name.as_str(),
        "connection"
            | "content-length"
            | "proxy-authenticate"
            | "set-cookie"
            | "te"
            | "trailer"
            | "transfer-encoding"
            | "upgrade"
    )
}

pub(super) fn merged_anthropic_beta(headers: &HeaderMap) -> HeaderValue {
    let existing = headers
        .get("anthropic-beta")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let mut parts: Vec<&str> = existing
        .split(',')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if !parts.contains(&"claude-code-20250219") {
        parts.push("claude-code-20250219");
    }
    if !parts.contains(&"oauth-2025-04-20") {
        parts.push("oauth-2025-04-20");
    }
    let value = parts.join(",");
    HeaderValue::from_str(&value)
        .unwrap_or_else(|_| HeaderValue::from_static("claude-code-20250219,oauth-2025-04-20"))
}

pub(crate) fn chatgpt_account_id(token: &Value) -> Option<String> {
    token
        .get("account_id")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| {
            let jwt = token
                .get("id_token")
                .or_else(|| token.get("access_token"))
                .and_then(Value::as_str)?;
            let payload = jwt.split('.').nth(1)?;
            let decoded = URL_SAFE_NO_PAD.decode(payload).ok()?;
            let claims: Value = serde_json::from_slice(&decoded).ok()?;
            claims
                .get("https://api.openai.com/auth.chatgpt_account_id")
                .or_else(|| claims.pointer("/https:~1~1api.openai.com~1auth/chatgpt_account_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
}
