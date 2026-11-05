//! Gemini gateway: native requests wrapped for Code Assist, the model list, and the
//! response stream unwrapped for the client.

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use chrono::Utc;
use serde_json::{Value, json};
use uuid::Uuid;

use super::gemini_verification::inspect_gemini_forbidden_response;
use crate::{
    api::{
        agent::{
            ANTIGRAVITY_CLIENT_VERSION, CredentialLookup, gateway_credential,
            load_gemini_code_assist,
        },
        gateway::{
            database_error,
            keys::authorize_gateway_key,
            proxy::{
                RejectedCredential, UpstreamDisposition, attempt_budget,
                handle_rejected_credential, retry_delay, should_forward_response_header,
                should_retry_same_candidate, upstream_disposition,
            },
            selection::{
                GatewaySelection, claim_candidate, mark_active, mark_rate_limited,
                reauthorization_error, release_probe, selected_provider_candidates, served_by,
            },
            upstream_network_error,
            usage::{UsageEvent, UsageObserver, UsageOutcome, quota_snapshot, usage_event},
        },
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub async fn gemini_request(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (model, operation) = parse_gemini_operation(&path)?;
    gemini_proxy_request(&state, model, operation, &headers, body).await
}

pub async fn gemini_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    gemini_models_for_user(&state, authorized.into()).await
}

pub(crate) async fn gemini_models_for_user(
    state: &AppState,
    selection: GatewaySelection,
) -> Result<Json<Value>, ApiError> {
    let candidates = selected_provider_candidates(state, selection, AgentProvider::Gemini).await?;
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
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
        let access_token = token.get("access_token").and_then(Value::as_str);
        let project = token
            .get("cloudaicompanion_project")
            .and_then(Value::as_str);
        let (Some(access_token), Some(project)) =
            (access_token.map(str::to_owned), project.map(str::to_owned))
        else {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        };
        if credential_provider != AgentProvider::Gemini {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        }
        let mut access_token = access_token;
        let project = current_gemini_project(state, &access_token, &project).await;
        let upstream_url = format!(
            "{}/v1internal:fetchAvailableModels",
            state.config.gemini_code_assist_url.trim_end_matches('/')
        );
        let mut credential_retried = false;
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let upstream = match state
                .gateway_http
                .post(&upstream_url)
                .bearer_auth(&access_token)
                .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
                .json(&json!({ "project": project }))
                .send()
                .await
            {
                Ok(upstream) => upstream,
                Err(error) => {
                    last_error = Some(upstream_network_error(AgentProvider::Gemini, error));
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
                        continue 'candidates;
                    }
                    tokio::time::sleep(retry_delay(attempts_used, None)).await;
                    continue;
                }
            };
            match gemini_upstream_disposition(upstream.status()) {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    match handle_rejected_credential(
                        state,
                        candidate.id,
                        AgentProvider::Gemini,
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
                    last_error = Some(ApiError::Provider(format!(
                        "Google model discovery returned HTTP {} after {attempts_used} attempts.",
                        upstream.status()
                    )));
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
                        continue 'candidates;
                    }
                    tokio::time::sleep(retry_delay(attempts_used, Some(upstream.headers()))).await;
                    continue;
                }
                UpstreamDisposition::NextPool | UpstreamDisposition::Return => {
                    if !upstream.status().is_success() {
                        // A challenge on this listing is not proof that the login
                        // is dead: Google answers model discovery with the
                        // free-tier ineligibility notice for accounts that still
                        // serve generations. Fail over instead of marking a
                        // reconnect the owner cannot fix.
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        last_error = Some(ApiError::Provider(format!(
                            "Google model discovery returned HTTP {}.",
                            upstream.status()
                        )));
                        continue 'candidates;
                    }
                }
            }
            let payload = upstream.json::<Value>().await.map_err(|_| {
                ApiError::Provider("Google returned an invalid Gemini model catalogue.".to_owned())
            })?;
            mark_active(state, candidate.id).await?;
            return Ok(Json(gemini_model_catalogue(&payload)));
        }
    }

    if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(reauthorization_error(selection))
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
}

#[derive(Clone, Copy)]
pub(crate) enum GeminiOperation {
    Generate,
    StreamGenerate,
    CountTokens,
}

impl GeminiOperation {
    fn path(self) -> &'static str {
        match self {
            Self::Generate => "/v1internal:generateContent",
            Self::StreamGenerate => "/v1internal:streamGenerateContent?alt=sse",
            Self::CountTokens => "/v1internal:countTokens",
        }
    }

    fn streams(self) -> bool {
        matches!(self, Self::StreamGenerate)
    }
}

