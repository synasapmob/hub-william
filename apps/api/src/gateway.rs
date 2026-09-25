use std::sync::{OnceLock, RwLock};
use std::time::{Duration as StdDuration, Instant};

use axum::{
    Json,
    body::{Body, Bytes, to_bytes},
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use futures_util::{StreamExt, stream};
use rand::RngCore;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AgentProvider, AppState,
    auth::authenticated_user_id,
    connections::{ANTIGRAVITY_CLIENT_VERSION, load_gemini_code_assist, provider_credential},
    error::ApiError,
};

const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const OPENAI_CODEX_MODELS_URL: &str = "https://chatgpt.com/backend-api/codex/models";
const OPENAI_MODELS_URL: &str = "https://chatgpt.com/backend-api/models";
const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
// Match the installed OpenCode/OMP gateway installers: Claude defaults to only 20 models.
const CLAUDE_MODELS_URL: &str = "https://api.anthropic.com/v1/models?limit=1000";
const CLAUDE_COUNT_TOKENS_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";
const GROK_CHAT_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";
const GROK_RESPONSES_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const GROK_MODELS_URL: &str = "https://cli-chat-proxy.grok.com/v1/models-v2";

/// A browser request is pinned to one authorized account; existing key clients
/// retain the provider-scoped candidate set and failover behavior.
#[derive(Clone, Copy)]
struct GatewaySelection {
    user_id: Uuid,
    connection_id: Option<Uuid>,
    organization_id: Option<Uuid>,
}

impl From<Uuid> for GatewaySelection {
    fn from(user_id: Uuid) -> Self {
        Self {
            user_id,
            connection_id: None,
            organization_id: None,
        }
    }
}

impl From<AuthorizedGatewayKey> for GatewaySelection {
    fn from(key: AuthorizedGatewayKey) -> Self {
        Self {
            user_id: key.user_id,
            connection_id: None,
            organization_id: key.organization_id,
        }
    }
}

async fn selected_provider_candidates(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Vec<ProviderCandidate>, ApiError> {
    let mut candidates = connected_provider_candidates(state, selection, provider).await?;
    if let Some(connection_id) = selection.connection_id {
        candidates.retain(|candidate| candidate.id == connection_id);
    }
    if candidates.is_empty() {
        return Err(ApiError::Forbidden);
    }
    Ok(candidates)
}

pub(crate) async fn models_for_user(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        user_id,
        connection_id: Some(connection_id),
        organization_id: None,
    };
    models_for_selection(state, selection, provider).await
}

pub(crate) async fn models_for_organization_user(
    state: &AppState,
    user_id: Uuid,
    organization_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    models_for_selection(
        state,
        GatewaySelection {
            user_id,
            connection_id: Some(connection_id),
            organization_id: Some(organization_id),
        },
        provider,
    )
    .await
}

async fn models_for_selection(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    match provider {
        AgentProvider::Chatgpt => {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            headers.insert(
                "openai-beta",
                HeaderValue::from_static("responses=experimental"),
            );
            headers.insert(
                "version",
                HeaderValue::from_str(&state.config.codex_client_version)
                    .map_err(|_| ApiError::Internal)?,
            );
            for base_url in [OPENAI_CODEX_MODELS_URL, OPENAI_MODELS_URL] {
                let mut url = reqwest::Url::parse(base_url).map_err(|_| ApiError::Internal)?;
                url.query_pairs_mut()
                    .append_pair("client_version", &state.config.codex_client_version);
                let response = proxy_request_for_user(
                    state,
                    selection,
                    GatewayUpstream {
                        provider,
                        url: url.as_str(),
                    },
                    Method::GET,
                    &axum::http::Uri::from_static("/"),
                    &headers,
                    Bytes::new(),
                )
                .await?;
                if response.status().is_success()
                    || response.status().as_u16() == 401
                    || response.status().as_u16() == 403
                {
                    return Ok(response);
                }
            }
            Err(ApiError::Provider(
                "ChatGPT model discovery is temporarily unavailable.".to_owned(),
            ))
        }
        AgentProvider::Claude => {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            proxy_request_for_user(
                state,
                selection,
                GatewayUpstream {
                    provider,
                    url: CLAUDE_MODELS_URL,
                },
                Method::GET,
                &axum::http::Uri::from_static("/"),
                &headers,
                Bytes::new(),
            )
            .await
        }
        AgentProvider::Gemini => Ok(gemini_models_for_user(state, selection)
            .await?
            .into_response()),
        AgentProvider::Grok | AgentProvider::Deepseek => {
            let url = if provider == AgentProvider::Grok {
                GROK_MODELS_URL.to_owned()
            } else {
                format!("{}/models", state.config.deepseek_api_url)
            };
            let response = proxy_request_for_user(
                state,
                selection,
                GatewayUpstream {
                    provider,
                    url: &url,
                },
                Method::GET,
                &axum::http::Uri::from_static("/"),
                &HeaderMap::new(),
                Bytes::new(),
            )
            .await?;
            filter_current_live_model_response(response, provider).await
        }
    }
}

pub(crate) async fn response_for_user(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
    model: &str,
    body: Bytes,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        user_id,
        connection_id: Some(connection_id),
        organization_id: None,
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
            user_id,
            connection_id: Some(connection_id),
            organization_id: Some(organization_id),
        },
        provider,
        model,
        body,
    )
    .await
}

async fn response_for_selection(
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
const MAX_UPSTREAM_ATTEMPTS: usize = 4;
const MAX_SAME_CANDIDATE_ATTEMPTS: usize = 2;
const RETRY_BASE_DELAY_MS: u64 = 500;
const RETRY_MAX_DELAY_MS: u64 = 2_000;
const DOCS_CACHE_TTL: StdDuration = StdDuration::from_secs(3600);

static CLAUDE_DOCS_CACHE: OnceLock<RwLock<(Instant, Value)>> = OnceLock::new();
static OPENAI_DOCS_CACHE: OnceLock<RwLock<(Instant, Value)>> = OnceLock::new();
const ANTIGRAVITY_MODELS: [&str; 14] = [
    "gemini-3.8-flash-high",
    "gemini-3.8-flash-medium",
    "gemini-3.8-flash-low",
    "gemini-3.7-flash-high",
    "gemini-3.7-flash-medium",
    "gemini-3.7-flash-low",
    "gemini-3.6-flash-high",
    "gemini-3.6-flash-medium",
    "gemini-3.6-flash-low",
    "gemini-3.1-pro-high",
    "gemini-3.1-pro-low",
    "claude-sonnet-4-6",
    "claude-opus-4-6-thinking",
    "gpt-oss-120b-medium",
];

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
    organization_id: Option<Uuid>,
}

#[derive(Debug, FromRow)]
struct ProviderCandidate {
    availability_status: String,
    id: Uuid,
    rate_limited_until: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Default, Debug, PartialEq)]
struct TokenUsage {
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cached_tokens: Option<i64>,
}

impl TokenUsage {
    fn has_tokens(self) -> bool {
        self.input_tokens.is_some() || self.output_tokens.is_some() || self.cached_tokens.is_some()
    }
}

const MAX_USAGE_PAYLOAD_BYTES: usize = 1024 * 1024;

struct UsageObserver {
    provider: AgentProvider,
    sse: bool,
    pending: Vec<u8>,
    event_data: Vec<u8>,
    overflow: bool,
    skip_event: bool,
    completed: bool,
    failed: bool,
    usage: TokenUsage,
    claude_stop_reason: Option<String>,
    chat_completion_finished: bool,
    claude_input_tokens: Option<i64>,
    claude_cache_read_tokens: Option<i64>,
    claude_cache_creation_tokens: Option<i64>,
}

impl UsageObserver {
    fn new(provider: AgentProvider, sse: bool) -> Self {
        Self {
            provider,
            sse,
            pending: Vec::new(),
            event_data: Vec::new(),
            overflow: false,
            skip_event: false,
            completed: false,
            failed: false,
            usage: TokenUsage::default(),
            claude_stop_reason: None,
            chat_completion_finished: false,
            claude_input_tokens: None,
            claude_cache_read_tokens: None,
            claude_cache_creation_tokens: None,
        }
    }

    fn push(&mut self, bytes: &[u8]) {
        if !self.sse {
            if !self.overflow
                && self.pending.len().saturating_add(bytes.len()) <= MAX_USAGE_PAYLOAD_BYTES
            {
                self.pending.extend_from_slice(bytes);
            } else {
                self.pending.clear();
                self.overflow = true;
            }
            return;
        }

        for &byte in bytes {
            if byte == b'\n' {
                if !self.overflow {
                    let line = std::mem::take(&mut self.pending);
                    self.read_sse_line(&line);
                } else {
                    self.pending.clear();
                    self.overflow = false;
                    self.event_data.clear();
                    self.skip_event = true;
                }
            } else if self.pending.len() < MAX_USAGE_PAYLOAD_BYTES {
                self.pending.push(byte);
            } else {
                self.overflow = true;
            }
        }
    }

