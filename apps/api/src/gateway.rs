use axum::{
    Json,
    body::{Body, Bytes},
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::Response,
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AgentProvider, AppState, auth::authenticated_user_id, connections::provider_credential,
    error::ApiError, pool_share, usage,
};

const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_COUNT_TOKENS_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";
const GROK_CHAT_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";
const GEMINI_CLIENT_VERSION: &str = "antigravity/1.2.0";

#[derive(Debug, Serialize, ToSchema)]
pub struct GatewayKey {
    pub created_at: DateTime<Utc>,
    pub id: Uuid,
    pub last_four: String,
    pub last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct CreatedGatewayKey {
    #[serde(flatten)]
    pub metadata: GatewayKey,
    pub key: String,
}

#[derive(Debug, FromRow)]
struct GatewayKeyRow {
    created_at: DateTime<Utc>,
    id: Uuid,
    last_four: String,
    last_used_at: Option<DateTime<Utc>>,
}

#[derive(Debug, FromRow)]
struct AuthorizedGatewayKey {
    id: Uuid,
    user_id: Uuid,
}

#[derive(Debug, FromRow)]
struct ProviderCandidate {
    availability_status: String,
    id: Uuid,
    rate_limited_until: Option<DateTime<Utc>>,
}

#[derive(Debug, PartialEq)]
enum UpstreamDisposition {
    Return,
    RateLimit,
    Reauthorize,
}

#[utoipa::path(
    post,
    path = "/gateway-keys",
    responses(
        (status = 201, description = "Gateway key created and returned once", body = CreatedGatewayKey),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse),
        (status = 404, description = "Connected provider not found", body = crate::ErrorResponse)
    ),
    tag = "gateway keys"
)]
pub async fn create_key(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(StatusCode, Json<CreatedGatewayKey>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let has_connection = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(
            SELECT 1
            FROM agent_connections AS connections
            LEFT JOIN agent_pool_join_requests AS requests
              ON requests.connection_id = connections.id
             AND requests.requester_user_id = $1
             AND requests.status = 'accepted'
            WHERE connections.status = 'connected'
              AND (connections.user_id = $1 OR requests.id IS NOT NULL)
         )",
    )
    .bind(user_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    if !has_connection {
        return Err(ApiError::NotFound);
    }

    let key = generate_gateway_key();
    let key_hash = hash_gateway_key(&key);
    let last_four: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let id = Uuid::new_v4();
    let row = sqlx::query_as::<_, GatewayKeyRow>(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four)
         VALUES ($1, $2, $3, $4)
         RETURNING id, last_four, created_at, last_used_at",
    )
    .bind(id)
    .bind(user_id)
    .bind(key_hash)
    .bind(last_four)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;

    Ok((
        StatusCode::CREATED,
        Json(CreatedGatewayKey {
            metadata: gateway_key_from_row(row)?,
            key,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/gateway-keys",
    responses(
        (status = 200, description = "Active gateway keys", body = [GatewayKey]),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse)
    ),
    tag = "gateway keys"
)]
pub async fn list_keys(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<GatewayKey>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, GatewayKeyRow>(
        "SELECT id, last_four, created_at, last_used_at
         FROM gateway_keys
         WHERE gateway_keys.user_id = $1 AND gateway_keys.revoked_at IS NULL
         ORDER BY gateway_keys.created_at DESC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    let keys = rows
        .into_iter()
        .map(gateway_key_from_row)
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(keys))
}

#[utoipa::path(
    delete,
    path = "/gateway-keys/{key_id}",
    params(("key_id" = Uuid, Path, description = "Gateway key ID")),
    responses(
        (status = 204, description = "Gateway key revoked"),
        (status = 404, description = "Gateway key not found", body = crate::ErrorResponse)
    ),
    tag = "gateway keys"
)]
pub async fn revoke_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(key_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let result = sqlx::query(
        "UPDATE gateway_keys SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL",
    )
    .bind(key_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    Ok(StatusCode::NO_CONTENT)
}

pub async fn openai_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Chatgpt,
        OPENAI_RESPONSES_URL,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn claude_messages(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_MESSAGES_URL,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn claude_count_tokens(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_COUNT_TOKENS_URL,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn grok_chat(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_CHAT_URL,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn grok_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    connected_provider_ids(&state, authorized.user_id, AgentProvider::Grok).await?;

    Ok(Json(json!({
        "object": "list",
        "data": [{
            "id": "grok-build",
            "object": "model",
            "owned_by": "xai"
        }]
    })))
}

pub async fn gemini_request(
    State(state): State<AppState>,
    Path(path): Path<String>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let (model, operation) = parse_gemini_operation(&path)?;
    gemini_proxy_request(&state, model, operation, &headers, body).await
}

#[derive(Clone, Copy)]
enum GeminiOperation {
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

    fn records_usage(self) -> bool {
        !matches!(self, Self::CountTokens)
    }

    fn streams(self) -> bool {
        matches!(self, Self::StreamGenerate)
    }
}

fn parse_gemini_operation(path: &str) -> Result<(&str, GeminiOperation), ApiError> {
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

async fn gemini_proxy_request(
    state: &AppState,
    model: &str,
    operation: GeminiOperation,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(state, request_headers).await?;
    let candidates =
        connected_provider_candidates(state, authorized.user_id, AgentProvider::Gemini).await?;
    let request_body: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::Validation("The Gemini request body must be valid JSON."))?;
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut saw_share_exhausted = false;
    let mut last_error = None;

    for candidate in candidates {
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
        let (credential_provider, token) = match provider_credential(state, candidate.id).await {
            Ok(credential) => credential,
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
        let Some(access_token) = token.get("access_token").and_then(Value::as_str) else {
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
        if operation.records_usage()
            && !pool_share::allow_gateway_request(
                state,
                candidate.id,
                authorized.user_id,
                AgentProvider::Gemini,
            )
            .await
        {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            saw_share_exhausted = true;
            continue;
        }

        let upstream_body = gemini_code_assist_request(model, project, operation, &request_body);
        let upstream_url = format!(
            "{}{}",
            state.config.gemini_code_assist_url.trim_end_matches('/'),
            operation.path()
        );
        let upstream = match state
            .http
            .post(upstream_url)
            .bearer_auth(access_token)
            .header("user-agent", GEMINI_CLIENT_VERSION)
            .header("content-type", "application/json")
            .json(&upstream_body)
            .send()
            .await
        {
            Ok(upstream) => upstream,
            Err(error) => {
                if claimed_probe {
                    release_probe(state, candidate.id).await?;
                }
                last_error = Some(upstream_network_error(AgentProvider::Gemini, error));
                continue;
            }
        };
        match upstream_disposition(upstream.status()) {
            UpstreamDisposition::RateLimit => {
                mark_rate_limited(state, candidate.id).await?;
                saw_rate_limit = true;
                continue;
            }
            UpstreamDisposition::Reauthorize => {
                mark_reauth_required(state, candidate.id).await?;
                saw_reauthorization = true;
                continue;
            }
            UpstreamDisposition::Return => {}
        }
        mark_active(state, candidate.id).await?;
        return gemini_upstream_response(
            state.clone(),
            candidate.id,
            authorized.user_id,
            upstream,
            operation,
        )
        .await;
    }

    if saw_share_exhausted {
        Err(ApiError::ShareExhausted)
    } else if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(ApiError::Provider(
            "Every accessible pool for this provider needs to reconnect.".to_owned(),
        ))
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
}

fn gemini_code_assist_request(
    model: &str,
    project: &str,
    operation: GeminiOperation,
    request: &Value,
) -> Value {
    let model = model.trim_start_matches("models/");
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
            "user_prompt_id": Uuid::new_v4().to_string(),
            "request": request
        }),
    }
}

fn unwrap_gemini_response(mut wrapper: Value) -> Value {
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

async fn gemini_upstream_response(
    state: AppState,
    connection_id: Uuid,
    user_id: Uuid,
    upstream: reqwest::Response,
    operation: GeminiOperation,
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
        if operation.records_usage()
            && let Some(counts) = usage::tokens_from_value(&payload)
        {
            usage::record_event(&state, connection_id, user_id, counts).await;
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
        let mut extractor = usage::UsageExtractor::default();
        let mut client_gone = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    let transformed = transformer.push(&bytes);
                    extractor.push(&transformed);
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
        extractor.push(&tail);
        if !tail.is_empty() && !client_gone {
            let _ = tx.send(Ok(tail)).await;
        }
        drop(tx);
        if let Some(counts) = extractor.finish() {
            usage::record_event(&state, connection_id, user_id, counts).await;
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
struct GeminiSseTransformer {
    pending: Vec<u8>,
}

impl GeminiSseTransformer {
    fn push(&mut self, chunk: &[u8]) -> Bytes {
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
    let Some(payload) = trimmed.strip_prefix("data:").map(str::trim) else {
        return line.to_vec();
    };
    if payload.is_empty() || payload == "[DONE]" {
        return line.to_vec();
    }
    let Ok(wrapper) = serde_json::from_str::<Value>(payload) else {
        return line.to_vec();
    };
    let Ok(serialized) = serde_json::to_string(&unwrap_gemini_response(wrapper)) else {
        return line.to_vec();
    };
    format!("data: {serialized}{}", if has_newline { "\n" } else { "" }).into_bytes()
}

async fn proxy_request(
    state: &AppState,
    expected_provider: AgentProvider,
    upstream_url: &str,
    original_uri: &axum::http::Uri,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(state, request_headers).await?;
    let candidates =
        connected_provider_candidates(state, authorized.user_id, expected_provider).await?;
    let upstream_url = append_query(upstream_url, original_uri.query());
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut saw_share_exhausted = false;
    let mut last_error = None;

    for candidate in candidates {
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
        let (credential_provider, token) = match provider_credential(state, candidate.id).await {
            Ok(credential) => credential,
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
        let access_token = match token.get("access_token").and_then(Value::as_str) {
            Some(access_token) => access_token,
            None => {
                if claimed_probe {
                    release_probe(state, candidate.id).await?;
                }
                last_error = Some(ApiError::Forbidden);
                continue;
            }
        };
        let record_usage = !upstream_url.contains("count_tokens");
        if record_usage
            && !pool_share::allow_gateway_request(
                state,
                candidate.id,
                authorized.user_id,
                expected_provider,
            )
            .await
        {
            if claimed_probe {
                release_probe(state, candidate.id).await?;
            }
            saw_share_exhausted = true;
            continue;
        }

        let mut request = state
            .http
            .post(&upstream_url)
            .bearer_auth(access_token)
            .body(body.clone());

        for (name, value) in request_headers {
            if should_forward_request_header(name) {
                request = request.header(name, value);
            }
        }
        request = match expected_provider {
            AgentProvider::Chatgpt => {
                let mut request = request
                    .header("originator", "codex_cli_rs")
                    .header("user-agent", "codex_cli_rs/0.153.4");
                if let Some(account_id) = chatgpt_account_id(&token) {
                    request = request.header("chatgpt-account-id", account_id);
                }
                request
            }
            AgentProvider::Claude => {
                request.header("anthropic-beta", merged_anthropic_beta(request_headers))
            }
            AgentProvider::Gemini => request,
            AgentProvider::Grok => request
                .header("x-xai-token-auth", "xai-grok-cli")
                .header("x-grok-client-version", "1.0.13")
                .header("x-grok-client-identifier", "grok-shell")
                .header("user-agent", "xai-grok-build/1.0.13"),
        };

        let upstream = match request.send().await {
            Ok(upstream) => upstream,
            Err(error) => {
                if claimed_probe {
                    release_probe(state, candidate.id).await?;
                }
                last_error = Some(upstream_network_error(expected_provider, error));
                continue;
            }
        };
        match upstream_disposition(upstream.status()) {
            UpstreamDisposition::RateLimit => {
                mark_rate_limited(state, candidate.id).await?;
                saw_rate_limit = true;
                continue;
            }
            UpstreamDisposition::Reauthorize => {
                mark_reauth_required(state, candidate.id).await?;
                saw_reauthorization = true;
                continue;
            }
            UpstreamDisposition::Return => {}
        }
        mark_active(state, candidate.id).await?;
        return upstream_response(
            state.clone(),
            candidate.id,
            authorized.user_id,
            upstream,
            record_usage,
        )
        .await;
    }

    if saw_share_exhausted {
        Err(ApiError::ShareExhausted)
    } else if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(ApiError::Provider(
            "Every accessible pool for this provider needs to reconnect.".to_owned(),
        ))
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
}

async fn upstream_response(
    state: AppState,
    connection_id: Uuid,
    user_id: Uuid,
    upstream: reqwest::Response,
    record_usage: bool,
) -> Result<Response, ApiError> {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    if !record_usage {
        return response
            .body(Body::from_stream(upstream.bytes_stream()))
            .map_err(|error| {
                eprintln!("gateway response construction failed: {error}");
                ApiError::Internal
            });
    }

    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Bytes, std::io::Error>>(32);
    tokio::spawn(async move {
        use futures_util::StreamExt;

        let mut stream = upstream.bytes_stream();
        let mut extractor = usage::UsageExtractor::default();
        let mut client_gone = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
                    extractor.push(&bytes);
                    if !client_gone && tx.send(Ok(bytes)).await.is_err() {
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
        drop(tx);
        if let Some(counts) = extractor.finish() {
            usage::record_event(&state, connection_id, user_id, counts).await;
        }
    });

    response
        .body(Body::from_stream(
            tokio_stream::wrappers::ReceiverStream::new(rx),
        ))
        .map_err(|error| {
            eprintln!("gateway response construction failed: {error}");
            ApiError::Internal
        })
}

async fn authorize_gateway_key(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthorizedGatewayKey, ApiError> {
    let key = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .filter(|value| value.starts_with("hw_live_") && value.len() > 24)
        .ok_or(ApiError::GatewayUnauthorized)?;
    let key_hash = hash_gateway_key(key);
    let authorized = sqlx::query_as::<_, AuthorizedGatewayKey>(
        "SELECT id, user_id FROM gateway_keys
         WHERE key_hash = $1 AND revoked_at IS NULL",
    )
    .bind(key_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::GatewayUnauthorized)?;
    sqlx::query("UPDATE gateway_keys SET last_used_at = NOW() WHERE id = $1")
        .bind(authorized.id)
        .execute(&state.pool)
        .await
        .map_err(database_error)?;

    Ok(authorized)
}

fn gateway_key_from_row(row: GatewayKeyRow) -> Result<GatewayKey, ApiError> {
    Ok(GatewayKey {
        created_at: row.created_at,
        id: row.id,
        last_four: row.last_four,
        last_used_at: row.last_used_at,
    })
}

async fn connected_provider_ids(
    state: &AppState,
    user_id: Uuid,
    provider: AgentProvider,
) -> Result<Vec<Uuid>, ApiError> {
    Ok(connected_provider_candidates(state, user_id, provider)
        .await?
        .into_iter()
        .map(|candidate| candidate.id)
        .collect())
}

async fn connected_provider_candidates(
    state: &AppState,
    user_id: Uuid,
    provider: AgentProvider,
) -> Result<Vec<ProviderCandidate>, ApiError> {
    let candidates = sqlx::query_as::<_, ProviderCandidate>(
        "SELECT connections.id, connections.availability_status,
                connections.rate_limited_until
         FROM agent_connections AS connections
         LEFT JOIN agent_pool_join_requests AS requests
           ON requests.connection_id = connections.id
          AND requests.requester_user_id = $1
          AND requests.status = 'accepted'
         WHERE connections.provider = $2
           AND connections.status = 'connected'
           AND (connections.user_id = $1 OR requests.id IS NOT NULL)
         ORDER BY CASE
                    WHEN connections.availability_status = 'half_open'
                         AND connections.retry_claimed_at IS NULL THEN 0
                    WHEN connections.availability_status = 'rate_limited'
                         AND connections.rate_limited_until <= NOW() THEN 1
                    WHEN connections.availability_status = 'active' THEN 2
                    ELSE 3
                  END,
                  (connections.user_id = $1) DESC,
                  COALESCE(requests.updated_at, connections.updated_at) DESC
        ",
    )
    .bind(user_id)
    .bind(provider.to_string())
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    if candidates.is_empty() {
        return Err(ApiError::Forbidden);
    }

    Ok(candidates)
}

async fn claim_candidate(
    state: &AppState,
    candidate: &ProviderCandidate,
) -> Result<Option<bool>, ApiError> {
    match candidate.availability_status.as_str() {
        "active" => Ok(Some(false)),
        "rate_limited"
            if candidate
                .rate_limited_until
                .is_some_and(|until| until <= Utc::now()) =>
        {
            let result = sqlx::query(
                "UPDATE agent_connections
                 SET availability_status = 'half_open', retry_claimed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND availability_status = 'rate_limited'
                   AND rate_limited_until <= NOW()",
            )
            .bind(candidate.id)
            .execute(&state.pool)
            .await
            .map_err(database_error)?;
            Ok((result.rows_affected() == 1).then_some(true))
        }
        "half_open" => {
            let stale_before = Utc::now() - Duration::minutes(5);
            let result = sqlx::query(
                "UPDATE agent_connections
                 SET retry_claimed_at = NOW(), updated_at = NOW()
                 WHERE id = $1 AND availability_status = 'half_open'
                   AND (retry_claimed_at IS NULL OR retry_claimed_at <= $2)",
            )
            .bind(candidate.id)
            .bind(stale_before)
            .execute(&state.pool)
            .await
            .map_err(database_error)?;
            Ok((result.rows_affected() == 1).then_some(true))
        }
        "rate_limited" => Ok(None),
        "reauth_required" => Ok(None),
        _ => Err(ApiError::Internal),
    }
}

async fn mark_rate_limited(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    let retry_at = Utc::now() + rate_limit_cooldown();
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'rate_limited', rate_limited_until = $2,
             retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1",
    )
    .bind(connection_id)
    .bind(retry_at)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn mark_reauth_required(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', rate_limited_until = NULL,
             retry_claimed_at = NULL,
             failure_message = 'Provider login is required. Reconnect this pool.',
             updated_at = NOW()
         WHERE id = $1",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn mark_active(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'active', rate_limited_until = NULL,
             retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND availability_status <> 'active'",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

async fn release_probe(state: &AppState, connection_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        "UPDATE agent_connections SET retry_claimed_at = NULL, updated_at = NOW()
         WHERE id = $1 AND availability_status = 'half_open'",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(())
}

fn rate_limit_cooldown() -> Duration {
    Duration::minutes(30)
}

fn upstream_disposition(status: StatusCode) -> UpstreamDisposition {
    match status {
        StatusCode::TOO_MANY_REQUESTS => UpstreamDisposition::RateLimit,
        StatusCode::UNAUTHORIZED => UpstreamDisposition::Reauthorize,
        _ => UpstreamDisposition::Return,
    }
}

fn generate_gateway_key() -> String {
    let mut secret = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    format!("hw_live_{}", URL_SAFE_NO_PAD.encode(secret))
}

fn hash_gateway_key(key: &str) -> Vec<u8> {
    Sha256::digest(key.as_bytes()).to_vec()
}

fn append_query(url: &str, query: Option<&str>) -> String {
    query.map_or_else(|| url.to_owned(), |query| format!("{url}?{query}"))
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

fn should_forward_response_header(name: &HeaderName) -> bool {
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

fn merged_anthropic_beta(headers: &HeaderMap) -> HeaderValue {
    let existing = headers
        .get("anthropic-beta")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default();
    let value = if existing
        .split(',')
        .map(str::trim)
        .any(|part| part == "oauth-2025-04-20")
    {
        existing.to_owned()
    } else if existing.is_empty() {
        "oauth-2025-04-20".to_owned()
    } else {
        format!("{existing},oauth-2025-04-20")
    };
    HeaderValue::from_str(&value).unwrap_or_else(|_| HeaderValue::from_static("oauth-2025-04-20"))
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

fn upstream_network_error(provider: AgentProvider, error: reqwest::Error) -> ApiError {
    eprintln!("{provider} gateway request failed: {error}");
    ApiError::Provider(format!(
        "The {provider} gateway is temporarily unavailable."
    ))
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("gateway database operation failed: {error}");
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use axum::http::{HeaderMap, HeaderValue};
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    use super::{
        GeminiOperation, GeminiSseTransformer, UpstreamDisposition, chatgpt_account_id,
        gemini_code_assist_request, hash_gateway_key, merged_anthropic_beta,
        parse_gemini_operation, rate_limit_cooldown, unwrap_gemini_response, upstream_disposition,
    };

    #[test]
    fn gateway_key_hash_does_not_store_the_plaintext() {
        let key = "hw_live_test-secret-that-is-long-enough";
        let hash = hash_gateway_key(key);
        assert_ne!(hash, key.as_bytes());
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn claude_oauth_beta_is_preserved_without_duplication() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("prompt-caching-2024-07-31"),
        );
        assert_eq!(
            merged_anthropic_beta(&headers),
            "prompt-caching-2024-07-31,oauth-2025-04-20"
        );
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("oauth-2025-04-20"),
        );
        assert_eq!(merged_anthropic_beta(&headers), "oauth-2025-04-20");
    }

    #[test]
    fn chatgpt_account_id_can_be_read_from_trusted_token_claims() {
        let claims = json!({
            "https://api.openai.com/auth.chatgpt_account_id": "account-123"
        });
        let jwt = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        assert_eq!(
            chatgpt_account_id(&json!({ "access_token": jwt })),
            Some("account-123".to_owned())
        );
    }

    #[test]
    fn rate_limited_pools_cool_down_for_thirty_minutes() {
        assert_eq!(rate_limit_cooldown().num_minutes(), 30);
    }

    #[test]
    fn upstream_authentication_and_rate_limits_advance_to_the_next_pool() {
        assert_eq!(
            upstream_disposition(axum::http::StatusCode::UNAUTHORIZED),
            UpstreamDisposition::Reauthorize
        );
        assert_eq!(
            upstream_disposition(axum::http::StatusCode::TOO_MANY_REQUESTS),
            UpstreamDisposition::RateLimit
        );
        assert_eq!(
            upstream_disposition(axum::http::StatusCode::BAD_REQUEST),
            UpstreamDisposition::Return
        );
    }

    #[test]
    fn gemini_native_requests_are_wrapped_for_code_assist() {
        let wrapped = gemini_code_assist_request(
            "gemini-3.1-pro-preview",
            "project-123",
            GeminiOperation::Generate,
            &json!({"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}),
        );
        assert_eq!(wrapped["model"], "gemini-3.1-pro-preview");
        assert_eq!(wrapped["project"], "project-123");
        assert_eq!(wrapped["request"]["contents"][0]["role"], "user");
        assert!(wrapped["user_prompt_id"].as_str().is_some());
    }

    #[test]
    fn gemini_route_parser_accepts_only_native_content_operations() {
        assert!(matches!(
            parse_gemini_operation("gemini-3.1-pro-preview:generateContent"),
            Ok(("gemini-3.1-pro-preview", GeminiOperation::Generate))
        ));
        assert!(parse_gemini_operation("gemini-3.1-pro-preview:delete").is_err());
        assert!(parse_gemini_operation("nested/model:generateContent").is_err());
    }

    #[test]
    fn gemini_code_assist_responses_are_unwrapped_for_agy() {
        let response = unwrap_gemini_response(json!({
            "response": {"candidates": [], "usageMetadata": {"promptTokenCount": 2}},
            "traceId": "trace-123"
        }));
        assert_eq!(response["responseId"], "trace-123");
        assert_eq!(response["usageMetadata"]["promptTokenCount"], 2);
    }

    #[test]
    fn gemini_sse_transformer_handles_split_events() {
        let mut transformer = GeminiSseTransformer::default();
        assert!(
            transformer
                .push(br#"data: {"response":{"candidates"#)
                .is_empty()
        );
        let output = transformer.push(b"\":[]},\"traceId\":\"trace-1\"}\n\n");
        let text = String::from_utf8(output.to_vec()).unwrap();
        assert!(text.contains(r#""responseId":"trace-1""#));
        assert!(!text.contains(r#""response":{"#));
    }
}