pub(crate) fn parse_gemini_operation(path: &str) -> Result<(&str, GeminiOperation), ApiError> {
    let (model, operation) = path
        .trim_start_matches('/')
        .rsplit_once(':')
        .ok_or(ApiError::NotFound)?;
    if model.is_empty() || model.contains('/') {
        return Err(ApiError::NotFound);
    }
    let operation = match operation {
        "generateContent" => GeminiOperation::Generate,
        "streamGenerateContent" => GeminiOperation::StreamGenerate,
        "countTokens" => GeminiOperation::CountTokens,
        _ => return Err(ApiError::NotFound),
    };
    Ok((model, operation))
}

pub(super) async fn current_gemini_project(
    state: &AppState,
    access_token: &str,
    stored_project: &str,
) -> String {
    load_gemini_code_assist(state, access_token, Some(stored_project))
        .await
        .ok()
        .and_then(|payload| {
            payload
                .get("cloudaicompanionProject")
                .and_then(Value::as_str)
                .filter(|project| !project.is_empty())
                .map(str::to_owned)
        })
        .unwrap_or_else(|| stored_project.to_owned())
}

async fn gemini_proxy_request(
    state: &AppState,
    model: &str,
    operation: GeminiOperation,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(state, request_headers).await?;
    gemini_proxy_request_for_user(state, authorized.into(), model, operation, body).await
}