    fn read_sse_line(&mut self, line: &[u8]) {
        let line = line.strip_suffix(b"\r").unwrap_or(line);
        if line.is_empty() {
            if !self.skip_event {
                self.read_event();
            }
            self.skip_event = false;
            self.event_data.clear();
            return;
        }
        if self.skip_event {
            return;
        }
        let Some(data) = line.strip_prefix(b"data:") else {
            return;
        };
        let data = data.strip_prefix(b" ").unwrap_or(data);
        if data == b"[DONE]" {
            if self.chat_completion_finished && !self.failed {
                self.completed = true;
            }
            return;
        }
        if self
            .event_data
            .len()
            .saturating_add(data.len())
            .saturating_add(1)
            > MAX_USAGE_PAYLOAD_BYTES
        {
            self.event_data.clear();
            self.skip_event = true;
            return;
        }
        if !self.event_data.is_empty() {
            self.event_data.push(b'\n');
        }
        self.event_data.extend_from_slice(data);
    }

    fn read_event(&mut self) {
        if self.event_data.is_empty() {
            return;
        }
        if let Ok(value) = serde_json::from_slice::<Value>(&self.event_data) {
            self.read_value(&value);
        }
        self.event_data.clear();
    }

    fn read_value(&mut self, value: &Value) {
        match self.provider {
            AgentProvider::Claude => match value.get("type").and_then(Value::as_str) {
                Some("message_start") => self.read_claude_usage(value.pointer("/message/usage")),
                Some("message_delta") => {
                    self.read_claude_usage(value.get("usage"));
                    if let Some(reason) =
                        value.pointer("/delta/stop_reason").and_then(Value::as_str)
                    {
                        self.claude_stop_reason = Some(reason.to_owned());
                    }
                }
                Some("message_stop") => {
                    self.completed = matches!(
                        self.claude_stop_reason.as_deref(),
                        Some("end_turn" | "stop_sequence" | "refusal")
                    );
                }
                _ if !self.sse => {
                    self.read_claude_usage(value.get("usage"));
                    self.completed = matches!(
                        value.get("stop_reason").and_then(Value::as_str),
                        Some("end_turn" | "stop_sequence" | "refusal")
                    );
                }
                _ => {}
            },
            AgentProvider::Gemini => {
                let response = value.get("response").unwrap_or(value);
                if response
                    .get("candidates")
                    .and_then(Value::as_array)
                    .is_some_and(|candidates| {
                        candidates.iter().any(|candidate| {
                            candidate.get("index").and_then(Value::as_i64).unwrap_or(0) == 0
                                && candidate.get("finishReason").and_then(Value::as_str)
                                    == Some("STOP")
                        })
                    })
                {
                    self.completed = true;
                }
                let usage = value
                    .pointer("/response/usageMetadata")
                    .or_else(|| value.get("usageMetadata"))
                    .filter(|usage| usage.is_object());
                if let Some(usage) = usage {
                    if let Some(input) = nonnegative_i64(usage.get("promptTokenCount")) {
                        self.usage.input_tokens = Some(input);
                    }
                    if let Some(cached) = nonnegative_i64(usage.get("cachedContentTokenCount")) {
                        self.usage.cached_tokens = Some(cached);
                    }
                    if let Some(output) = nonnegative_i64(usage.get("totalTokenCount"))
                        .and_then(|total| {
                            self.usage
                                .input_tokens
                                .and_then(|input| total.checked_sub(input))
                        })
                        .or_else(|| {
                            nonnegative_i64(usage.get("candidatesTokenCount")).and_then(
                                |candidate| {
                                    candidate.checked_add(
                                        nonnegative_i64(usage.get("thoughtsTokenCount"))
                                            .unwrap_or(0),
                                    )
                                },
                            )
                        })
                    {
                        self.usage.output_tokens = Some(output);
                    }
                }
            }
            AgentProvider::Chatgpt | AgentProvider::Grok | AgentProvider::Deepseek => {
                if matches!(
                    value.get("status").and_then(Value::as_str),
                    Some("failed" | "incomplete")
                ) {
                    self.failed = true;
                    self.completed = false;
                }
                match value.get("type").and_then(Value::as_str) {
                    Some("response.completed") if !self.failed => self.completed = true,
                    Some("response.failed" | "response.incomplete") => {
                        self.completed = false;
                        self.failed = true;
                    }
                    _ => {}
                }
                if value
                    .get("choices")
                    .and_then(Value::as_array)
                    .is_some_and(|choices| {
                        choices.iter().any(|choice| {
                            matches!(
                                choice.get("finish_reason").and_then(Value::as_str),
                                Some("stop" | "tool_calls" | "function_call")
                            )
                        })
                    })
                {
                    self.chat_completion_finished = true;
                }
                let usage = value
                    .pointer("/response/usage")
                    .or_else(|| value.get("usage"))
                    .filter(|usage| usage.is_object());
                if let Some(usage) = usage {
                    if let Some(input) = nonnegative_i64(usage.get("input_tokens"))
                        .or_else(|| nonnegative_i64(usage.get("prompt_tokens")))
                    {
                        self.usage.input_tokens = Some(input);
                    }
                    if let Some(output) = nonnegative_i64(usage.get("output_tokens"))
                        .or_else(|| nonnegative_i64(usage.get("completion_tokens")))
                    {
                        self.usage.output_tokens = Some(output);
                    }
                    if let Some(cached) =
                        nonnegative_i64(usage.pointer("/input_tokens_details/cached_tokens"))
                            .or_else(|| {
                                nonnegative_i64(
                                    usage.pointer("/prompt_tokens_details/cached_tokens"),
                                )
                            })
                    {
                        self.usage.cached_tokens = Some(cached);
                    }
                }
            }
        }
    }

    fn read_claude_usage(&mut self, usage: Option<&Value>) {
        let Some(usage) = usage else { return };
        if let Some(input) = nonnegative_i64(usage.get("input_tokens")) {
            self.claude_input_tokens = Some(input);
        }
        if let Some(cache_read) = nonnegative_i64(usage.get("cache_read_input_tokens")) {
            self.claude_cache_read_tokens = Some(cache_read);
            self.usage.cached_tokens = Some(cache_read);
        }
        if let Some(cache_creation) = nonnegative_i64(usage.get("cache_creation_input_tokens")) {
            self.claude_cache_creation_tokens = Some(cache_creation);
        }
        self.usage.input_tokens = self
            .claude_input_tokens
            .and_then(|input| input.checked_add(self.claude_cache_read_tokens.unwrap_or(0)))
            .and_then(|total| total.checked_add(self.claude_cache_creation_tokens.unwrap_or(0)));
        if let Some(output) = nonnegative_i64(usage.get("output_tokens")) {
            self.usage.output_tokens = Some(output);
        }
    }

    fn finish_with_completion(mut self) -> (bool, Option<TokenUsage>) {
        if self.sse {
            if !self.pending.is_empty() && !self.overflow {
                let line = std::mem::take(&mut self.pending);
                self.read_sse_line(&line);
            }
            if !self.skip_event {
                self.read_event();
            }
            if !self.completed || self.failed {
                return (false, None);
            }
        } else if !self.overflow {
            let payload = std::mem::take(&mut self.pending);
            let Ok(value) = serde_json::from_slice::<Value>(&payload) else {
                return (false, None);
            };
            self.read_value(&value);
            if self.failed
                || matches!(self.provider, AgentProvider::Claude | AgentProvider::Gemini)
                    && !self.completed
            {
                return (false, None);
            }
        }
        (true, self.usage.has_tokens().then_some(self.usage))
    }
}

fn nonnegative_i64(value: Option<&Value>) -> Option<i64> {
    value.and_then(Value::as_i64).filter(|value| *value >= 0)
}

