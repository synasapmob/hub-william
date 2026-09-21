use std::sync::{OnceLock, RwLock};
use std::time::{Duration as StdDuration, Instant};

use axum::{
    Json,
    body::{Body, Bytes},
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header},
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
    AgentProvider, AppState,
    auth::authenticated_user_id,
    connections::{ANTIGRAVITY_CLIENT_VERSION, load_gemini_code_assist, provider_credential},
    error::ApiError,
};

const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_COUNT_TOKENS_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";
const GROK_CHAT_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";
const GROK_RESPONSES_URL: &str = "https://cli-chat-proxy.grok.com/v1/responses";
const GROK_MODELS_URL: &str = "https://cli-chat-proxy.grok.com/v1/models-v2";
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
    RetryTransient,
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
    connected_provider_ids(&state, authorized.user_id, AgentProvider::Chatgpt).await?;

    Ok(Json(fetch_or_cached_openai_catalogue(&state.http).await))
}

fn default_openai_model_catalogue() -> Value {
    json!({
        "object": "list",
        "data": [
            { "id": "gpt-6-astra", "name": "GPT-6 Astra", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-sol", "name": "GPT-5.6 Sol", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-terra", "name": "GPT-5.6 Terra", "object": "model", "owned_by": "openai" },
            { "id": "gpt-5.6-luna", "name": "GPT-5.6 Luna", "object": "model", "owned_by": "openai" }
        ]
    })
}

pub(crate) fn parse_openai_models_markdown(content: &str) -> Option<Value> {
    let mut models = Vec::new();
    let mut seen = std::collections::HashSet::new();

    for line in content.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('-') || !trimmed.contains("/api/docs/models/") {
            continue;
        }
        let Some(name_start) = trimmed.find('[') else {
            continue;
        };
        let Some(name_end) = trimmed.find(']') else {
            continue;
        };
        let Some(url_start) = trimmed[name_end..].find("(/api/docs/models/") else {
            continue;
        };
        let url_part = &trimmed[name_end + url_start + "(/api/docs/models/".len()..];
        let Some(url_end) = url_part.find(".md)") else {
            continue;
        };

        let display_name = trimmed[name_start + 1..name_end].trim();
        let model_id = url_part[..url_end].trim();

        let is_target_model = model_id.starts_with("gpt-")
            || model_id.starts_with("o1")
            || model_id.starts_with("o3")
            || model_id.starts_with("o4")
            || model_id.starts_with("codex");

        if !model_id.is_empty() && !seen.contains(model_id) && is_target_model {
            seen.insert(model_id.to_string());
            models.push(json!({
                "id": model_id,
                "name": display_name,
                "object": "model",
                "owned_by": "openai"
            }));
        }
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

async fn fetch_or_cached_openai_catalogue(http: &reqwest::Client) -> Value {
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
            .get("https://developers.openai.com/api/docs/models.md")
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
    connected_provider_ids(&state, authorized.user_id, AgentProvider::Claude).await?;

    Ok(Json(fetch_or_cached_claude_catalogue(&state.http).await))
}

fn default_claude_model_catalogue() -> Value {
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
                "id": "claude-opus-5",
                "display_name": "Claude Opus 5",
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
            },
            {
                "id": "claude-haiku-4-5",
                "display_name": "Claude Haiku 4.5 (Latest)"
            },
            {
                "id": "claude-fable-5",
                "display_name": "Claude Fable 5",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-opus-4-8",
                "display_name": "Claude Opus 4.8",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-opus-4-7",
                "display_name": "Claude Opus 4.7",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-opus-4-6",
                "display_name": "Claude Opus 4.6",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-sonnet-4-6",
                "display_name": "Claude Sonnet 4.6",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-sonnet-4-5",
                "display_name": "Claude Sonnet 4.5",
                "capabilities": {
                    "effort": standard_effort
                }
            },
            {
                "id": "claude-opus-4-5",
                "display_name": "Claude Opus 4.5",
                "capabilities": {
                    "effort": standard_effort
                }
            }
        ]
    })
}