pub(crate) async fn gemini_proxy_request_for_user(
    state: &AppState,
    selection: GatewaySelection,
    model: &str,
    operation: GeminiOperation,
    body: Bytes,
) -> Result<Response, ApiError> {
    let candidates = selected_provider_candidates(state, selection, AgentProvider::Gemini).await?;
    let request_body: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::Validation("The Gemini request body must be valid JSON."))?;
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
        if credential_provider != AgentProvider::Gemini {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        }
        let Some(mut access_token) = token
            .get("access_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        };
        let Some(project) = token
            .get("cloudaicompanion_project")
            .and_then(Value::as_str)
        else {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            last_error = Some(ApiError::Provider(
                "The Gemini subscription did not return a Code Assist project. Reconnect it."
                    .to_owned(),
            ));
            continue;
        };
        let project = current_gemini_project(state, &access_token, project).await;
        let upstream_body = gemini_code_assist_request(model, &project, operation, &request_body);
        let upstream_url = format!(
            "{}{}",
            state.config.gemini_code_assist_url.trim_end_matches('/'),
            operation.path()
        );
        let mut credential_retried = false;
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let upstream = match state
                .gateway_http
                .post(&upstream_url)
                .bearer_auth(&access_token)
                .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
                .header("content-type", "application/json")
                .json(&upstream_body)
                .send()
                .await
            {
                Ok(upstream) => upstream,
                Err(error) => {
                    last_error = Some(upstream_network_error(AgentProvider::Gemini, error));
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
                            "Gemini gateway attempt {attempts_used}/{budget} failed before a response; trying the next account"
                        );
                        continue 'candidates;
                    }
                    let delay = retry_delay(attempts_used, None);
                    eprintln!(
                        "Gemini gateway attempt {attempts_used}/{budget} failed before a response; retrying in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    continue;
                }
            };
            match gemini_upstream_disposition(upstream.status()) {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    match handle_rejected_credential(
                        state,
                        candidate.id,
                        AgentProvider::Gemini,
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
                UpstreamDisposition::NextPool => {
                    let (verification_required, validation_url, forwarded) =
                        inspect_gemini_forbidden_response(upstream).await?;
                    if verification_required {
                        if crate::api::agent::mark_gemini_verification_required(
                            state,
                            candidate.id,
                            &access_token,
                            validation_url.as_deref(),
                        )
                        .await?
                        {
                            saw_reauthorization = true;
                        } else if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                    } else {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        last_pool_response = Some(forwarded);
                    }
                    continue 'candidates;
                }
                UpstreamDisposition::RetryTransient => {
                    eprintln!(
                        "Gemini gateway attempt {attempts_used}/{budget} returned HTTP {}",
                        upstream.status()
                    );
                    if attempts_used >= budget {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        return gemini_upstream_response(
                            upstream,
                            operation,
                            selection.connection_id.is_some(),
                        )
                        .await;
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
                    eprintln!("Gemini gateway retry scheduled in {} ms", delay.as_millis());
                    tokio::time::sleep(delay).await;
                    continue;
                }
                UpstreamDisposition::Return => {}
            }
            mark_active(state, candidate.id).await?;
            let usage_event = if upstream.status().is_success()
                && !matches!(operation, GeminiOperation::CountTokens)
            {
                Some(usage_event(
                    state,
                    selection,
                    candidate.id,
                    AgentProvider::Gemini,
                    Some(model.trim_start_matches("models/")),
                ))
            } else {
                None
            };
            return gemini_upstream_response_with_usage(
                upstream,
                operation,
                selection.connection_id.is_some(),
                usage_event,
            )
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

pub(crate) fn gemini_code_assist_request(
    model: &str,
    project: &str,
    operation: GeminiOperation,
    request: &Value,
) -> Value {
    let model = antigravity_model_id(model.trim_start_matches("models/"), request);
    match operation {
        GeminiOperation::CountTokens => json!({
            "request": {
                "model": format!("models/{model}"),
                "contents": request.get("contents").cloned().unwrap_or(Value::Array(Vec::new()))
            }
        }),
        GeminiOperation::Generate | GeminiOperation::StreamGenerate => json!({
            "model": model,
            "project": project,
            "requestId": format!(
                "agent/{}/{}/{}/0",
                Uuid::new_v4(),
                Utc::now().timestamp_millis(),
                Uuid::new_v4()
            ),
            "request": request,
            "userAgent": "antigravity",
            "requestType": "agent"
        }),
    }
}

pub(crate) fn antigravity_model_id(model: &str, request: &Value) -> String {
    let thinking_budget = request
        .pointer("/generationConfig/thinkingConfig/thinkingBudget")
        .and_then(Value::as_i64);
    let flash_variant = || match thinking_budget {
        Some(-1) => "high",
        Some(budget) if budget <= 1_000 => "low",
        _ => "medium",
    };
    match model {
        "gemini-4-argon" => format!("gemini-4-argon-{}", flash_variant()),
        "gemini-3.8-flash" => format!("gemini-3.8-flash-{}", flash_variant()),
        "gemini-3.7-flash" => format!("gemini-3.7-flash-{}", flash_variant()),
        "gemini-3.6-flash" => format!("gemini-3.6-flash-{}", flash_variant()),
        "gemini-3.1-pro-preview-customtools" => "gemini-3.1-pro-high".to_owned(),
        "gemini-3.1-pro-preview" | "gemini-3.1-pro" => {
            if thinking_budget == Some(-1) {
                "gemini-3.1-pro-high".to_owned()
            } else {
                "gemini-3.1-pro-low".to_owned()
            }
        }
        _ => model.to_owned(),
    }
}

pub(crate) fn gemini_model_catalogue(payload: &Value) -> Value {
    let available = payload
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let models = crate::utils::provider_catalogue::provider(AgentProvider::Gemini)
        .chat_models()
        .filter_map(|model| {
            let identifier = &model.id;
            let metadata = available.get(identifier)?;
            let display_name = metadata.get("displayName").and_then(Value::as_str)?;
            if display_name.is_empty()
                || metadata
                    .get("isInternal")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                return None;
            }
            Some(json!({
                "id": identifier,
                "object": "model",
                "owned_by": "google",
                "name": display_name,
            }))
        })
        .collect::<Vec<_>>();
    json!({ "object": "list", "data": models })
}

pub(crate) fn unwrap_gemini_response(mut wrapper: Value) -> Value {
    let trace_id = wrapper
        .get("traceId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let Some(mut response) = wrapper.get_mut("response").map(Value::take) else {
        return wrapper;
    };
    if let (Some(trace_id), Some(object)) = (trace_id, response.as_object_mut()) {
        object.insert("responseId".to_owned(), Value::String(trace_id));
    }
    response
}

pub(crate) async fn gemini_upstream_response(
    upstream: reqwest::Response,
    operation: GeminiOperation,
    cancel_on_disconnect: bool,
) -> Result<Response, ApiError> {
    gemini_upstream_response_with_usage(upstream, operation, cancel_on_disconnect, None).await
}

async fn gemini_upstream_response_with_usage(
    upstream: reqwest::Response,
    operation: GeminiOperation,
    cancel_on_disconnect: bool,
    usage_event: Option<UsageEvent>,
) -> Result<Response, ApiError> {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    if !status.is_success() {
        return response
            .body(Body::from_stream(upstream.bytes_stream()))
            .map_err(|_| ApiError::Internal);
    }
    if !operation.streams() {
        let wrapper = upstream.json::<Value>().await.map_err(|_| {
            ApiError::Provider("Google returned an invalid Gemini response.".to_owned())
        })?;
        let payload = unwrap_gemini_response(wrapper);
        if let Some(event) = usage_event {
            let mut observer = UsageObserver::new(AgentProvider::Gemini, false);
            observer.read_value(&payload);
            let completed = observer.completed;
            let outcome = if completed {
                UsageOutcome::Completed
            } else {
                UsageOutcome::Incomplete
            };
            let usage = observer.usage.has_tokens().then_some(observer.usage);
            let quota = quota_snapshot(&headers, observer.quota_event);
            event
                .record(outcome, usage, quota, completed)
                .await
                .map_err(database_error)?;
        }
        return response
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&payload).map_err(|_| ApiError::Internal)?,
            ))
            .map_err(|_| ApiError::Internal);
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tokio::spawn(async move {
        use futures_util::StreamExt;

        let mut stream = upstream.bytes_stream();
        let mut transformer = GeminiSseTransformer::default();
        let mut usage_observer = usage_event
            .as_ref()
            .map(|_| UsageObserver::new(AgentProvider::Gemini, true));
        let mut client_gone = false;
        let mut complete = false;
        loop {
            let item = tokio::select! {
                biased;
                _ = tx.closed(), if cancel_on_disconnect => break,
                item = stream.next() => item,
            };
            let Some(item) = item else {
                complete = true;
                break;
            };
            match item {
                Ok(bytes) => {
                    if let Some(observer) = usage_observer.as_mut() {
                        observer.push(&bytes);
                    }
                    let transformed = transformer.push(&bytes);
                    if !transformed.is_empty()
                        && !client_gone
                        && tx.send(Ok(transformed)).await.is_err()
                    {
                        client_gone = true;
                    }
                }
                Err(error) => {
                    if !client_gone {
                        let _ = tx.send(Err(std::io::Error::other(error))).await;
                    }
                    break;
                }
            }
        }
        let tail = transformer.finish();
        if !tail.is_empty() && !client_gone && tx.send(Ok(tail)).await.is_err() {
            client_gone = true;
        }
        if let (Some(event), Some(observer)) = (usage_event, usage_observer) {
            let quota = quota_snapshot(&headers, observer.quota_event.clone());
            let partial = observer.usage.has_tokens().then_some(observer.usage);
            let (provider_complete, usage) = if complete {
                observer.finish_with_completion()
            } else {
                (false, None)
            };
            let (outcome, usage) = if provider_complete {
                (UsageOutcome::Completed, usage)
            } else {
                (UsageOutcome::Incomplete, partial)
            };
            // Organizations only count a response the client received in full.
            let finished_for_client = provider_complete && !client_gone;
            if let Err(error) = event
                .record(outcome, usage, quota, finished_for_client)
                .await
            {
                eprintln!("organization usage insert failed: {error}");
            }
        }
    });
    response
        .header(header::CONTENT_TYPE, "text/event-stream")
        .body(Body::from_stream(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        ))
        .map_err(|_| ApiError::Internal)
}