#[derive(Debug, PartialEq)]
enum UpstreamDisposition {
    Return,
    RateLimit,
    Reauthorize,
    RetryTransient,
    NextPool,
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
    let body = strip_unsupported_codex_fields(body);
    proxy_request(
        &state,
        AgentProvider::Chatgpt,
        OPENAI_RESPONSES_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn openai_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    connected_provider_ids(&state, authorized.into(), AgentProvider::Chatgpt).await?;

    Ok(Json(fetch_or_cached_openai_catalogue(&state.http).await))
}

pub(crate) fn default_openai_model_catalogue() -> Value {
    json!({
        "object": "list",
        "data": [
            { "id": "gpt-6-astra", "name": "GPT-6 Astra", "object": "model", "owned_by": "openai" },
            { "id": "gpt-6-sol", "name": "GPT-6 Sol", "object": "model", "owned_by": "openai" },
            { "id": "gpt-6-luna", "name": "GPT-6 Luna", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "object": "model", "owned_by": "openai" }
        ]
    })
}

pub(crate) fn parse_openai_models_markdown(content: &str) -> Option<Value> {
    let recommended = content.split_once("## Recommended models")?.1;
    let recommended = recommended.split("\n## ").next().unwrap_or(recommended);
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in recommended.lines() {
        let trimmed = line.trim();
        let Some(model_id) = trimmed
            .strip_prefix("slug=\"")
            .and_then(|value| value.strip_suffix('"'))
        else {
            continue;
        };
        push_openai_model(&mut models, &mut seen, model_id);
    }

    // The older generation remains current during rollout, but has no ModelDetails
    // block. Read only the explicit rollout paragraph in the recommended section.
    if let Some(rollout) = recommended
        .split("\n\n")
        .find(|paragraph| paragraph.contains("remain available during the rollout"))
    {
        for fragment in rollout.split("GPT-").skip(1) {
            let mut words = fragment.split_whitespace();
            let (Some(version), Some(family)) = (words.next(), words.next()) else {
                continue;
            };
            let version = version.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
            let family = family.trim_matches(|c: char| !c.is_ascii_alphabetic());
            if version.chars().any(|c| c.is_ascii_digit()) && !family.is_empty() {
                let model_id = format!("gpt-{version}-{}", family.to_ascii_lowercase());
                push_openai_model(&mut models, &mut seen, &model_id);
            }
        }
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

fn push_openai_model(
    models: &mut Vec<Value>,
    seen: &mut std::collections::HashSet<String>,
    id: &str,
) {
    if !id.starts_with("gpt-") || !seen.insert(id.to_owned()) {
        return;
    }
    let suffix = id.strip_prefix("gpt-").unwrap_or(id);
    let name = format!(
        "GPT-{}",
        suffix
            .split('-')
            .enumerate()
            .map(|(index, part)| {
                if index == 0 {
                    part.to_owned()
                } else {
                    let mut chars = part.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().chain(chars).collect(),
                        None => String::new(),
                    }
                }
            })
            .collect::<Vec<_>>()
            .join(" ")
    );
    models.push(json!({"id": id, "name": name, "object": "model", "owned_by": "openai"}));
}

pub(crate) async fn fetch_or_cached_openai_catalogue(http: &reqwest::Client) -> Value {
    let cache = OPENAI_DOCS_CACHE.get_or_init(|| {
        RwLock::new((
            Instant::now()
                .checked_sub(DOCS_CACHE_TTL)
                .unwrap_or_else(Instant::now),
            Value::Null,
        ))
    });
    if let Some(cached) = cache.read().ok().and_then(|g| {
        if g.0.elapsed() < DOCS_CACHE_TTL && !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return cached;
    }

    let fetched = async {
        let response = http
            .get("https://learn.chatgpt.com/docs/models.md")
            .timeout(StdDuration::from_secs(6))
            .header("User-Agent", "hub-william")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        parse_openai_models_markdown(&text)
    }
    .await;

    if let Some(catalogue) = fetched {
        if let Ok(mut guard) = cache.write() {
            *guard = (Instant::now(), catalogue.clone());
        }
        return catalogue;
    }

    if let Some(stale) = cache.read().ok().and_then(|g| {
        if !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return stale;
    }
    default_openai_model_catalogue()
}

pub async fn claude_messages(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = ensure_claude_billing_header(body, &state.config.claude_client_version);
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_MESSAGES_URL,
        Method::POST,
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
    let body = ensure_claude_billing_header(body, &state.config.claude_client_version);
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_COUNT_TOKENS_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
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
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn grok_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_RESPONSES_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn claude_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    connected_provider_ids(&state, authorized.into(), AgentProvider::Claude).await?;

    Ok(Json(fetch_or_cached_claude_catalogue(&state.http).await))
}

pub(crate) fn default_claude_model_catalogue() -> Value {
    let standard_effort = json!({
        "supported": true,
        "low": { "supported": true },
        "medium": { "supported": true },
        "high": { "supported": true },
        "xhigh": { "supported": true },
        "max": { "supported": true }
    });

    json!({
        "object": "list",
        "data": [
            {
                "id": "claude-fable-5-1",
                "display_name": "Claude Fable 5.1",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-opus-5-5",
                "display_name": "Claude Opus 5.5",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-sonnet-5",
                "display_name": "Claude Sonnet 5",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-haiku-4-5-20251001",
                "display_name": "Claude Haiku 4.5"
            }
        ]
    })
}

pub(crate) fn parse_claude_models_markdown(content: &str) -> Option<Value> {
    let current = content.split_once("## Compare models")?.1;
    let current = current.split("\n## ").next().unwrap_or(current);
    let mut header_cols: Vec<String> = Vec::new();
    let mut id_cols: Vec<String> = Vec::new();
    let mut effort_cols: Vec<String> = Vec::new();

    for line in current.lines() {
        let parts: Vec<&str> = line.split('|').map(str::trim).collect();
        if parts.len() > 2 {
            let label = parts[1].trim_start_matches('[');
            let label = label.split(']').next().unwrap_or(label).trim();
            if label == "Feature" {
                header_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.to_string())
                    .collect();
            } else if label == "Claude API ID" {
                id_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.trim_matches(|c| c == '`' || c == ' ').to_string())
                    .collect();
            } else if label == "Default effort" {
                effort_cols = parts[2..parts.len() - 1]
                    .iter()
                    .map(|s| s.trim_matches(|c| c == '`' || c == ' ').to_string())
                    .collect();
            }
        }
    }

    if id_cols.is_empty() {
        return None;
    }

    let standard_effort = json!({
        "supported": true,
        "low": { "supported": true },
        "medium": { "supported": true },
        "high": { "supported": true },
        "xhigh": { "supported": true },
        "max": { "supported": true }
    });

    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for (i, mid) in id_cols.into_iter().enumerate() {
        if mid.is_empty() || seen.contains(&mid) {
            continue;
        }
        seen.insert(mid.clone());
        let name = header_cols.get(i).cloned().unwrap_or_else(|| mid.clone());
        let effort_supported = effort_cols
            .get(i)
            .map(|e| !e.eq_ignore_ascii_case("not supported") && !e.is_empty())
            .unwrap_or(false);

        let mut entry = json!({
            "id": mid,
            "display_name": name,
        });
        if effort_supported {
            entry["capabilities"] = json!({ "effort": standard_effort });
        }
        models.push(entry);
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

pub(crate) async fn fetch_or_cached_claude_catalogue(http: &reqwest::Client) -> Value {
    let cache = CLAUDE_DOCS_CACHE.get_or_init(|| {
        RwLock::new((
            Instant::now()
                .checked_sub(DOCS_CACHE_TTL)
                .unwrap_or_else(Instant::now),
            Value::Null,
        ))
    });
    if let Some(cached) = cache.read().ok().and_then(|g| {
        if g.0.elapsed() < DOCS_CACHE_TTL && !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return cached;
    }

    let fetched = async {
        let response = http
            .get("https://platform.claude.com/docs/en/models/overview.md")
            .timeout(StdDuration::from_secs(6))
            .header("User-Agent", "hub-william")
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let text = response.text().await.ok()?;
        parse_claude_models_markdown(&text)
    }
    .await;

    if let Some(catalogue) = fetched {
        if let Ok(mut guard) = cache.write() {
            *guard = (Instant::now(), catalogue.clone());
        }
        return catalogue;
    }

    if let Some(stale) = cache.read().ok().and_then(|g| {
        if !g.1.is_null() {
            Some(g.1.clone())
        } else {
            None
        }
    }) {
        return stale;
    }
    default_claude_model_catalogue()
}

pub async fn deepseek_chat(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/chat/completions", state.config.deepseek_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn deepseek_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/responses", state.config.deepseek_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn deepseek_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/models", state.config.deepseek_api_url),
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await?;
    filter_current_live_model_response(response, AgentProvider::Deepseek).await
}

pub async fn grok_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_MODELS_URL,
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await?;
    filter_current_live_model_response(response, AgentProvider::Grok).await
}

pub(crate) fn current_live_model_id(provider: AgentProvider, id: &str) -> bool {
    match provider {
        AgentProvider::Deepseek => matches!(id, "deepseek-flash" | "deepseek-v4-pro"),
        AgentProvider::Grok => id == "grok-4.7",
        _ => true,
    }
}

fn filter_current_live_model_catalogue(
    payload: &mut Value,
    provider: AgentProvider,
) -> Result<(), ApiError> {
    let key = if payload.get("data").is_some() {
        "data"
    } else {
        "models"
    };
    let models = payload
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .ok_or_else(|| {
            ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
        })?;
    models.retain(|model| {
        model
            .get("id")
            .or_else(|| model.get("slug"))
            .and_then(Value::as_str)
            .is_some_and(|id| current_live_model_id(provider, id))
    });
    Ok(())
}

async fn filter_current_live_model_response(
    response: Response,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    if !response.status().is_success() {
        return Ok(response);
    }
    let (mut parts, body) = response.into_parts();
    let bytes = to_bytes(body, 8 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::Provider("The model catalogue could not be read.".to_owned()))?;
    let mut payload: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
    })?;
    filter_current_live_model_catalogue(&mut payload, provider)?;
    parts.headers.remove(header::CONTENT_LENGTH);
    parts.headers.remove(header::CONTENT_ENCODING);
    parts.headers.remove(header::ETAG);
    parts.headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    Ok(Response::from_parts(
        parts,
        Body::from(serde_json::to_vec(&payload).map_err(|_| ApiError::Internal)?),
    ))
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

pub async fn gemini_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    gemini_models_for_user(&state, authorized.into()).await
}

async fn gemini_models_for_user(
    state: &AppState,
    selection: GatewaySelection,
) -> Result<Json<Value>, ApiError> {
    let candidates = selected_provider_candidates(state, selection, AgentProvider::Gemini).await?;
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
    let candidate_count = candidates.len();
    let mut attempts_used = 0;

    'candidates: for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
        let access_token = token.get("access_token").and_then(Value::as_str);
        let project = token
            .get("cloudaicompanion_project")
            .and_then(Value::as_str);
        let (Some(access_token), Some(project)) = (access_token, project) else {
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
        let project = current_gemini_project(state, access_token, project).await;
        let upstream_url = format!(
            "{}/v1internal:fetchAvailableModels",
            state.config.gemini_code_assist_url.trim_end_matches('/')
        );
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let upstream = match state
                .gateway_http
                .post(&upstream_url)
                .bearer_auth(access_token)
                .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
                .json(&json!({ "project": project }))
                .send()
                .await
            {
                Ok(upstream) => upstream,
                Err(error) => {
                    last_error = Some(upstream_network_error(AgentProvider::Gemini, error));
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, None);
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
            };
            match gemini_upstream_disposition(upstream.status()) {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    mark_reauth_required(state, candidate.id).await?;
                    saw_reauthorization = true;
                    continue 'candidates;
                }
                UpstreamDisposition::RetryTransient => {
                    last_error = Some(ApiError::Provider(format!(
                        "Google model discovery returned HTTP {} after {attempts_used} attempts.",
                        upstream.status()
                    )));
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, Some(upstream.headers()));
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
                UpstreamDisposition::NextPool | UpstreamDisposition::Return => {
                    if !upstream.status().is_success() {
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
        Err(ApiError::Provider(
            "Every accessible pool for this provider needs to reconnect.".to_owned(),
        ))
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
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

async fn current_gemini_project(
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

async fn gemini_proxy_request_for_user(
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
    let mut attempts_used = 0;

    'candidates: for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
        let project = current_gemini_project(state, access_token, project).await;
        let upstream_body = gemini_code_assist_request(model, &project, operation, &request_body);
        let upstream_url = format!(
            "{}{}",
            state.config.gemini_code_assist_url.trim_end_matches('/'),
            operation.path()
        );
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let upstream = match state
                .gateway_http
                .post(&upstream_url)
                .bearer_auth(access_token)
                .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
                .header("content-type", "application/json")
                .json(&upstream_body)
                .send()
                .await
            {
                Ok(upstream) => upstream,
                Err(error) => {
                    last_error = Some(upstream_network_error(AgentProvider::Gemini, error));
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, None);
                    eprintln!(
                        "Gemini gateway attempt {attempts_used}/{MAX_UPSTREAM_ATTEMPTS} failed before a response; retrying in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
            };
            match gemini_upstream_disposition(upstream.status()) {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    mark_reauth_required(state, candidate.id).await?;
                    saw_reauthorization = true;
                    continue 'candidates;
                }
                UpstreamDisposition::NextPool => {
                    if claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    last_pool_response = Some(upstream);
                    continue 'candidates;
                }
                UpstreamDisposition::RetryTransient => {
                    eprintln!(
                        "Gemini gateway attempt {attempts_used}/{MAX_UPSTREAM_ATTEMPTS} returned HTTP {}",
                        upstream.status()
                    );
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, Some(upstream.headers()));
                    eprintln!("Gemini gateway retry scheduled in {} ms", delay.as_millis());
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
                UpstreamDisposition::Return => {}
            }
            mark_active(state, candidate.id).await?;
            let usage_event = if upstream.status().is_success()
                && !matches!(operation, GeminiOperation::CountTokens)
            {
                organization_usage_event(
                    state,
                    selection,
                    candidate.id,
                    AgentProvider::Gemini,
                    Some(model.trim_start_matches("models/")),
                )
            } else {
                None
            };
            return gemini_upstream_response_with_usage(
                upstream,
                operation,
                selection.connection_id.is_some(),
                usage_event,
            )
            .await;
        }
    }

    if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(ApiError::Provider(
            "Every accessible pool for this provider needs to reconnect.".to_owned(),
        ))
    } else if let Some(upstream) = last_pool_response {
        gemini_upstream_response(upstream, operation, selection.connection_id.is_some()).await
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

fn antigravity_model_id(model: &str, request: &Value) -> String {
    let thinking_budget = request
        .pointer("/generationConfig/thinkingConfig/thinkingBudget")
        .and_then(Value::as_i64);
    let flash_variant = || match thinking_budget {
        Some(-1) => "high",
        Some(budget) if budget <= 1_000 => "low",
        _ => "medium",
    };
    match model {
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

fn gemini_model_catalogue(payload: &Value) -> Value {
    let available = payload
        .get("models")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let models = ANTIGRAVITY_MODELS
        .iter()
        .filter_map(|identifier| {
            let metadata = available.get(*identifier)?;
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
    usage_event: Option<OrganizationUsageEvent>,
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
            if observer.completed {
                let usage = observer.usage.has_tokens().then_some(observer.usage);
                record_organization_usage(&event, usage)
                    .await
                    .map_err(database_error)?;
            }
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
        if complete
            && !client_gone
            && let (Some(event), Some(observer)) = (usage_event, usage_observer)
        {
            let (provider_complete, usage) = observer.finish_with_completion();
            if provider_complete && let Err(error) = record_organization_usage(&event, usage).await
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

async fn proxy_request(
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

struct GatewayUpstream<'a> {
    provider: AgentProvider,
    url: &'a str,
}

async fn proxy_request_for_user(
    state: &AppState,
    selection: GatewaySelection,
    upstream: GatewayUpstream<'_>,
    method: Method,
    original_uri: &axum::http::Uri,
    request_headers: &HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let expected_provider = upstream.provider;
    let candidates = selected_provider_candidates(state, selection, expected_provider).await?;
    let upstream_url = append_query(upstream.url, original_uri.query());
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
    let candidate_count = candidates.len();
    let mut attempts_used = 0;

    'candidates: for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
        let mut candidate_attempts = 0;
        loop {
            attempts_used += 1;
            candidate_attempts += 1;
            let mut request = state
                .gateway_http
                .request(method.clone(), &upstream_url)
                .bearer_auth(access_token)
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
                AgentProvider::Deepseek => request,
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
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, None);
                    eprintln!(
                        "{expected_provider} gateway attempt {attempts_used}/{MAX_UPSTREAM_ATTEMPTS} failed before a response; retrying in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
            };
            let disposition = if expected_provider == AgentProvider::Grok
                && upstream.status() == StatusCode::FORBIDDEN
            {
                UpstreamDisposition::Reauthorize
            } else {
                upstream_disposition(upstream.status())
            };
            match disposition {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    mark_reauth_required(state, candidate.id).await?;
                    saw_reauthorization = true;
                    continue 'candidates;
                }
                UpstreamDisposition::RetryTransient => {
                    eprintln!(
                        "{expected_provider} gateway attempt {attempts_used}/{MAX_UPSTREAM_ATTEMPTS} returned HTTP {}",
                        upstream.status()
                    );
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
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
                    if !retry_same && claimed_probe {
                        release_probe(state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, Some(upstream.headers()));
                    eprintln!(
                        "{expected_provider} gateway retry scheduled in {} ms",
                        delay.as_millis()
                    );
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
                UpstreamDisposition::NextPool => {
                    unreachable!("only Gemini classifies an upstream response as pool-specific")
                }
                UpstreamDisposition::Return => {}
            }
            mark_active(state, candidate.id).await?;
            let usage_event = if method == Method::POST
                && upstream.url().as_str() != CLAUDE_COUNT_TOKENS_URL
                && upstream.status().is_success()
            {
                let requested_model = request_model(&body);
                organization_usage_event(
                    state,
                    selection,
                    candidate.id,
                    expected_provider,
                    requested_model.as_deref(),
                )
            } else {
                None
            };
            return upstream_response_with_usage(upstream, usage_event).await;
        }
    }

    if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(ApiError::Provider(
            "Every accessible pool for this provider needs to reconnect.".to_owned(),
        ))
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

#[derive(Clone)]
struct OrganizationUsageEvent {
    pool: sqlx::PgPool,
    organization_id: Uuid,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
    model: Option<String>,
}

fn organization_usage_event(
    state: &AppState,
    selection: GatewaySelection,
    connection_id: Uuid,
    provider: AgentProvider,
    model: Option<&str>,
) -> Option<OrganizationUsageEvent> {
    Some(OrganizationUsageEvent {
        pool: state.pool.clone(),
        organization_id: selection.organization_id?,
        user_id: selection.user_id,
        connection_id,
        provider,
        model: model.map(str::to_owned),
    })
}

async fn record_organization_usage(
    event: &OrganizationUsageEvent,
    usage: Option<TokenUsage>,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO organization_usage_events
         (id, org_id, user_id, connection_id, provider, model,
          input_tokens, output_tokens, cached_tokens)
         VALUES ($1, $2, $3,
                 (SELECT id FROM agent_connections WHERE id = $4 FOR KEY SHARE),
                 $5, $6, $7, $8, $9)",
    )
    .bind(Uuid::new_v4())
    .bind(event.organization_id)
    .bind(event.user_id)
    .bind(event.connection_id)
    .bind(event.provider.to_string())
    .bind(&event.model)
    .bind(usage.and_then(|value| value.input_tokens))
    .bind(usage.and_then(|value| value.output_tokens))
    .bind(usage.and_then(|value| value.cached_tokens))
    .execute(&event.pool)
    .await?;
    Ok(())
}

fn request_model(body: &Bytes) -> Option<String> {
    serde_json::from_slice::<Value>(body)
        .ok()?
        .get("model")?
        .as_str()
        .filter(|model| !model.is_empty())
        .map(str::to_owned)
}

async fn upstream_response_with_usage(
    upstream: reqwest::Response,
    usage_event: Option<OrganizationUsageEvent>,
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

    let provider = event.provider;
    let observed_stream = stream::unfold(
        (
            upstream.bytes_stream(),
            UsageObserver::new(provider, sse),
            false,
        ),
        move |(mut bytes_stream, mut observer, failed)| {
            let event = event.clone();
            async move {
                match bytes_stream.next().await {
                    Some(Ok(bytes)) => {
                        observer.push(&bytes);
                        Some((Ok(bytes), (bytes_stream, observer, failed)))
                    }
                    Some(Err(error)) => Some((Err(error), (bytes_stream, observer, true))),
                    None => {
                        let (provider_complete, usage) = observer.finish_with_completion();
                        if !failed
                            && provider_complete
                            && let Err(error) = record_organization_usage(&event, usage).await
                        {
                            eprintln!("organization usage insert failed: {error}");
                        }
                        None
                    }
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
        "SELECT id, user_id, organization_id FROM gateway_keys
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
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Vec<Uuid>, ApiError> {
    let candidates = connected_provider_candidates(state, selection, provider).await?;
    let ids: Vec<Uuid> = candidates
        .into_iter()
        .filter(|candidate| candidate.availability_status != "reauth_required")
        .map(|candidate| candidate.id)
        .collect();
    if ids.is_empty() {
        return Err(ApiError::Forbidden);
    }
    Ok(ids)
}

async fn connected_provider_candidates(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Vec<ProviderCandidate>, ApiError> {
    if let Some(organization_id) = selection.organization_id {
        let candidates = sqlx::query_as::<_, ProviderCandidate>(
            "SELECT connections.id, connections.availability_status,
                    connections.rate_limited_until
             FROM organization_agents AS shares
             JOIN agent_connections AS connections
               ON connections.id = shares.connection_id
              AND connections.user_id = shares.owner_user_id
             JOIN organization_memberships AS members
               ON members.org_id = shares.org_id
              AND members.user_id = $2
              AND members.status = 'accepted'
             JOIN organization_memberships AS owners
               ON owners.org_id = shares.org_id
              AND owners.user_id = shares.owner_user_id
              AND owners.status = 'accepted'
             WHERE shares.org_id = $1
               AND connections.provider = $3
               AND connections.status = 'connected'
             ORDER BY CASE
                        WHEN connections.availability_status = 'half_open'
                             AND connections.retry_claimed_at IS NULL THEN 0
                        WHEN connections.availability_status = 'rate_limited'
                             AND connections.rate_limited_until <= NOW() THEN 1
                        WHEN connections.availability_status = 'active' THEN 2
                        ELSE 3
                      END,
                      shares.created_at DESC,
                      connections.id",
        )
        .bind(organization_id)
        .bind(selection.user_id)
        .bind(provider.to_string())
        .fetch_all(&state.pool)
        .await
        .map_err(database_error)?;
        if candidates.is_empty() {
            return Err(ApiError::Forbidden);
        }
        return Ok(candidates);
    }

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
    .bind(selection.user_id)
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
        StatusCode::REQUEST_TIMEOUT
        | StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => UpstreamDisposition::RetryTransient,
        _ => UpstreamDisposition::Return,
    }
}

fn gemini_upstream_disposition(status: StatusCode) -> UpstreamDisposition {
    if status == StatusCode::FORBIDDEN {
        // Code Assist can reject one account or project while another pool can
        // serve the same request. A 403 alone does not prove OAuth needs renewal.
        UpstreamDisposition::NextPool
    } else {
        upstream_disposition(status)
    }
}

fn should_retry_same_candidate(
    attempts_used: usize,
    candidate_attempts: usize,
    candidate_index: usize,
    candidate_count: usize,
) -> bool {
    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
        return false;
    }
    let remaining_candidates = candidate_count.saturating_sub(candidate_index + 1);
    remaining_candidates == 0
        || (candidate_attempts < MAX_SAME_CANDIDATE_ATTEMPTS
            && MAX_UPSTREAM_ATTEMPTS - attempts_used > remaining_candidates)
}

fn retry_delay(retry_number: usize, headers: Option<&HeaderMap>) -> std::time::Duration {
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

fn strip_unsupported_codex_fields(body: Bytes) -> Bytes {
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

fn grok_proxy_headers(client_version: &str, body: &Bytes, include_affinity: bool) -> HeaderMap {
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
    #[tokio::test]
    async fn playground_gemini_disconnect_closes_upstream_without_waiting_for_next_chunk() {
        use axum::{Router, routing::get};
        use std::{sync::Arc, time::Duration};
        use tokio::{
            net::TcpListener,
            sync::{Mutex, mpsc},
        };
        use tokio_stream::wrappers::ReceiverStream;

        let (tx, rx) = mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(1);
        tx.send(Ok(axum::body::Bytes::from_static(
            b"data: {\"response\":{\"candidates\":[]}}\n\n",
        )))
        .await
        .unwrap();
        let receiver = Arc::new(Mutex::new(Some(rx)));
        let server = Router::new().route(
            "/stream",
            get(move || {
                let receiver = receiver.clone();
                async move {
                    axum::body::Body::from_stream(ReceiverStream::new(
                        receiver.lock().await.take().unwrap(),
                    ))
                }
            }),
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/stream", listener.local_addr().unwrap());
        let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let upstream = reqwest::get(url).await.unwrap();
        let response =
            super::gemini_upstream_response(upstream, super::GeminiOperation::StreamGenerate, true)
                .await
                .unwrap();
        drop(response);
        tokio::time::timeout(Duration::from_secs(2), tx.closed())
            .await
            .expect("cancel must drop the upstream stream");
        task.abort();
    }

    use axum::{
        body::Bytes,
        http::{HeaderMap, HeaderValue},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::{Value, json};
    use uuid::Uuid;

    use crate::AgentProvider;

    use super::{
        GeminiOperation, GeminiSseTransformer, MAX_USAGE_PAYLOAD_BYTES, TokenUsage,
        UpstreamDisposition, UsageObserver, antigravity_model_id, chatgpt_account_id,
        default_claude_model_catalogue, default_openai_model_catalogue,
        ensure_claude_billing_header, filter_current_live_model_catalogue,
        filter_current_live_model_response, gemini_code_assist_request, gemini_model_catalogue,
        gemini_upstream_disposition, grok_proxy_headers, hash_gateway_key, merged_anthropic_beta,
        parse_claude_models_markdown, parse_gemini_operation, parse_openai_models_markdown,
        rate_limit_cooldown, retry_delay, should_retry_same_candidate,
        strip_unsupported_codex_fields, unwrap_gemini_response, upstream_disposition,
    };

    #[test]
    fn usage_observer_reads_split_responses_event_without_counting_partial_streams() {
        let mut observer = UsageObserver::new(AgentProvider::Chatgpt, true);
        observer.push(
            b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,",
        );
        observer.push(b"\"output_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n");
        assert_eq!(
            observer.finish_with_completion().1,
            Some(TokenUsage {
                input_tokens: Some(12),
                output_tokens: Some(7),
                cached_tokens: Some(3),
            })
        );

        let mut incomplete = UsageObserver::new(AgentProvider::Chatgpt, true);
        incomplete
            .push(b"data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":12}}\n\n");
        assert_eq!(incomplete.finish_with_completion().1, None);
    }

    #[test]
    fn usage_observer_includes_claude_cached_input_and_final_output() {
        let mut observer = UsageObserver::new(AgentProvider::Claude, true);
        observer.push(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":20,\"cache_creation_input_tokens\":10,\"output_tokens\":1}}}\n\n");
        observer.push(b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}\n\n");
        observer.push(b"data: {\"type\":\"message_stop\"}\n\n");
        assert_eq!(
            observer.finish_with_completion().1,
            Some(TokenUsage {
                input_tokens: Some(35),
                output_tokens: Some(8),
                cached_tokens: Some(20),
            })
        );
    }

    #[test]
    fn usage_observer_reads_gemini_metadata_and_bounded_json() {
        let mut observer = UsageObserver::new(AgentProvider::Gemini, true);
        observer.push(b"data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"totalTokenCount\":18,\"candidatesTokenCount\":5,\"cachedContentTokenCount\":4}}}\n\n");
        assert_eq!(
            observer.finish_with_completion().1,
            Some(TokenUsage {
                input_tokens: Some(10),
                output_tokens: Some(8),
                cached_tokens: Some(4),
            })
        );

        let mut oversized = UsageObserver::new(AgentProvider::Grok, false);
        oversized.push(&vec![b'x'; MAX_USAGE_PAYLOAD_BYTES + 1]);
        assert!(oversized.pending.is_empty());
        assert_eq!(oversized.finish_with_completion().1, None);
    }

    #[test]
    fn usage_observer_requires_provider_completion_not_just_stream_end() {
        let mut failed_response = UsageObserver::new(AgentProvider::Chatgpt, true);
        failed_response.push(b"data: {\"type\":\"response.incomplete\"}\n\ndata: [DONE]\n\n");
        assert_eq!(failed_response.finish_with_completion(), (false, None));

        let mut partial_gemini = UsageObserver::new(AgentProvider::Gemini, true);
        partial_gemini
            .push(b"data: {\"response\":{\"usageMetadata\":{\"promptTokenCount\":12}}}\n\n");
        assert_eq!(partial_gemini.finish_with_completion(), (false, None));

        let mut limited_claude = UsageObserver::new(AgentProvider::Claude, true);
        limited_claude.push(b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n");
        assert_eq!(limited_claude.finish_with_completion(), (false, None));

        let mut completed_chat = UsageObserver::new(AgentProvider::Deepseek, true);
        completed_chat
            .push(b"data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
        assert_eq!(completed_chat.finish_with_completion(), (true, None));
    }

    #[test]
    fn gateway_key_hash_does_not_store_the_plaintext() {
        let key = "hw_live_test-secret-that-is-long-enough";
        let hash = hash_gateway_key(key);
        assert_ne!(hash, key.as_bytes());
        assert_eq!(hash.len(), 32);
    }

    #[test]
    fn codex_subscription_requests_drop_the_unsupported_output_limit() {
        let body = Bytes::from_static(
            br#"{"model":"gpt-5.6-sol","input":"hello","max_output_tokens":32000}"#,
        );
        let normalized = strip_unsupported_codex_fields(body);
        let payload: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

        assert_eq!(payload["model"], "gpt-5.6-sol");
        assert_eq!(payload["input"], "hello");
        assert!(payload.get("max_output_tokens").is_none());
    }

    #[test]
    fn grok_proxy_headers_match_the_current_subscription_contract() {
        let body = Bytes::from_static(br#"{"model":"grok-4.6","input":"hello"}"#);
        let headers = grok_proxy_headers("1.0.30", &body, true);

        assert_eq!(headers["x-xai-token-auth"], "xai-grok-cli");
        assert_eq!(headers["x-authenticateresponse"], "authenticate-response");
        assert_eq!(headers["x-grok-client-identifier"], "hub-william");
        assert_eq!(headers["x-grok-client-mode"], "headless");
        assert_eq!(headers["x-grok-client-version"], "1.0.30");
        assert_eq!(headers["x-grok-model-override"], "grok-4.6");
        assert_eq!(headers["x-grok-conv-id"], headers["x-grok-session-id"]);
        assert!(Uuid::parse_str(headers["x-grok-req-id"].to_str().unwrap()).is_ok());
    }

    #[test]
    fn claude_oauth_beta_is_preserved_without_duplication() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("prompt-caching-2024-07-31"),
        );
        let merged = merged_anthropic_beta(&headers);
        let text = merged.to_str().unwrap();
        assert!(text.contains("prompt-caching-2024-07-31"));
        assert!(text.contains("claude-code-20250219"));
        assert!(text.contains("oauth-2025-04-20"));

        headers.insert(
            "anthropic-beta",
            HeaderValue::from_static("oauth-2025-04-20"),
        );
        let merged = merged_anthropic_beta(&headers);
        let text = merged.to_str().unwrap();
        assert!(text.contains("claude-code-20250219"));
        assert!(text.contains("oauth-2025-04-20"));
        assert_eq!(text.matches("oauth-2025-04-20").count(), 1);
    }

    #[test]
    fn claude_billing_header_is_injected_into_system_prompt() {
        let empty_body = Bytes::from_static(br#"{"model":"claude-opus-5","messages":[]}"#);
        let with_billing = ensure_claude_billing_header(empty_body, "2.1.223");
        let parsed: Value = serde_json::from_slice(&with_billing).unwrap();
        let system_arr = parsed["system"].as_array().unwrap();
        assert!(system_arr[0]["text"].as_str().unwrap().contains(
            "x-anthropic-billing-header: cc_version=2.1.223.bd6; cc_entrypoint=sdk-cli;"
        ));

        let string_body = Bytes::from_static(
            br#"{"model":"claude-opus-5","system":"You are helpful.","messages":[]}"#,
        );
        let with_billing = ensure_claude_billing_header(string_body, "2.1.223");
        let parsed: Value = serde_json::from_slice(&with_billing).unwrap();
        let system_str = parsed["system"].as_str().unwrap();
        assert!(system_str.starts_with(
            "x-anthropic-billing-header: cc_version=2.1.223.bd6; cc_entrypoint=sdk-cli;\n\nYou are helpful."
        ));
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
    fn gemini_forbidden_is_account_failover_without_changing_other_client_errors() {
        use axum::http::StatusCode;

        assert_eq!(
            gemini_upstream_disposition(StatusCode::FORBIDDEN),
            UpstreamDisposition::NextPool
        );
        assert_eq!(
            upstream_disposition(StatusCode::FORBIDDEN),
            UpstreamDisposition::Return
        );
        assert_eq!(
            gemini_upstream_disposition(StatusCode::BAD_REQUEST),
            UpstreamDisposition::Return
        );
        assert_eq!(
            gemini_upstream_disposition(StatusCode::UNAUTHORIZED),
            UpstreamDisposition::Reauthorize
        );
    }

    #[test]
    fn transient_upstream_statuses_are_retried_before_returning_to_the_client() {
        for status in [
            axum::http::StatusCode::REQUEST_TIMEOUT,
            axum::http::StatusCode::INTERNAL_SERVER_ERROR,
            axum::http::StatusCode::BAD_GATEWAY,
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::http::StatusCode::GATEWAY_TIMEOUT,
        ] {
            assert_eq!(
                upstream_disposition(status),
                UpstreamDisposition::RetryTransient
            );
        }
    }

    #[test]
    fn transient_retries_preserve_attempts_for_remaining_candidates() {
        assert!(should_retry_same_candidate(1, 1, 0, 3));
        assert!(!should_retry_same_candidate(2, 2, 0, 3));
        assert!(!should_retry_same_candidate(3, 1, 1, 3));
        assert!(!should_retry_same_candidate(4, 1, 2, 3));

        assert!(should_retry_same_candidate(1, 1, 0, 1));
        assert!(should_retry_same_candidate(2, 2, 0, 1));
        assert!(should_retry_same_candidate(3, 3, 0, 1));
        assert!(!should_retry_same_candidate(4, 4, 0, 1));
    }

    #[test]
    fn retry_backoff_is_bounded_and_honors_short_retry_after_values() {
        let first = retry_delay(1, None);
        assert!((400..=600).contains(&first.as_millis()));

        let third = retry_delay(3, None);
        assert!((1_600..=2_000).contains(&third.as_millis()));

        let mut headers = HeaderMap::new();
        headers.insert("retry-after", HeaderValue::from_static("1"));
        assert!(retry_delay(1, Some(&headers)).as_millis() >= 1_000);
        headers.insert("retry-after", HeaderValue::from_static("60"));
        assert_eq!(retry_delay(1, Some(&headers)).as_millis(), 2_000);
    }

    #[test]
    fn gemini_native_requests_are_wrapped_for_code_assist() {
        let wrapped = gemini_code_assist_request(
            "gemini-3.8-flash-medium",
            "project-123",
            GeminiOperation::Generate,
            &json!({"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}),
        );
        assert_eq!(wrapped["model"], "gemini-3.8-flash-medium");
        assert_eq!(wrapped["project"], "project-123");
        assert_eq!(wrapped["request"]["contents"][0]["role"], "user");
        assert!(
            wrapped["requestId"]
                .as_str()
                .is_some_and(|request_id| request_id.starts_with("agent/"))
        );
        assert_eq!(wrapped["userAgent"], "antigravity");
        assert_eq!(wrapped["requestType"], "agent");
    }

    #[test]
    fn gemini_native_base_models_map_to_current_agy_effort_ids() {
        assert_eq!(
            antigravity_model_id(
                "gemini-3.8-flash",
                &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": -1}}})
            ),
            "gemini-3.8-flash-high"
        );
        assert_eq!(
            antigravity_model_id(
                "gemini-3.8-flash",
                &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 4000}}})
            ),
            "gemini-3.8-flash-medium"
        );
        assert_eq!(
            antigravity_model_id(
                "gemini-3.8-flash",
                &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 1000}}})
            ),
            "gemini-3.8-flash-low"
        );
        assert_eq!(
            antigravity_model_id("gemini-3.1-pro-preview-customtools", &json!({})),
            "gemini-3.1-pro-high"
        );
        assert_eq!(
            antigravity_model_id(
                "gemini-3.1-pro-preview",
                &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 1024}}})
            ),
            "gemini-3.1-pro-low"
        );
    }

    #[test]
    fn gemini_model_catalogue_keeps_only_current_antigravity_models() {
        let catalogue = gemini_model_catalogue(&json!({
            "models": {
                "gemini-3.8-flash-high": {"displayName": "Gemini 3.8 Flash (High)"},
                "gemini-3.7-flash-medium": {"displayName": "Gemini 3.7 Flash (Medium)"},
                "gemini-3.6-flash-low": {"displayName": "Gemini 3.6 Flash (Low)", "isInternal": true},
                "gemini-2.5-pro": {"displayName": "Gemini 2.5 Pro"}
            }
        }));
        assert_eq!(catalogue["object"], "list");
        assert_eq!(catalogue["data"].as_array().unwrap().len(), 2);
        assert_eq!(catalogue["data"][0]["id"], "gemini-3.8-flash-high");
        assert_eq!(catalogue["data"][1]["id"], "gemini-3.7-flash-medium");
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

    #[test]
    fn gemini_sse_transformer_normalizes_crlf_event_boundaries() {
        let mut transformer = GeminiSseTransformer::default();
        let output = transformer
            .push(b"data: {\"response\":{\"candidates\":[]},\"traceId\":\"trace-1\"}\r\n\r\n");
        let text = String::from_utf8(output.to_vec()).unwrap();
        assert!(!text.contains('\r'));
        assert!(text.ends_with("\n\n"));
    }

    #[test]
    fn default_openai_model_catalogue_includes_current_rollout_models() {
        let catalogue = default_openai_model_catalogue();
        assert_eq!(catalogue["object"], "list");
        let models = catalogue["data"].as_array().unwrap();
        assert_eq!(models.len(), 6);
        assert_eq!(models[0]["id"], "gpt-6-astra");
        assert_eq!(models[1]["id"], "gpt-6-sol");
        assert_eq!(models[2]["id"], "gpt-6-luna");
        assert_eq!(models[3]["id"], "gpt-5.6-sol");
        assert_eq!(models[4]["id"], "gpt-5.6-terra");
        assert_eq!(models[5]["id"], "gpt-5.6-luna");
    }

    #[test]
    fn default_claude_model_catalogue_includes_current_models_and_sonnet_effort() {
        let catalogue = default_claude_model_catalogue();
        assert_eq!(catalogue["object"], "list");
        let models = catalogue["data"].as_array().unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0]["id"], "claude-fable-5-1");
        assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
        assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[1]["id"], "claude-opus-5-5");
        assert_eq!(models[1]["display_name"], "Claude Opus 5.5");
        assert_eq!(models[1]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[2]["id"], "claude-sonnet-5");
        assert_eq!(models[2]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
    }

    #[test]
    fn parse_claude_models_markdown_extracts_models_and_effort() {
        let markdown = r#"
## Compare models

| Feature | Claude Fable 5.1 | Claude Opus 5.5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| :--- | :--- | :--- | :--- | :--- |
| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| [Default effort](https://platform.claude.com/effort) | `high` | `medium` | `high` | Not supported |
| Claude API alias | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5` | `claude-haiku-4-5` |

Legacy models (still available): [Claude Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview), [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview), [Claude Opus 4.8](https://platform.claude.com/docs/en/models/opus-4-8/overview).
"#;
        let parsed = parse_claude_models_markdown(markdown).unwrap();
        assert_eq!(parsed["object"], "list");
        let models = parsed["data"].as_array().unwrap();
        assert_eq!(models[0]["id"], "claude-fable-5-1");
        assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
        assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[1]["id"], "claude-opus-5-5");
        assert_eq!(models[1]["display_name"], "Claude Opus 5.5");
        assert_eq!(models[1]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
        assert!(models[3].get("capabilities").is_none());
        assert_eq!(models.len(), 4);
    }

    #[test]
    fn parse_openai_models_markdown_keeps_recommended_and_rollout_models() {
        let markdown = r#"
## Recommended models

GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna remain available during the rollout.

<ModelDetails
  name="gpt-6-astra"
  slug="gpt-6-astra"
/>
<ModelDetails
  name="gpt-6-sol"
  slug="gpt-6-sol"
/>
<ModelDetails
  name="gpt-6-luna"
  slug="gpt-6-luna"
/>

## Other models

<ModelDetails name="gpt-5.5" slug="gpt-5.5" />

## Deprecated Codex models

The `gpt-5.4` and `gpt-5.3-codex` models have retired.
"#;
        let parsed = parse_openai_models_markdown(markdown).unwrap();
        assert_eq!(parsed["object"], "list");
        let models = parsed["data"].as_array().unwrap();
        assert_eq!(models.len(), 6);
        assert_eq!(models[0]["id"], "gpt-6-astra");
        assert_eq!(models[0]["name"], "GPT-6 Astra");
        assert_eq!(models[1]["id"], "gpt-6-sol");
        assert_eq!(models[2]["id"], "gpt-6-luna");
        assert_eq!(models[3]["id"], "gpt-5.6-sol");
        assert_eq!(models[4]["id"], "gpt-5.6-terra");
        assert_eq!(models[5]["id"], "gpt-5.6-luna");
        assert!(
            parse_openai_models_markdown(
                "## Browse our full catalog of models\n- [GPT-5.5](/api/docs/models/gpt-5.5.md)"
            )
            .is_none()
        );
    }

    #[test]
    fn live_deepseek_and_grok_catalogues_drop_retired_aliases() {
        let mut deepseek = json!({"data": [
            {"id": "deepseek-flash"},
            {"id": "deepseek-v4-flash"},
            {"id": "deepseek-v4-pro"}
        ]});
        filter_current_live_model_catalogue(&mut deepseek, AgentProvider::Deepseek).unwrap();
        assert_eq!(deepseek["data"].as_array().unwrap().len(), 2);
        assert_eq!(deepseek["data"][0]["id"], "deepseek-flash");
        assert_eq!(deepseek["data"][1]["id"], "deepseek-v4-pro");

        let mut grok = json!({"data": [
            {"id": "grok-4.7"},
            {"id": "grok-4.2"},
            {"id": "grok-build"}
        ]});
        filter_current_live_model_catalogue(&mut grok, AgentProvider::Grok).unwrap();
        assert_eq!(grok["data"].as_array().unwrap().len(), 1);
        assert_eq!(grok["data"][0]["id"], "grok-4.7");
    }

    #[tokio::test]
    async fn filtered_live_catalogue_keeps_upstream_status_and_non_body_headers() {
        let response = axum::response::Response::builder()
            .status(axum::http::StatusCode::PARTIAL_CONTENT)
            .header("x-request-id", "upstream-request")
            .header(axum::http::header::CONTENT_LENGTH, "999")
            .body(axum::body::Body::from(
                r#"{"data":[{"id":"grok-4.7"},{"id":"grok-build"}]}"#,
            ))
            .unwrap();
        let filtered = filter_current_live_model_response(response, AgentProvider::Grok)
            .await
            .unwrap();
        assert_eq!(filtered.status(), axum::http::StatusCode::PARTIAL_CONTENT);
        assert_eq!(filtered.headers()["x-request-id"], "upstream-request");
        assert!(
            !filtered
                .headers()
                .contains_key(axum::http::header::CONTENT_LENGTH)
        );
        let body = axum::body::to_bytes(filtered.into_body(), 1024)
            .await
            .unwrap();
        let payload: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(payload["data"].as_array().unwrap().len(), 1);
        assert_eq!(payload["data"][0]["id"], "grok-4.7");
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod gemini_gateway_database_tests {
    use std::sync::{Arc, Mutex};

    use aes_gcm::{
        Aes256Gcm, Nonce,
        aead::{Aead, KeyInit},
    };
    use axum::{
        Json, Router,
        body::{Bytes, to_bytes},
        extract::State,
        http::{HeaderMap, StatusCode, header},
        routing::post,
    };
    use rand::RngCore;
    use serde_json::{Value, json};
    use sqlx::PgPool;
    use tokio::net::TcpListener;
    use uuid::Uuid;

    use super::{GatewaySelection, GeminiOperation, gemini_proxy_request_for_user};
    use crate::{AppConfig, AppState};

    #[derive(Clone)]
    struct FakeCodeAssist {
        blocked_status: Arc<Mutex<StatusCode>>,
        generation_tokens: Arc<Mutex<Vec<String>>>,
    }

    async fn load_code_assist() -> Json<Value> {
        Json(json!({ "cloudaicompanionProject": "test-project" }))
    }

    async fn generate(
        State(fake): State<FakeCodeAssist>,
        headers: HeaderMap,
    ) -> (StatusCode, Json<Value>) {
        let authorization = headers
            .get(header::AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        fake.generation_tokens
            .lock()
            .unwrap()
            .push(authorization.clone());
        if authorization == "Bearer blocked-token" {
            (
                *fake.blocked_status.lock().unwrap(),
                Json(json!({ "error": { "status": "PERMISSION_DENIED" } })),
            )
        } else {
            (
                StatusCode::OK,
                Json(json!({
                    "response": {
                        "candidates": [{
                            "content": { "parts": [{ "text": "healthy pool" }] }
                        }]
                    }
                })),
            )
        }
    }

    async fn add_gemini_connection(
        state: &AppState,
        user_id: Uuid,
        access_token: &str,
        older: bool,
    ) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agent_connections (id, user_id, provider, status)
             VALUES ($1, $2, 'gemini', 'connected')",
        )
        .bind(id)
        .bind(user_id)
        .execute(&state.pool)
        .await
        .unwrap();
        if older {
            sqlx::query(
                "UPDATE agent_connections
                 SET updated_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
            )
            .bind(id)
            .execute(&state.pool)
            .await
            .unwrap();
        }
        let token = json!({
            "access_token": access_token,
            "cloudaicompanion_project": "test-project"
        });
        let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
        let mut nonce = [0_u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                serde_json::to_vec(&token).unwrap().as_ref(),
            )
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_connection_credentials
             (connection_id, credential_ciphertext, credential_nonce)
             VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(ciphertext)
        .bind(nonce.to_vec())
        .execute(&state.pool)
        .await
        .unwrap();
        id
    }

    async fn generation(state: &AppState, selection: GatewaySelection) -> axum::response::Response {
        gemini_proxy_request_for_user(
            state,
            selection,
            "gemini-3.8-flash-high",
            GeminiOperation::Generate,
            Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
        )
        .await
        .unwrap()
    }

    #[sqlx::test]
    async fn blocked_gemini_pool_rotates_but_invalid_request_and_pinned_account_do_not(
        pool: PgPool,
    ) {
        let fake = FakeCodeAssist {
            blocked_status: Arc::new(Mutex::new(StatusCode::FORBIDDEN)),
            generation_tokens: Arc::new(Mutex::new(Vec::new())),
        };
        let server = Router::new()
            .route("/v1internal:loadCodeAssist", post(load_code_assist))
            .route("/v1internal:generateContent", post(generate))
            .with_state(fake.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let upstream_url = format!("http://{}", listener.local_addr().unwrap());
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
        let mut config = AppConfig::default();
        config.gemini_code_assist_url = upstream_url;
        let state = AppState {
            config,
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool,
        };
        let user_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, username, password_hash)
             VALUES ($1, $2, 'test-only')",
        )
        .bind(user_id)
        .bind(user_id.simple().to_string())
        .execute(&state.pool)
        .await
        .unwrap();
        add_gemini_connection(&state, user_id, "healthy-token", true).await;
        let blocked_id = add_gemini_connection(&state, user_id, "blocked-token", false).await;
        let selection = GatewaySelection::from(user_id);

        let response = generation(&state, selection).await;
        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap()["candidates"][0]["content"]["parts"][0]
                ["text"],
            "healthy pool"
        );
        assert_eq!(
            std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
            ["Bearer blocked-token", "Bearer healthy-token"]
        );
        let availability: String =
            sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
                .bind(blocked_id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(availability, "active");

        let pinned = GatewaySelection {
            user_id,
            connection_id: Some(blocked_id),
            organization_id: None,
        };
        assert_eq!(
            generation(&state, pinned).await.status(),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
            ["Bearer blocked-token"]
        );

        *fake.blocked_status.lock().unwrap() = StatusCode::BAD_REQUEST;
        assert_eq!(
            generation(&state, selection).await.status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
            ["Bearer blocked-token"]
        );

        *fake.blocked_status.lock().unwrap() = StatusCode::UNAUTHORIZED;
        assert_eq!(generation(&state, selection).await.status(), StatusCode::OK);
        assert_eq!(
            std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
            ["Bearer blocked-token", "Bearer healthy-token"]
        );
        let availability: String =
            sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
                .bind(blocked_id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(availability, "reauth_required");
        server_task.abort();
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod organization_gateway_database_tests {
    use std::time::Duration;

    use axum::{Router, body::to_bytes, http::header, routing::get};
    use sqlx::PgPool;
    use uuid::Uuid;

    use super::{
        GatewaySelection, OrganizationUsageEvent, connected_provider_candidates,
        record_organization_usage, upstream_response_with_usage,
    };
    use crate::{AgentProvider, AppConfig, AppState, error::ApiError};

    #[sqlx::test]
    async fn organization_candidate_scope_does_not_grant_personal_pool_access(pool: PgPool) {
        let state = AppState {
            config: AppConfig::default(),
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool,
        };
        let owner = Uuid::new_v4();
        let member = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        for user_id in [owner, member] {
            sqlx::query(
                "INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')",
            )
            .bind(user_id)
            .bind(user_id.simple().to_string())
            .execute(&state.pool)
            .await
            .unwrap();
        }
        sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Team')")
            .bind(org_id)
            .execute(&state.pool)
            .await
            .unwrap();
        for (user_id, role) in [(owner, "owner"), (member, "member")] {
            sqlx::query(
                "INSERT INTO organization_memberships
                 (id, org_id, user_id, role, status, joined_at)
                 VALUES ($1, $2, $3, $4, 'accepted', NOW())",
            )
            .bind(Uuid::new_v4())
            .bind(org_id)
            .bind(user_id)
            .bind(role)
            .execute(&state.pool)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'masked')",
        )
        .bind(connection_id)
        .bind(owner)
        .execute(&state.pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(connection_id)
        .bind(owner)
        .execute(&state.pool)
        .await
        .unwrap();

        let personal = GatewaySelection::from(member);
        let scoped = GatewaySelection {
            user_id: member,
            connection_id: Some(connection_id),
            organization_id: Some(org_id),
        };
        assert!(matches!(
            connected_provider_candidates(&state, personal, AgentProvider::Deepseek).await,
            Err(ApiError::Forbidden)
        ));
        assert_eq!(
            connected_provider_candidates(&state, scoped, AgentProvider::Deepseek)
                .await
                .unwrap()
                .len(),
            1
        );

        sqlx::query("DELETE FROM organization_agents WHERE org_id = $1 AND connection_id = $2")
            .bind(org_id)
            .bind(connection_id)
            .execute(&state.pool)
            .await
            .unwrap();
        assert!(matches!(
            connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
            Err(ApiError::Forbidden)
        ));
        sqlx::query(
            "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(connection_id)
        .bind(owner)
        .execute(&state.pool)
        .await
        .unwrap();
        assert_eq!(
            connected_provider_candidates(&state, scoped, AgentProvider::Deepseek)
                .await
                .unwrap()
                .len(),
            1
        );
        sqlx::query("DELETE FROM organization_memberships WHERE org_id = $1 AND user_id = $2")
            .bind(org_id)
            .bind(member)
            .execute(&state.pool)
            .await
            .unwrap();
        assert!(matches!(
            connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
            Err(ApiError::Forbidden)
        ));
        sqlx::query(
            "INSERT INTO agent_pool_join_requests
             (id, connection_id, requester_user_id, telegram, reason, status)
             VALUES ($1, $2, $3, 'test', 'test', 'accepted')",
        )
        .bind(Uuid::new_v4())
        .bind(connection_id)
        .bind(member)
        .execute(&state.pool)
        .await
        .unwrap();
        assert_eq!(
            connected_provider_candidates(&state, personal, AgentProvider::Deepseek)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(matches!(
            connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
            Err(ApiError::Forbidden)
        ));
    }

    #[sqlx::test]
    async fn organization_usage_records_only_completed_generation_streams(pool: PgPool) {
        let user_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(user_id)
            .bind(user_id.simple().to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Stream test')")
            .bind(org_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'test')",
        )
        .bind(connection_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();

        let app = Router::new()
            .route(
                "/incomplete",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":12}}\n\n",
                    )
                }),
            )
            .route(
                "/complete",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":7}}}\n\n",
                    )
                }),
            )
            .route(
                "/unknown",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.completed\"}\n\n",
                    )
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
        let client = reqwest::Client::new();
        let event = OrganizationUsageEvent {
            pool: pool.clone(),
            organization_id: org_id,
            user_id,
            connection_id,
            provider: AgentProvider::Deepseek,
            model: Some("deepseek-chat".to_owned()),
        };
        for (path, expected_count) in [
            ("incomplete", 0_i64),
            ("complete", 1_i64),
            ("unknown", 2_i64),
        ] {
            let upstream = client
                .get(format!("http://{address}/{path}"))
                .send()
                .await
                .unwrap();
            let response = upstream_response_with_usage(upstream, Some(event.clone()))
                .await
                .unwrap();
            to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
            let count: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM organization_usage_events WHERE org_id = $1",
            )
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
            assert_eq!(count, expected_count, "{path} stream count");
        }
        let known_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM organization_usage_events
             WHERE org_id = $1 AND input_tokens = 12 AND output_tokens = 7",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(known_count, 1);

        let upstream = client
            .get(format!("http://{address}/complete"))
            .send()
            .await
            .unwrap();
        let response = upstream_response_with_usage(upstream, Some(event))
            .await
            .unwrap();
        sqlx::query("DELETE FROM agent_connections WHERE id = $1")
            .bind(connection_id)
            .execute(&pool)
            .await
            .unwrap();
        to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let (count, null_connections): (i64, i64) = sqlx::query_as(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE connection_id IS NULL)
             FROM organization_usage_events WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!((count, null_connections), (3, 3));
        server.abort();
    }

    #[sqlx::test]
    async fn organization_usage_survives_concurrent_connection_delete(pool: PgPool) {
        let user_id = Uuid::new_v4();
        let org_id = Uuid::new_v4();
        let connection_id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(user_id)
            .bind(user_id.simple().to_string())
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Concurrent delete')")
            .bind(org_id)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'test')",
        )
        .bind(connection_id)
        .bind(user_id)
        .execute(&pool)
        .await
        .unwrap();

        let mut deleting = pool.begin().await.unwrap();
        sqlx::query("DELETE FROM agent_connections WHERE id = $1")
            .bind(connection_id)
            .execute(&mut *deleting)
            .await
            .unwrap();
        let event = OrganizationUsageEvent {
            pool: pool.clone(),
            organization_id: org_id,
            user_id,
            connection_id,
            provider: AgentProvider::Deepseek,
            model: Some("deepseek-chat".to_owned()),
        };
        let insert = tokio::spawn(async move { record_organization_usage(&event, None).await });

        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let waiting: bool = sqlx::query_scalar(
                    "SELECT EXISTS (
                       SELECT 1 FROM pg_stat_activity
                       WHERE datname = current_database()
                         AND pid <> pg_backend_pid()
                         AND query LIKE 'INSERT INTO organization_usage_events%'
                         AND wait_event_type = 'Lock'
                     )",
                )
                .fetch_one(&pool)
                .await
                .unwrap();
                if waiting {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("usage insert must wait for the connection deletion");

        deleting.commit().await.unwrap();
        insert.await.unwrap().unwrap();
        let connection: Option<Uuid> = sqlx::query_scalar(
            "SELECT connection_id FROM organization_usage_events WHERE org_id = $1",
        )
        .bind(org_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(connection, None);
    }
}