pub(crate) fn parse_claude_models_markdown(content: &str) -> Option<Value> {
    let mut header_cols: Vec<String> = Vec::new();
    let mut id_cols: Vec<String> = Vec::new();
    let mut effort_cols: Vec<String> = Vec::new();
    let mut alias_cols: Vec<String> = Vec::new();

    for line in content.lines() {
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
            } else if label == "Claude API alias" {
                alias_cols = parts[2..parts.len() - 1]
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

    for (i, alias) in alias_cols.into_iter().enumerate() {
        if !alias.is_empty() && !seen.contains(&alias) {
            seen.insert(alias.clone());
            let name = header_cols
                .get(i)
                .map(|h| format!("{h} (Latest)"))
                .unwrap_or_else(|| alias.clone());
            models.push(json!({
                "id": alias,
                "display_name": name,
            }));
        }
    }

    for line in content.lines() {
        if line.contains("Legacy models") {
            for part in line.split("https://platform.claude.com/docs/en/models/") {
                if let Some(slug) = part.split("/overview").next() {
                    let slug = slug.trim();
                    if !slug.is_empty() && slug.chars().all(|c| c.is_alphanumeric() || c == '-') {
                        let model_id = if slug.starts_with("claude-") {
                            slug.to_string()
                        } else {
                            format!("claude-{slug}")
                        };
                        if !seen.contains(&model_id) {
                            seen.insert(model_id.clone());
                            let display_name = model_id
                                .split('-')
                                .map(|p| {
                                    let mut chars = p.chars();
                                    match chars.next() {
                                        None => String::new(),
                                        Some(first) => first.to_uppercase().chain(chars).collect(),
                                    }
                                })
                                .collect::<Vec<_>>()
                                .join(" ");
                            models.push(json!({
                                "id": model_id,
                                "display_name": display_name,
                                "capabilities": { "effort": standard_effort }
                            }));
                        }
                    }
                }
            }
        }
    }

    if models.is_empty() {
        None
    } else {
        Some(json!({ "object": "list", "data": models }))
    }
}

async fn fetch_or_cached_claude_catalogue(http: &reqwest::Client) -> Value {
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
    proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/models", state.config.deepseek_api_url),
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await
}

pub async fn grok_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_MODELS_URL,
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await
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
    let candidates =
        connected_provider_candidates(&state, authorized.user_id, AgentProvider::Gemini).await?;
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
    let candidate_count = candidates.len();
    let mut attempts_used = 0;

    'candidates: for (candidate_index, candidate) in candidates.into_iter().enumerate() {
        if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
            break;
        }
        let claimed_probe = match claim_candidate(&state, &candidate).await {
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
        let (credential_provider, token) = match provider_credential(&state, candidate.id).await {
            Ok(credential) => credential,
            Err(error) => {
                if claimed_probe {
                    release_probe(&state, candidate.id).await?;
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
                release_probe(&state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        };
        if credential_provider != AgentProvider::Gemini {
            if claimed_probe {
                release_probe(&state, candidate.id).await?;
            }
            last_error = Some(ApiError::Forbidden);
            continue;
        }
        let project = current_gemini_project(&state, access_token, project).await;
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
                            release_probe(&state, candidate.id).await?;
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
                        release_probe(&state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, None);
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
            };
            match upstream_disposition(upstream.status()) {
                UpstreamDisposition::RateLimit => {
                    mark_rate_limited(&state, candidate.id).await?;
                    saw_rate_limit = true;
                    continue 'candidates;
                }
                UpstreamDisposition::Reauthorize => {
                    mark_reauth_required(&state, candidate.id).await?;
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
                            release_probe(&state, candidate.id).await?;
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
                        release_probe(&state, candidate.id).await?;
                    }
                    let delay = retry_delay(attempts_used, Some(upstream.headers()));
                    tokio::time::sleep(delay).await;
                    if retry_same {
                        continue;
                    }
                    continue 'candidates;
                }
                UpstreamDisposition::Return if !upstream.status().is_success() => {
                    if claimed_probe {
                        release_probe(&state, candidate.id).await?;
                    }
                    last_error = Some(ApiError::Provider(format!(
                        "Google model discovery returned HTTP {}.",
                        upstream.status()
                    )));
                    continue 'candidates;
                }
                UpstreamDisposition::Return => {}
            }
            let payload = upstream.json::<Value>().await.map_err(|_| {
                ApiError::Provider("Google returned an invalid Gemini model catalogue.".to_owned())
            })?;
            mark_active(&state, candidate.id).await?;
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
    let candidates =
        connected_provider_candidates(state, authorized.user_id, AgentProvider::Gemini).await?;
    let request_body: Value = serde_json::from_slice(&body)
        .map_err(|_| ApiError::Validation("The Gemini request body must be valid JSON."))?;
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
            match upstream_disposition(upstream.status()) {
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
                        "Gemini gateway attempt {attempts_used}/{MAX_UPSTREAM_ATTEMPTS} returned HTTP {}",
                        upstream.status()
                    );
                    if attempts_used >= MAX_UPSTREAM_ATTEMPTS {
                        if claimed_probe {
                            release_probe(state, candidate.id).await?;
                        }
                        return gemini_upstream_response(upstream, operation).await;
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
            return gemini_upstream_response(upstream, operation).await;
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
        let mut client_gone = false;
        while let Some(item) = stream.next().await {
            match item {
                Ok(bytes) => {
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
        if !tail.is_empty() && !client_gone {
            let _ = tx.send(Ok(tail)).await;
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
    let candidates =
        connected_provider_candidates(state, authorized.user_id, expected_provider).await?;
    let upstream_url = append_query(upstream_url, original_uri.query());
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
                UpstreamDisposition::Return => {}
            }
            mark_active(state, candidate.id).await?;
            return upstream_response(upstream).await;
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
    let candidates = connected_provider_candidates(state, user_id, provider).await?;
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
        StatusCode::REQUEST_TIMEOUT
        | StatusCode::INTERNAL_SERVER_ERROR
        | StatusCode::BAD_GATEWAY
        | StatusCode::SERVICE_UNAVAILABLE
        | StatusCode::GATEWAY_TIMEOUT => UpstreamDisposition::RetryTransient,
        _ => UpstreamDisposition::Return,
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
    use axum::{
        body::Bytes,
        http::{HeaderMap, HeaderValue},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::{Value, json};
    use uuid::Uuid;

    use super::{
        GeminiOperation, GeminiSseTransformer, UpstreamDisposition, antigravity_model_id,
        chatgpt_account_id, default_claude_model_catalogue, default_openai_model_catalogue,
        ensure_claude_billing_header, gemini_code_assist_request, gemini_model_catalogue,
        grok_proxy_headers, hash_gateway_key, merged_anthropic_beta, parse_claude_models_markdown,
        parse_gemini_operation, parse_openai_models_markdown, rate_limit_cooldown, retry_delay,
        should_retry_same_candidate, strip_unsupported_codex_fields, unwrap_gemini_response,
        upstream_disposition,
    };

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
    fn default_openai_model_catalogue_includes_gpt6_and_gpt5_models() {
        let catalogue = default_openai_model_catalogue();
        assert_eq!(catalogue["object"], "list");
        let models = catalogue["data"].as_array().unwrap();
        assert_eq!(models.len(), 4);
        assert_eq!(models[0]["id"], "gpt-6-astra");
    }

    #[test]
    fn default_claude_model_catalogue_includes_current_models_and_sonnet_effort() {
        let catalogue = default_claude_model_catalogue();
        assert_eq!(catalogue["object"], "list");
        let models = catalogue["data"].as_array().unwrap();
        assert!(models.len() >= 4);
        assert_eq!(models[0]["id"], "claude-fable-5-1");
        assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
        assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[1]["id"], "claude-opus-5");
        assert_eq!(models[1]["display_name"], "Claude Opus 5");
        assert_eq!(models[1]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[2]["id"], "claude-sonnet-5");
        assert_eq!(models[2]["display_name"], "Claude Sonnet 5");
        assert_eq!(models[2]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
    }

    #[test]
    fn parse_claude_models_markdown_extracts_models_and_effort() {
        let markdown = r#"
| Feature | Claude Fable 5.1 | Claude Opus 5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| :--- | :--- | :--- | :--- | :--- |
| Claude API ID | `claude-fable-5-1` | `claude-opus-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| [Default effort](https://platform.claude.com/effort) | `high` | `high` | `high` | Not supported |
| Claude API alias | `claude-fable-5-1` | `claude-opus-5` | `claude-sonnet-5` | `claude-haiku-4-5` |

Legacy models (still available): [Claude Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview), [Claude Opus 4.8](https://platform.claude.com/docs/en/models/opus-4-8/overview).
"#;
        let parsed = parse_claude_models_markdown(markdown).unwrap();
        assert_eq!(parsed["object"], "list");
        let models = parsed["data"].as_array().unwrap();
        assert_eq!(models[0]["id"], "claude-fable-5-1");
        assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
        assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
        assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
        assert!(models[3].get("capabilities").is_none());
        assert_eq!(models[4]["id"], "claude-haiku-4-5");
        assert_eq!(models[5]["id"], "claude-fable-5");
        assert_eq!(models[6]["id"], "claude-opus-4-8");
    }

    #[test]
    fn parse_openai_models_markdown_extracts_gpt_models() {
        let markdown = r#"
## Featured models

- [GPT-6 Astra](/api/docs/models/gpt-6-astra.md): Our most capable model
- [GPT-5.6 Sol](/api/docs/models/gpt-5.6-sol.md): Flagship model
- [GPT-5.6 Terra](/api/docs/models/gpt-5.6-terra.md): Balances cost
- [GPT-5.6 Luna](/api/docs/models/gpt-5.6-luna.md): High volume

## Browse our full catalog of models

- [GPT-5.5](/api/docs/models/gpt-5.5.md): A new class of intelligence
- [GPT-5.3-Codex](/api/docs/models/gpt-5.3-codex.md): Most capable coding model
- [text-embedding-3-small](/api/docs/models/text-embedding-3-small.md): Small embedding
"#;
        let parsed = parse_openai_models_markdown(markdown).unwrap();
        assert_eq!(parsed["object"], "list");
        let models = parsed["data"].as_array().unwrap();
        assert_eq!(models.len(), 6);
        assert_eq!(models[0]["id"], "gpt-6-astra");
        assert_eq!(models[0]["name"], "GPT-6 Astra");
        assert_eq!(models[1]["id"], "gpt-5.6-sol");
        assert_eq!(models[4]["id"], "gpt-5.5");
        assert_eq!(models[5]["id"], "gpt-5.3-codex");
    }
}