#[derive(Default)]
pub(crate) struct GeminiSseTransformer {
    pending: Vec<u8>,
}

impl GeminiSseTransformer {
    pub(crate) fn push(&mut self, chunk: &[u8]) -> Bytes {
        self.pending.extend_from_slice(chunk);
        let mut output = Vec::new();
        while let Some(newline) = self.pending.iter().position(|byte| *byte == b'\n') {
            let line = self.pending.drain(..=newline).collect::<Vec<_>>();
            output.extend(transform_gemini_sse_line(&line));
        }
        Bytes::from(output)
    }

    fn finish(self) -> Bytes {
        Bytes::from(transform_gemini_sse_line(&self.pending))
    }
}

fn transform_gemini_sse_line(line: &[u8]) -> Vec<u8> {
    let has_newline = line.ends_with(b"\n");
    let text = String::from_utf8_lossy(line);
    let trimmed = text.trim_end_matches(['\r', '\n']);
    let normalized = || format!("{trimmed}{}", if has_newline { "\n" } else { "" }).into_bytes();
    if trimmed.is_empty() {
        return normalized();
    }
    let Some(payload) = trimmed.strip_prefix("data:").map(str::trim) else {
        return normalized();
    };
    if payload.is_empty() || payload == "[DONE]" {
        return normalized();
    }
    let Ok(wrapper) = serde_json::from_str::<Value>(payload) else {
        return normalized();
    };
    let Ok(serialized) = serde_json::to_string(&unwrap_gemini_response(wrapper)) else {
        return normalized();
    };
    format!("data: {serialized}{}", if has_newline { "\n" } else { "" }).into_bytes()
}

pub(crate) fn gemini_upstream_disposition(status: StatusCode) -> UpstreamDisposition {
    if status == StatusCode::FORBIDDEN {
        // Code Assist can reject one account or project while another pool can
        // serve the same request. A 403 alone does not prove OAuth needs renewal.
        UpstreamDisposition::NextPool
    } else {
        upstream_disposition(status)
    }
}
