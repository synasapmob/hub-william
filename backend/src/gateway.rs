use axum::{
    Json,
    body::{Body, Bytes},
    extract::{OriginalUri, Path, State},
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode, header},
    response::Response,
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AgentProvider, AppState, auth::authenticated_user_id, connections::provider_credential,
    error::ApiError,
};

const OPENAI_RESPONSES_URL: &str = "https://chatgpt.com/backend-api/codex/responses";
const CLAUDE_MESSAGES_URL: &str = "https://api.anthropic.com/v1/messages";
const CLAUDE_COUNT_TOKENS_URL: &str = "https://api.anthropic.com/v1/messages/count_tokens";
const GROK_CHAT_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";

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
    connected_provider_id(&state, authorized.user_id, AgentProvider::Grok).await?;

    Ok(Json(json!({
        "object": "list",
        "data": [{
            "id": "grok-build",
            "object": "model",
            "owned_by": "xai"
        }]
    })))
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
    let connection_id = connected_provider_id(state, authorized.user_id, expected_provider).await?;
    let (credential_provider, token) = provider_credential(state, connection_id).await?;
    if credential_provider != expected_provider {
        return Err(ApiError::Forbidden);
    }
    let access_token = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or(ApiError::Forbidden)?;
    let upstream_url = append_query(upstream_url, original_uri.query());
    let mut request = state
        .http
        .post(upstream_url)
        .bearer_auth(access_token)
        .body(body);

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
        AgentProvider::Grok => request
            .header("x-xai-token-auth", "xai-grok-cli")
            .header("x-grok-client-version", "1.0.13")
            .header("x-grok-client-identifier", "grok-shell")
            .header("user-agent", "xai-grok-build/1.0.13"),
    };

    let upstream = request
        .send()
        .await
        .map_err(|error| upstream_network_error(expected_provider, error))?;
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let stream = upstream.bytes_stream();
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    response.body(Body::from_stream(stream)).map_err(|error| {
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

async fn connected_provider_id(
    state: &AppState,
    user_id: Uuid,
    provider: AgentProvider,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar(
        "SELECT connections.id
         FROM agent_connections AS connections
         LEFT JOIN agent_pool_join_requests AS requests
           ON requests.connection_id = connections.id
          AND requests.requester_user_id = $1
          AND requests.status = 'accepted'
         WHERE connections.provider = $2
           AND connections.status = 'connected'
           AND (connections.user_id = $1 OR requests.id IS NOT NULL)
         ORDER BY (connections.user_id = $1) DESC,
                  COALESCE(requests.updated_at, connections.updated_at) DESC
         LIMIT 1",
    )
    .bind(user_id)
    .bind(provider.to_string())
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Forbidden)
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

fn chatgpt_account_id(token: &Value) -> Option<String> {
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

    use super::{chatgpt_account_id, hash_gateway_key, merged_anthropic_beta};

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
}
