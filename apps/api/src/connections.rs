use std::{
    fmt,
    str::FromStr,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use tokio::sync::Notify;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{AppState, auth::authenticated_user_id, error::ApiError};

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
const CODEX_SCOPES: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
pub(crate) const ANTIGRAVITY_CLIENT_VERSION: &str = "antigravity/cli/1.2.3 (aidev_client; os_type=linux; arch=amd64; cl=981443618; auth_method=consumer)";
const GEMINI_SCOPES: &str = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
const GROK_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const GROK_CLIENT_SURFACE: &str = "grok-build";
const DEFAULT_DEVICE_EXPIRY_SECONDS: i64 = 900;
const DEFAULT_POLL_SECONDS: u64 = 5;
/// Background refresh cadence: every connected credential rotates once it has
/// gone 30 minutes plus a stable per-account offset of up to 15 minutes without
/// a refresh, so each account refreshes every 30-45 minutes and accounts do not
/// all reach their provider in the same minute.
const PROVIDER_CREDENTIAL_REFRESH_BASE_MINUTES: i64 = 30;
const PROVIDER_CREDENTIAL_REFRESH_SPREAD_SECONDS: i64 = 15 * 60;
const EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE: &str =
    "Provider authorization expired. Refresh this pool to reconnect.";
const ACCOUNT_VERIFICATION_REQUIRED_MESSAGE: &str =
    "Provider account verification is required. Reconnect this pool.";
pub(crate) const PROVIDER_LOGIN_REQUIRED_MESSAGE: &str =
    "Provider login is required. Reconnect this pool.";
const EXPIRED_AUTHORIZATION_PROMPT_MESSAGE: &str = "Authorization expired. Start again.";
/// Reconnect states that do not prove the stored refresh credential is dead.
/// The background sweep retries them and restores the account when the
/// provider accepts a refreshed credential.
const RECOVERABLE_REAUTHORIZATION_MESSAGES: [&str; 2] = [
    PROVIDER_LOGIN_REQUIRED_MESSAGE,
    EXPIRED_AUTHORIZATION_PROMPT_MESSAGE,
];

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;

pub use crate::provider_catalogue::AgentProvider;

impl AgentProvider {
    pub(crate) fn label(self) -> &'static str {
        &crate::provider_catalogue::provider(self).label
    }
}

impl FromStr for AgentProvider {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        Self::ALL
            .into_iter()
            .find(|id| id.as_str() == value)
            .ok_or(ApiError::Internal)
    }
}

impl fmt::Display for AgentProvider {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    Pending,
    Connected,
    Failed,
    Disconnected,
}

impl FromStr for AgentConnectionStatus {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "pending" => Ok(Self::Pending),
            "connected" => Ok(Self::Connected),
            "failed" => Ok(Self::Failed),
            "disconnected" => Ok(Self::Disconnected),
            _ => Err(ApiError::Internal),
        }
    }
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct StartAgentConnectionRequest {
    pub provider: AgentProvider,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CompleteAuthorizationRequest {
    pub callback_url: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ConnectDeepseekRequest {
    pub api_key: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ConnectGroqRequest {
    pub api_key: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentAuthorizationPrompt {
    pub authorization_url: String,
    pub expires_at: DateTime<Utc>,
    pub poll_after_seconds: u64,
    pub requires_callback_url: bool,
    pub user_code: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentConnection {
    pub account_label: Option<String>,
    pub authorization: Option<AgentAuthorizationPrompt>,
    pub availability_status: String,
    pub created_at: DateTime<Utc>,
    pub failure_message: Option<String>,
    pub id: Uuid,
    pub plan: Option<String>,
    pub provider: AgentProvider,
    pub status: AgentConnectionStatus,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ConnectionRow {
    availability_status: String,
    account_label: Option<String>,
    created_at: DateTime<Utc>,
    failure_message: Option<String>,
    id: Uuid,
    plan: Option<String>,
    provider: String,
    status: String,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct AuthorizationRow {
    expires_at: DateTime<Utc>,
    secret_ciphertext: Vec<u8>,
    secret_nonce: Vec<u8>,
}

#[derive(Debug, FromRow)]
struct CredentialRow {
    access_token_expires_at: Option<DateTime<Utc>>,
    credential_ciphertext: Vec<u8>,
    credential_nonce: Vec<u8>,
    refresh_attempted_at: Option<DateTime<Utc>>,
    refresh_token_expires_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, FromRow)]
struct ConnectionMetadataCredentialRow {
    connection_id: Uuid,
    credential_ciphertext: Vec<u8>,
    credential_nonce: Vec<u8>,
    plan: Option<String>,
    provider: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
enum AuthorizationSecret {
    Chatgpt {
        authorization_url: String,
        code_verifier: String,
        redirect_uri: String,
        state: String,
    },
    Claude {
        authorization_url: String,
        code_verifier: String,
        redirect_uri: String,
        state: String,
    },
    Gemini {
        authorization_url: String,
        code_verifier: String,
        redirect_uri: String,
        state: String,
    },
    Grok {
        device_code: String,
        user_code: String,
        verification_uri_complete: String,
    },
}

struct StartedAuthorization {
    expires_at: DateTime<Utc>,
    poll_after_seconds: u64,
    prompt_url: String,
    requires_callback_url: bool,
    secret: AuthorizationSecret,
    user_code: Option<String>,
}

enum RefreshConnectionOutcome {
    Connected {
        connection: AgentConnection,
        refreshed: bool,
    },
    ReauthorizationRequired(ConnectionRow),
}

#[derive(Clone, Copy, Debug)]
enum CredentialRefreshMode {
    Force,
    NearExpiry,
    /// Scheduled rotation once the credential is older than this account's
    /// 30-45 minute refresh interval.
    Stale(Duration),
    Nightly(DateTime<Utc>),
    /// Scheduled retry of an account the gateway marked for reconnect. A
    /// successful refresh restores it; a rejected refresh token keeps it
    /// waiting for its owner.
    Recover(Duration),
    /// A provider rejected this access token (SHA-256 fingerprint). Refresh
    /// only when it is still the stored token; otherwise another request has
    /// already rotated it and the caller retries with the stored credential.
    Rejected([u8; 32]),
}

impl CredentialRefreshMode {
    fn records_scheduled_attempt(self) -> bool {
        matches!(self, Self::Stale(_) | Self::Nightly(_) | Self::Recover(_))
    }

    fn restores_availability(self) -> bool {
        matches!(self, Self::Force | Self::Recover(_))
    }

    fn label(self) -> &'static str {
        match self {
            Self::Force => "manual refresh",
            Self::NearExpiry => "request refresh",
            Self::Stale(_) => "scheduled refresh",
            Self::Nightly(_) => "nightly check",
            Self::Recover(_) => "scheduled recovery",
            Self::Rejected(_) => "rejected-token refresh",
        }
    }
}

/// A usable provider credential, or proof that its owner must reconnect it.
pub(crate) enum CredentialLookup {
    Ready(AgentProvider, Value),
    ReauthorizationRequired,
}

fn access_token_fingerprint(access_token: &str) -> [u8; 32] {
    Sha256::digest(access_token.as_bytes()).into()
}

/// This account's scheduled refresh interval: 30 minutes plus a stable offset
/// of up to 15 minutes derived from the last byte of its ID. The SQL in
/// `refresh_due_provider_credentials` computes the same value.
fn scheduled_refresh_after(connection_id: Uuid) -> Duration {
    Duration::minutes(PROVIDER_CREDENTIAL_REFRESH_BASE_MINUTES)
        + Duration::seconds(
            i64::from(connection_id.as_bytes()[15]) * PROVIDER_CREDENTIAL_REFRESH_SPREAD_SECONDS
                / 256,
        )
}

#[derive(Debug, Default)]
pub struct ProviderCredentialRefreshSummary {
    pub failed: u64,
    pub reauthorization_required: u64,
    pub recovered: u64,
    pub refreshed: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCredentialRefreshStatus {
    Refreshed,
    ReauthorizationRequired,
    Failed,
}

#[derive(Debug, Serialize)]
pub struct ProviderCredentialRefreshResult {
    pub connection_id: Uuid,
    pub provider: String,
    pub status: ProviderCredentialRefreshStatus,
}

enum ProviderRefreshError {
    ReauthorizationRequired,
    Api(ApiError),
}

#[derive(Debug, Deserialize)]
struct GrokDeviceResponse {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    interval: Option<u64>,
}

#[utoipa::path(
    post,
    path = "/agent-connections/start",
    request_body = StartAgentConnectionRequest,
    responses(
        (status = 201, description = "Provider authorization started", body = AgentConnection),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse),
        (status = 502, description = "Provider authorization unavailable", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn start(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<StartAgentConnectionRequest>,
) -> Result<(StatusCode, Json<AgentConnection>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let started = start_provider_authorization(&state, payload.provider).await?;
    let (secret_ciphertext, secret_nonce) =
        encrypt_json(&state.config.credential_encryption_key, &started.secret)?;
    let connection_id = Uuid::new_v4();
    let flow = if started.requires_callback_url {
        "authorization_code"
    } else {
        "device_code"
    };
    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    let row = sqlx::query_as::<_, ConnectionRow>(
        "INSERT INTO agent_connections
            (id, user_id, provider, status, account_label, plan, failure_message)
         VALUES ($1, $2, $3, 'pending', NULL, NULL, NULL)
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(connection_id)
    .bind(user_id)
    .bind(payload.provider.as_str())
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;

    sqlx::query("DELETE FROM agent_connection_credentials WHERE connection_id = $1")
        .bind(row.id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO agent_connection_authorizations
            (connection_id, flow, secret_ciphertext, secret_nonce, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (connection_id) DO UPDATE SET
            flow = EXCLUDED.flow,
            secret_ciphertext = EXCLUDED.secret_ciphertext,
            secret_nonce = EXCLUDED.secret_nonce,
            expires_at = EXCLUDED.expires_at,
            created_at = NOW()",
    )
    .bind(row.id)
    .bind(flow)
    .bind(secret_ciphertext)
    .bind(secret_nonce)
    .bind(started.expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    Ok((
        StatusCode::CREATED,
        Json(connection_from_row(
            row,
            Some(prompt_from_started(started)),
        )?),
    ))
}

#[utoipa::path(
    post,
    path = "/agent-connections/deepseek",
    request_body = ConnectDeepseekRequest,
    responses(
        (status = 201, description = "DeepSeek API key validated and encrypted", body = AgentConnection),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse),
        (status = 422, description = "Invalid DeepSeek API key", body = crate::ErrorResponse),
        (status = 502, description = "DeepSeek validation unavailable", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn connect_deepseek(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<ConnectDeepseekRequest>,
) -> Result<(StatusCode, Json<AgentConnection>), ApiError> {
    connect_api_key(&state, &jar, AgentProvider::Deepseek, &payload.api_key).await
}

#[utoipa::path(post, path = "/agent-connections/groq", request_body = ConnectGroqRequest,
    responses((status = 201, body = AgentConnection), (status = 401, body = crate::ErrorResponse),
        (status = 422, body = crate::ErrorResponse), (status = 502, body = crate::ErrorResponse)),
    tag = "agent connections")]
pub async fn connect_groq(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<ConnectGroqRequest>,
) -> Result<(StatusCode, Json<AgentConnection>), ApiError> {
    connect_api_key(&state, &jar, AgentProvider::Groq, &payload.api_key).await
}

async fn connect_api_key(
    state: &AppState,
    jar: &CookieJar,
    provider: AgentProvider,
    value: &str,
) -> Result<(StatusCode, Json<AgentConnection>), ApiError> {
    let user_id = authenticated_user_id(state, jar).await?;
    let api_key = validate_api_key_input(value)?;
    validate_static_key(state, provider, api_key).await?;

    let last_four = api_key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    let token = serde_json::json!({
        "access_token": api_key,
        "api_key_last_four": last_four,
        "credential_kind": "api_key",
        "plan": "API",
    });
    let row = sqlx::query_as::<_, ConnectionRow>(
        "INSERT INTO agent_connections
            (id, user_id, provider, status, account_label, plan, failure_message)
         VALUES ($1, $2, $3, 'pending', NULL, NULL, NULL)
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(provider.as_str())
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    let connection = finish_connection(state, row, token).await?;

    Ok((StatusCode::CREATED, Json(connection)))
}

async fn start_connection_reauthorization(
    state: &AppState,
    row: ConnectionRow,
) -> Result<AgentConnection, ApiError> {
    let provider = AgentProvider::from_str(&row.provider)?;
    let started = start_provider_authorization(state, provider).await?;
    let (secret_ciphertext, secret_nonce) =
        encrypt_json(&state.config.credential_encryption_key, &started.secret)?;
    let flow = if started.requires_callback_url {
        "authorization_code"
    } else {
        "device_code"
    };
    let mut transaction = state.pool.begin().await.map_err(database_error)?;

    sqlx::query(
        "INSERT INTO agent_connection_authorizations
            (connection_id, flow, secret_ciphertext, secret_nonce, expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (connection_id) DO UPDATE SET
            flow = EXCLUDED.flow,
            secret_ciphertext = EXCLUDED.secret_ciphertext,
            secret_nonce = EXCLUDED.secret_nonce,
            expires_at = EXCLUDED.expires_at,
            created_at = NOW()",
    )
    .bind(row.id)
    .bind(flow)
    .bind(secret_ciphertext)
    .bind(secret_nonce)
    .bind(started.expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required',
             rate_limited_until = NULL,
             retry_claimed_at = NULL,
             failure_message = NULL,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(row.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    connection_from_row(updated, Some(prompt_from_started(started)))
}

#[utoipa::path(
    get,
    path = "/agent-connections",
    responses(
        (status = 200, description = "Current user's provider connections", body = [AgentConnection]),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn list_connections(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<AgentConnection>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at
         FROM agent_connections WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    let connections = rows
        .into_iter()
        .map(|row| connection_from_row(row, None))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(connections))
}

#[utoipa::path(
    get,
    path = "/agent-connections/{connection_id}",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 200, description = "Latest provider connection status", body = AgentConnection),
        (status = 404, description = "Connection not found", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn get_connection(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<AgentConnection>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let row = owned_connection(&state, user_id, connection_id).await?;
    let status = AgentConnectionStatus::from_str(&row.status)?;

    if status == AgentConnectionStatus::Pending
        || connection_has_authorization(&state, row.id).await?
    {
        return poll_pending_connection(&state, row).await.map(Json);
    }
    if status == AgentConnectionStatus::Connected {
        let connection =
            match refresh_detached(&state, row, CredentialRefreshMode::NearExpiry).await? {
                RefreshConnectionOutcome::Connected { connection, .. } => connection,
                RefreshConnectionOutcome::ReauthorizationRequired(row) => {
                    connection_from_row(row, None)?
                }
            };
        return Ok(Json(connection));
    }

    connection_from_row(row, None).map(Json)
}

#[utoipa::path(
    post,
    path = "/agent-connections/{connection_id}/refresh",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 200, description = "Credential refreshed or provider reauthorization started", body = AgentConnection),
        (status = 401, description = "Hub login required", body = crate::ErrorResponse),
        (status = 404, description = "Connection not found", body = crate::ErrorResponse),
        (status = 502, description = "Provider refresh unavailable", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn refresh_connection(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<AgentConnection>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let row = owned_connection(&state, user_id, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Validation(
            "Only a connected account pool can be refreshed.",
        ));
    }

    let connection = match refresh_detached(&state, row, CredentialRefreshMode::Force).await? {
        RefreshConnectionOutcome::Connected { connection, .. } => connection,
        RefreshConnectionOutcome::ReauthorizationRequired(row) => {
            start_connection_reauthorization(&state, row).await?
        }
    };

    Ok(Json(connection))
}

#[utoipa::path(
    post,
    path = "/agent-connections/{connection_id}/complete",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    request_body = CompleteAuthorizationRequest,
    responses(
        (status = 200, description = "Authorization completed", body = AgentConnection),
        (status = 422, description = "Invalid callback URL", body = crate::ErrorResponse),
        (status = 502, description = "Provider rejected the exchange", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn complete_authorization(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
    Json(payload): Json<CompleteAuthorizationRequest>,
) -> Result<Json<AgentConnection>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let row = owned_connection(&state, user_id, connection_id).await?;
    let authorization = load_authorization(&state, row.id).await?;
    let secret: AuthorizationSecret = decrypt_json(
        &state.config.credential_encryption_key,
        &authorization.secret_ciphertext,
        &authorization.secret_nonce,
    )?;
    let (code_verifier, redirect_uri, expected_state, provider) = match secret {
        AuthorizationSecret::Chatgpt {
            code_verifier,
            redirect_uri,
            state,
            ..
        } => (code_verifier, redirect_uri, state, AgentProvider::Chatgpt),
        AuthorizationSecret::Claude {
            code_verifier,
            redirect_uri,
            state,
            ..
        } => (code_verifier, redirect_uri, state, AgentProvider::Claude),
        AuthorizationSecret::Gemini {
            code_verifier,
            redirect_uri,
            state,
            ..
        } => (code_verifier, redirect_uri, state, AgentProvider::Gemini),
        _ => {
            return Err(ApiError::Validation(
                "This provider completes automatically; keep the dialog open while it polls.",
            ));
        }
    };
    let (code, callback_state) = parse_callback_value(&payload.callback_url)?;
    if callback_state
        .as_deref()
        .is_some_and(|state| state != expected_state)
    {
        return Err(ApiError::Validation(
            "The callback state does not match this connection attempt.",
        ));
    }

    let token = match provider {
        AgentProvider::Chatgpt => {
            exchange_codex_code(&state, &code, &code_verifier, &redirect_uri).await?
        }
        AgentProvider::Claude => {
            exchange_claude_code(
                &state,
                &code,
                &code_verifier,
                &redirect_uri,
                &expected_state,
            )
            .await?
        }
        AgentProvider::Gemini => {
            exchange_gemini_code(&state, &code, &code_verifier, &redirect_uri).await?
        }
        _ => unreachable!("only callback providers reach the exchange"),
    };
    finish_connection(&state, row, token).await.map(Json)
}

#[utoipa::path(
    delete,
    path = "/agent-connections/{connection_id}",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 204, description = "Connected account pool deleted"),
        (status = 404, description = "Connection not found", body = crate::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn disconnect(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    owned_connection(&state, user_id, connection_id).await?;
    // Take the credential lock first, as refreshes and reconnect marks do, so
    // a delete waits for an in-flight refresh instead of deadlocking with it.
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    sqlx::query("SELECT 1 FROM agent_connection_credentials WHERE connection_id = $1 FOR UPDATE")
        .bind(connection_id)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_connections WHERE id = $1 AND user_id = $2")
        .bind(connection_id)
        .bind(user_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    Ok(StatusCode::NO_CONTENT)
}

async fn start_provider_authorization(
    state: &AppState,
    provider: AgentProvider,
) -> Result<StartedAuthorization, ApiError> {
    match provider {
        AgentProvider::Chatgpt => start_codex_authorization(state),
        AgentProvider::Claude => start_claude_authorization(state),
        AgentProvider::Gemini => start_gemini_authorization(state),
        AgentProvider::Deepseek | AgentProvider::Groq => Err(ApiError::Validation(
            "Connect this provider with an API key instead of browser authorization.",
        )),
        AgentProvider::Grok => start_grok_authorization(state).await,
    }
}

fn validate_api_key_input(value: &str) -> Result<&str, ApiError> {
    let value = value.trim();
    if value.len() < 20
        || value.len() > 512
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(ApiError::Validation("Enter a valid API key."));
    }
    Ok(value)
}

async fn validate_static_key(
    state: &AppState,
    provider: AgentProvider,
    api_key: &str,
) -> Result<(), ApiError> {
    let base_url = match provider {
        AgentProvider::Deepseek => &state.config.deepseek_api_url,
        AgentProvider::Groq => &state.config.groq_api_url,
        _ => return Err(ApiError::Internal),
    };
    let response = state
        .http
        .get(format!("{}/models", base_url))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|error| upstream_network_error(provider, error))?;
    if matches!(
        response.status(),
        reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN
    ) {
        return Err(ApiError::Validation(match provider {
            AgentProvider::Groq => "Groq rejected this API key.",
            _ => "DeepSeek rejected this API key.",
        }));
    }
    if !response.status().is_success() {
        return Err(upstream_status_error(provider, response.status()));
    }
    Ok(())
}

fn start_codex_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let code_verifier = random_url_token(32);
    let state_token = random_url_token(32);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let mut url = Url::parse(&format!("{}/oauth/authorize", state.config.codex_issuer))
        .map_err(|_| ApiError::Internal)?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CODEX_CLIENT_ID)
        .append_pair("redirect_uri", CODEX_REDIRECT_URI)
        .append_pair("scope", CODEX_SCOPES)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state_token)
        .append_pair("id_token_add_organizations", "true")
        .append_pair("codex_cli_simplified_flow", "true")
        .append_pair("originator", "codex_cli_rs");
    let authorization_url = url.to_string();

    Ok(StartedAuthorization {
        expires_at: Utc::now() + Duration::minutes(15),
        poll_after_seconds: DEFAULT_POLL_SECONDS,
        prompt_url: authorization_url.clone(),
        requires_callback_url: true,
        user_code: None,
        secret: AuthorizationSecret::Chatgpt {
            authorization_url,
            code_verifier,
            redirect_uri: CODEX_REDIRECT_URI.to_owned(),
            state: state_token,
        },
    })
}

fn start_claude_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let code_verifier = random_url_token(32);
    let state_token = random_url_token(32);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let mut url = Url::parse(&state.config.claude_authorize_url).map_err(|_| ApiError::Internal)?;
    url.query_pairs_mut()
        .append_pair("code", "true")
        .append_pair("client_id", CLAUDE_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &state.config.claude_redirect_url)
        .append_pair("scope", CLAUDE_SCOPES)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state_token);
    let expires_at = Utc::now() + Duration::minutes(15);
    let authorization_url = url.to_string();

    Ok(StartedAuthorization {
        expires_at,
        poll_after_seconds: DEFAULT_POLL_SECONDS,
        prompt_url: authorization_url.clone(),
        requires_callback_url: true,
        user_code: None,
        secret: AuthorizationSecret::Claude {
            authorization_url,
            code_verifier,
            redirect_uri: state.config.claude_redirect_url.clone(),
            state: state_token,
        },
    })
}

fn start_gemini_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let code_verifier = random_url_token(32);
    let state_token = random_url_token(32);
    let code_challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(code_verifier.as_bytes()));
    let mut url = Url::parse(&state.config.gemini_authorize_url).map_err(|_| ApiError::Internal)?;
    url.query_pairs_mut()
        .append_pair("client_id", &state.config.gemini_client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", &state.config.gemini_redirect_url)
        .append_pair("scope", GEMINI_SCOPES)
        .append_pair("code_challenge", &code_challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", &state_token)
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent");
    let expires_at = Utc::now() + Duration::minutes(15);
    let authorization_url = url.to_string();

    Ok(StartedAuthorization {
        expires_at,
        poll_after_seconds: DEFAULT_POLL_SECONDS,
        prompt_url: authorization_url.clone(),
        requires_callback_url: true,
        user_code: None,
        secret: AuthorizationSecret::Gemini {
            authorization_url,
            code_verifier,
            redirect_uri: state.config.gemini_redirect_url.clone(),
            state: state_token,
        },
    })
}

async fn start_grok_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let response = grok_oauth_request(state, "/oauth2/device/code")
        .form(&[
            ("client_id", state.config.grok_client_id.as_str()),
            ("scope", GROK_SCOPES),
        ])
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Grok, error))?;
    let status = response.status();
    if !status.is_success() {
        eprintln!("Grok device authorization returned HTTP {status}");
        return Err(upstream_status_error(AgentProvider::Grok, status));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("missing")
        .to_owned();
    let payload = response.json::<GrokDeviceResponse>().await.map_err(|_| {
        eprintln!(
            "Grok device authorization returned HTTP {status} with content type {content_type}"
        );
        upstream_payload_error(AgentProvider::Grok)
    })?;
    validate_prompt_url(
        &state.config.grok_issuer,
        &payload.verification_uri_complete,
    )?;
    let expires_at =
        Utc::now() + Duration::seconds(payload.expires_in.unwrap_or(DEFAULT_DEVICE_EXPIRY_SECONDS));

    Ok(StartedAuthorization {
        expires_at,
        poll_after_seconds: payload.interval.unwrap_or(DEFAULT_POLL_SECONDS),
        prompt_url: payload.verification_uri_complete.clone(),
        requires_callback_url: false,
        user_code: Some(payload.user_code.clone()),
        secret: AuthorizationSecret::Grok {
            device_code: payload.device_code,
            user_code: payload.user_code,
            verification_uri_complete: payload.verification_uri_complete,
        },
    })
}

async fn poll_pending_connection(
    state: &AppState,
    row: ConnectionRow,
) -> Result<AgentConnection, ApiError> {
    let authorization = load_authorization(state, row.id).await?;
    if authorization.expires_at <= Utc::now() {
        return fail_connection(state, row, EXPIRED_AUTHORIZATION_PROMPT_MESSAGE).await;
    }
    let secret: AuthorizationSecret = decrypt_json(
        &state.config.credential_encryption_key,
        &authorization.secret_ciphertext,
        &authorization.secret_nonce,
    )?;

    match secret {
        AuthorizationSecret::Chatgpt {
            authorization_url,
            code_verifier: _,
            redirect_uri: _,
            state: _,
        } => connection_from_row(
            row,
            Some(AgentAuthorizationPrompt {
                authorization_url,
                expires_at: authorization.expires_at,
                poll_after_seconds: DEFAULT_POLL_SECONDS,
                requires_callback_url: true,
                user_code: None,
            }),
        ),
        AuthorizationSecret::Grok {
            device_code,
            user_code,
            verification_uri_complete,
        } => {
            let response = grok_oauth_request(state, "/oauth2/token")
                .form(&[
                    ("client_id", state.config.grok_client_id.as_str()),
                    ("device_code", device_code.as_str()),
                    ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
                ])
                .send()
                .await
                .map_err(|error| upstream_network_error(AgentProvider::Grok, error))?;
            let status = response.status();
            let payload = response
                .json::<Value>()
                .await
                .map_err(|_| upstream_payload_error(AgentProvider::Grok))?;
            if status.is_success() && payload.get("access_token").is_some() {
                return finish_connection(state, row, payload).await;
            }
            match payload.get("error").and_then(Value::as_str) {
                Some("authorization_pending") | Some("slow_down") => connection_from_row(
                    row,
                    Some(AgentAuthorizationPrompt {
                        authorization_url: verification_uri_complete,
                        expires_at: authorization.expires_at,
                        poll_after_seconds: DEFAULT_POLL_SECONDS,
                        requires_callback_url: false,
                        user_code: Some(user_code),
                    }),
                ),
                Some("expired_token") | Some("access_denied") => {
                    fail_connection(state, row, "Authorization was not completed. Start again.")
                        .await
                }
                _ => Err(upstream_status_error(AgentProvider::Grok, status)),
            }
        }
        AuthorizationSecret::Claude {
            authorization_url,
            code_verifier: _,
            redirect_uri: _,
            state: _,
        } => connection_from_row(
            row,
            Some(AgentAuthorizationPrompt {
                authorization_url,
                expires_at: authorization.expires_at,
                poll_after_seconds: DEFAULT_POLL_SECONDS,
                requires_callback_url: true,
                user_code: None,
            }),
        ),
        AuthorizationSecret::Gemini {
            authorization_url,
            code_verifier: _,
            redirect_uri: _,
            state: _,
        } => connection_from_row(
            row,
            Some(AgentAuthorizationPrompt {
                authorization_url,
                expires_at: authorization.expires_at,
                poll_after_seconds: DEFAULT_POLL_SECONDS,
                requires_callback_url: true,
                user_code: None,
            }),
        ),
    }
}

async fn exchange_codex_code(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<Value, ApiError> {
    let response = state
        .http
        .post(format!("{}/oauth/token", state.config.codex_issuer))
        .header(
            "user-agent",
            format!("codex_cli_rs/{}", state.config.codex_client_version),
        )
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", code),
            ("code_verifier", code_verifier),
            ("redirect_uri", redirect_uri),
        ])
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Chatgpt, error))?;
    parse_token_response(AgentProvider::Chatgpt, response).await
}

async fn exchange_claude_code(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
    oauth_state: &str,
) -> Result<Value, ApiError> {
    let response = state
        .http
        .post(&state.config.claude_token_url)
        .json(&serde_json::json!({
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": CLAUDE_CLIENT_ID,
            "code_verifier": code_verifier,
            "state": oauth_state,
        }))
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Claude, error))?;
    parse_token_response(AgentProvider::Claude, response).await
}

async fn exchange_gemini_code(
    state: &AppState,
    code: &str,
    code_verifier: &str,
    redirect_uri: &str,
) -> Result<Value, ApiError> {
    let response = state
        .http
        .post(&state.config.gemini_token_url)
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code),
            ("redirect_uri", redirect_uri),
            ("client_id", state.config.gemini_client_id.as_str()),
            ("client_secret", state.config.gemini_client_secret.as_str()),
            ("code_verifier", code_verifier),
        ])
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Gemini, error))?;
    let token = parse_token_response(AgentProvider::Gemini, response).await?;
    enrich_gemini_token(state, token).await
}

async fn enrich_gemini_token(state: &AppState, mut token: Value) -> Result<Value, ApiError> {
    let access_token = token
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or_else(|| upstream_payload_error(AgentProvider::Gemini))?
        .to_owned();
    let userinfo = state
        .http
        .get(&state.config.gemini_userinfo_url)
        .bearer_auth(&access_token)
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Gemini, error))?;
    let userinfo = parse_json_response(AgentProvider::Gemini, userinfo).await?;
    let code_assist = load_gemini_code_assist(state, &access_token, None).await?;
    let project = code_assist
        .get("cloudaicompanionProject")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| upstream_payload_error(AgentProvider::Gemini))?;
    let object = token
        .as_object_mut()
        .ok_or_else(|| upstream_payload_error(AgentProvider::Gemini))?;
    object.insert(
        "cloudaicompanion_project".to_owned(),
        Value::String(project.to_owned()),
    );
    if let Some(email) = userinfo.get("email").and_then(Value::as_str) {
        object.insert("email".to_owned(), Value::String(email.to_owned()));
    }
    if let Some(plan) = code_assist
        .pointer("/currentTier/name")
        .or_else(|| code_assist.pointer("/currentTier/id"))
        .or_else(|| code_assist.pointer("/paidTier/name"))
        .and_then(Value::as_str)
    {
        object.insert("plan".to_owned(), Value::String(plan.to_owned()));
    }
    Ok(token)
}

pub(crate) async fn load_gemini_code_assist(
    state: &AppState,
    access_token: &str,
    project: Option<&str>,
) -> Result<Value, ApiError> {
    let body = gemini_code_assist_body(project);
    let code_assist = state
        .http
        .post(format!(
            "{}/v1internal:loadCodeAssist",
            state.config.gemini_code_assist_url.trim_end_matches('/')
        ))
        .bearer_auth(access_token)
        .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Gemini, error))?;
    parse_json_response(AgentProvider::Gemini, code_assist).await
}

fn gemini_code_assist_body(project: Option<&str>) -> Value {
    let mut body = serde_json::json!({
        "metadata": { "ideType": "ANTIGRAVITY" }
    });
    if let Some(project) = project.filter(|project| !project.is_empty()) {
        body["cloudaicompanionProject"] = Value::String(project.to_owned());
    }
    body
}

async fn parse_json_response(
    provider: AgentProvider,
    response: reqwest::Response,
) -> Result<Value, ApiError> {
    let status = response.status();
    if !status.is_success() {
        return Err(upstream_status_error(provider, status));
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| upstream_payload_error(provider))
}

async fn parse_token_response(
    provider: AgentProvider,
    response: reqwest::Response,
) -> Result<Value, ApiError> {
    let status = response.status();
    if !status.is_success() {
        eprintln!("{} token exchange returned HTTP {status}", provider.label());
        return Err(upstream_status_error(provider, status));
    }
    let payload = response
        .json::<Value>()
        .await
        .map_err(|_| upstream_payload_error(provider))?;
    if payload
        .get("access_token")
        .and_then(Value::as_str)
        .is_none()
    {
        return Err(upstream_payload_error(provider));
    }
    Ok(payload)
}

async fn finish_connection(
    state: &AppState,
    row: ConnectionRow,
    mut token: Value,
) -> Result<AgentConnection, ApiError> {
    let provider = AgentProvider::from_str(&row.provider)?;
    let profile = if provider == AgentProvider::Claude {
        fetch_claude_profile(state, &token).await
    } else {
        None
    };
    let (account_label, plan) = connection_metadata(provider, &token, profile.as_ref());
    let account_identity = provider_account_identity(provider, &token, profile.as_ref());
    let Some(account_identity) = account_identity else {
        return Err(ApiError::Validation(
            "The provider did not return a stable account identity.",
        ));
    };
    ensure_reauthorization_matches(state, &row, provider, Some(account_identity.as_str())).await?;
    if let Some(token) = token.as_object_mut() {
        token.insert(
            "hub_account_identity".to_owned(),
            Value::String(account_identity.clone()),
        );
    }
    let pending_owner_id = connection_owner_id(state, row.id).await?;
    let (credential_ciphertext, credential_nonce) =
        encrypt_json(&state.config.credential_encryption_key, &token)?;
    let access_token_expires_at = token
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds));
    let refresh_token_expires_at = token
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds));
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let identity_lock = i64::from_be_bytes(
        Sha256::digest(account_identity.as_bytes())[..8]
            .try_into()
            .map_err(|_| ApiError::Internal)?,
    );
    sqlx::query("SELECT pg_advisory_xact_lock($1)")
        .bind(identity_lock)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    let duplicate_id = find_duplicate_connection(
        state,
        &mut transaction,
        provider,
        row.id,
        account_identity.as_str(),
    )
    .await?;
    let target_id = duplicate_id.unwrap_or(row.id);

    sqlx::query(
        "INSERT INTO agent_connection_credentials
            (connection_id, credential_ciphertext, credential_nonce, access_token_expires_at,
             refresh_token_expires_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (connection_id) DO UPDATE SET
            credential_ciphertext = EXCLUDED.credential_ciphertext,
            credential_nonce = EXCLUDED.credential_nonce,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            updated_at = NOW()",
    )
    .bind(target_id)
    .bind(credential_ciphertext)
    .bind(credential_nonce)
    .bind(access_token_expires_at)
    .bind(refresh_token_expires_at)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_connection_authorizations WHERE connection_id = $1")
        .bind(row.id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    if target_id != row.id {
        sqlx::query(
            "DELETE FROM agent_pool_join_requests
             WHERE connection_id = $1 AND requester_user_id = $2",
        )
        .bind(target_id)
        .bind(pending_owner_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections SET status = 'connected', account_label = $2, plan = $3,
          failure_message = NULL, availability_status = 'active', rate_limited_until = NULL,
          retry_claimed_at = NULL, user_id = $4, updated_at = NOW() WHERE id = $1
          RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(target_id)
    .bind(account_label)
    .bind(plan)
    .bind(pending_owner_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    if target_id != row.id {
        sqlx::query("DELETE FROM agent_connections WHERE id = $1")
            .bind(row.id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
    }
    transaction.commit().await.map_err(database_error)?;

    connection_from_row(updated, None)
}

async fn connection_owner_id(state: &AppState, connection_id: Uuid) -> Result<Uuid, ApiError> {
    sqlx::query_scalar::<_, Uuid>("SELECT user_id FROM agent_connections WHERE id = $1")
        .bind(connection_id)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)
}

async fn find_duplicate_connection(
    state: &AppState,
    transaction: &mut Transaction<'_, Postgres>,
    provider: AgentProvider,
    excluded_id: Uuid,
    identity: &str,
) -> Result<Option<Uuid>, ApiError> {
    let rows = sqlx::query_as::<_, (Uuid, Vec<u8>, Vec<u8>)>(
        "SELECT connections.id, credentials.credential_ciphertext,
                credentials.credential_nonce
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.provider = $1
           AND connections.status = 'connected'
           AND connections.id <> $2",
    )
    .bind(provider.to_string())
    .bind(excluded_id)
    .fetch_all(&mut **transaction)
    .await
    .map_err(database_error)?;
    for (connection_id, ciphertext, nonce) in rows {
        let token: Value =
            decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce)?;
        if provider_account_identity(provider, &token, None).as_deref() == Some(identity) {
            return Ok(Some(connection_id));
        }
    }
    Ok(None)
}

async fn ensure_reauthorization_matches(
    state: &AppState,
    row: &ConnectionRow,
    provider: AgentProvider,
    new_identity: Option<&str>,
) -> Result<(), ApiError> {
    let credential = sqlx::query_as::<_, (Vec<u8>, Vec<u8>)>(
        "SELECT credential_ciphertext, credential_nonce
         FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(row.id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?;
    let Some((ciphertext, nonce)) = credential else {
        return Ok(());
    };
    let stored_token: Value =
        decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce)?;
    let stored_identity = provider_account_identity(provider, &stored_token, None);

    if !reauthorization_identity_matches(stored_identity.as_deref(), new_identity) {
        return Err(ApiError::Validation(
            "Reconnect with the same provider account that owns this pool.",
        ));
    }
    Ok(())
}

fn reauthorization_identity_matches(stored: Option<&str>, new: Option<&str>) -> bool {
    matches!((stored, new), (Some(stored), Some(new)) if stored == new)
}

fn provider_account_identity(
    provider: AgentProvider,
    token: &Value,
    provider_profile: Option<&Value>,
) -> Option<String> {
    // ChatGPT account IDs identify a workspace/subscription context, which can
    // be shared by distinct logins. Recompute personal identity before reading
    // legacy cached `id:<workspace>` values so reconnect cannot merge users.
    if provider == AgentProvider::Chatgpt {
        let claims = token_claims(token);
        if let Some(subject) = claims
            .as_ref()
            .and_then(|claims| claims.get("sub"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            return Some(format!("chatgpt:sub:{subject}"));
        }
        return token
            .pointer("/account/email_address")
            .or_else(|| token.pointer("/account/email"))
            .or_else(|| token.get("email"))
            .and_then(Value::as_str)
            .or_else(|| claims.as_ref()?.get("email")?.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|email| format!("chatgpt:email:{}", email.to_ascii_lowercase()));
    }
    if let Some(identity) = token
        .get("hub_account_identity")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Some(identity.to_owned());
    }
    let claims = token_claims(token);
    let provider_id = token
        .pointer("/account/id")
        .and_then(Value::as_str)
        .or_else(|| token.pointer("/account/uuid").and_then(Value::as_str))
        .or_else(|| {
            let profile = provider_profile?;
            profile
                .pointer("/account/id")
                .or_else(|| profile.pointer("/account/uuid"))
                .or_else(|| profile.pointer("/user/id"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("sub"))
                .and_then(Value::as_str)
        })
        .filter(|value| !value.is_empty());
    if let Some(provider_id) = provider_id {
        return Some(format!("id:{provider_id}"));
    }

    if matches!(provider, AgentProvider::Deepseek | AgentProvider::Groq) {
        let access_token = token.get("access_token").and_then(Value::as_str)?;
        let digest = Sha256::digest(access_token.as_bytes());
        return Some(format!("key:{digest:x}"));
    }

    token
        .pointer("/account/email_address")
        .or_else(|| token.pointer("/account/email"))
        .or_else(|| token.get("email"))
        .and_then(Value::as_str)
        .or_else(|| {
            let profile = provider_profile?;
            profile
                .pointer("/account/email_address")
                .or_else(|| profile.pointer("/account/email"))
                .or_else(|| profile.pointer("/user/email"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            claims
                .as_ref()
                .and_then(|value| value.get("email"))
                .and_then(Value::as_str)
        })
        .map(|email| format!("email:{}", email.trim().to_ascii_lowercase()))
}

fn connection_metadata(
    provider: AgentProvider,
    token: &Value,
    provider_profile: Option<&Value>,
) -> (Option<String>, Option<String>) {
    let claims = token_claims(token);
    let account_label = token
        .get("api_key_last_four")
        .and_then(Value::as_str)
        .filter(|value| value.len() == 4 && value.is_ascii())
        .map(|value| format!("••••{value}"))
        .or_else(|| {
            token
                .pointer("/account/email_address")
                .or_else(|| token.pointer("/account/email"))
                .or_else(|| token.get("email"))
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| {
                    claims
                        .as_ref()
                        .and_then(|value| value.get("email"))
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                })
                .as_deref()
                .map(mask_account_label)
        });
    let token_plan = || {
        token
            .get("subscription_type")
            .or_else(|| token.get("rate_limit_tier"))
            .or_else(|| token.get("plan"))
            .and_then(Value::as_str)
    };
    let plan = match provider {
        AgentProvider::Chatgpt => token_plan()
            .or_else(|| {
                claims.as_ref().and_then(|value| {
                    value
                        .get("https://api.openai.com/auth.chatgpt_plan_type")
                        .or_else(|| {
                            value
                                .get("https://api.openai.com/auth")
                                .and_then(|auth| auth.get("chatgpt_plan_type"))
                        })
                        .or_else(|| value.get("plan"))
                        .and_then(Value::as_str)
                })
            })
            .map(normalize_plan_label),
        AgentProvider::Claude => provider_profile
            .and_then(claude_plan_from_profile)
            .or_else(|| token_plan().map(normalize_plan_label)),
        AgentProvider::Gemini | AgentProvider::Deepseek | AgentProvider::Groq => {
            token_plan().map(normalize_plan_label)
        }
        AgentProvider::Grok => token_plan().and_then(grok_plan_label).or_else(|| {
            token_claim(token, "tier")
                .as_ref()
                .and_then(grok_tier_label)
        }),
    };

    (account_label, plan)
}

async fn resolved_connection_metadata(
    state: &AppState,
    provider: AgentProvider,
    token: &Value,
) -> (Option<String>, Option<String>) {
    let profile = if provider == AgentProvider::Claude {
        fetch_claude_profile(state, token).await
    } else {
        None
    };
    connection_metadata(provider, token, profile.as_ref())
}

async fn fetch_claude_profile(state: &AppState, token: &Value) -> Option<Value> {
    let access_token = token.get("access_token").and_then(Value::as_str)?;
    let response = match state
        .http
        .get(&state.config.claude_profile_url)
        .bearer_auth(access_token)
        .header("accept", "application/json")
        .header("cache-control", "no-cache")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            eprintln!("Claude profile request failed: {error}");
            return None;
        }
    };
    let status = response.status();
    if !status.is_success() {
        eprintln!("Claude profile returned HTTP {status}");
        return None;
    }
    match response.json::<Value>().await {
        Ok(profile) => Some(profile),
        Err(_) => {
            eprintln!("Claude profile returned an unexpected response");
            None
        }
    }
}

fn claude_plan_from_profile(profile: &Value) -> Option<String> {
    match profile
        .pointer("/organization/organization_type")
        .and_then(Value::as_str)?
    {
        "claude_max" => Some("MAX".to_owned()),
        "claude_pro" => Some("Pro".to_owned()),
        "claude_team" => Some("Team".to_owned()),
        "claude_enterprise" => Some("Enterprise".to_owned()),
        _ => None,
    }
}

fn grok_plan_label(value: &str) -> Option<String> {
    match value.trim().to_ascii_lowercase().replace(' ', "_").as_str() {
        "grokpro" | "supergrok" => Some("Grok".to_owned()),
        "supergrokpro" | "supergrok_heavy" => Some("Heavy".to_owned()),
        "supergroklite" | "supergrok_lite" => Some("Lite".to_owned()),
        "supergrokplus" | "supergrok_plus" => Some("Plus".to_owned()),
        "xbasic" | "x_basic" => Some("X Basic".to_owned()),
        "xpremium" | "x_premium" => Some("X Premium".to_owned()),
        "xpremiumplus" | "x_premium_plus" => Some("X Premium+".to_owned()),
        "free" => Some("Free".to_owned()),
        _ => None,
    }
}

fn grok_tier_label(value: &Value) -> Option<String> {
    if let Some(value) = value.as_str() {
        return grok_plan_label(value);
    }
    match value.as_u64()? {
        0 => Some("Free".to_owned()),
        1 => Some("Grok".to_owned()),
        2 => Some("X Basic".to_owned()),
        3 => Some("X Premium".to_owned()),
        4 => Some("X Premium+".to_owned()),
        5 => Some("Heavy".to_owned()),
        6 => Some("Lite".to_owned()),
        7 => Some("Plus".to_owned()),
        _ => None,
    }
}

pub async fn refresh_stored_connection_metadata(state: &AppState) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionMetadataCredentialRow>(
        "SELECT connections.id AS connection_id, credentials.credential_ciphertext,
                credentials.credential_nonce, connections.plan, connections.provider
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut updated = 0;
    for row in rows {
        let Ok(token) = decrypt_json::<Value>(
            &state.config.credential_encryption_key,
            &row.credential_ciphertext,
            &row.credential_nonce,
        ) else {
            continue;
        };
        let Ok(provider) = AgentProvider::from_str(&row.provider) else {
            continue;
        };
        let (account_label, detected_plan) =
            if provider == AgentProvider::Claude && row.plan.is_some() {
                connection_metadata(provider, &token, None)
            } else {
                resolved_connection_metadata(state, provider, &token).await
            };
        let plan = detected_plan.or(row.plan);
        updated += sqlx::query(
            "UPDATE agent_connections SET account_label = COALESCE($2, account_label),
                 plan = COALESCE($3, plan), updated_at = NOW()
             WHERE id = $1
               AND (account_label IS DISTINCT FROM COALESCE($2, account_label)
                    OR plan IS DISTINCT FROM COALESCE($3, plan))",
        )
        .bind(row.connection_id)
        .bind(account_label)
        .bind(plan)
        .execute(&state.pool)
        .await?
        .rows_affected();
    }

    Ok(updated)
}

/// Every minute: rotate OAuth credentials that have gone their 30-45 minute
/// interval without a refresh, whether or not anyone is using them, and retry
/// accounts the gateway marked for reconnect so a recovered provider session
/// returns to service without its owner. Static API keys are validated by the
/// nightly check instead; they are only retried here after a gateway rejection.
pub async fn refresh_due_provider_credentials(
    state: &AppState,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let recoverable_messages: Vec<String> = RECOVERABLE_REAUTHORIZATION_MESSAGES
        .iter()
        .map(|message| (*message).to_owned())
        .collect();
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT connections.id, connections.provider, connections.status, connections.availability_status,
                connections.account_label, connections.plan, connections.failure_message,
                connections.created_at, connections.updated_at
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'
           AND (
                 (connections.provider NOT IN ('deepseek', 'groq')
                  AND connections.availability_status <> 'reauth_required')
                 OR (connections.availability_status = 'reauth_required'
                     AND connections.failure_message = ANY($1)
                     AND NOT EXISTS (
                           SELECT 1 FROM agent_connection_authorizations AS authorizations
                           WHERE authorizations.connection_id = connections.id
                         ))
               )
           AND GREATEST(
                 credentials.updated_at,
                 COALESCE(credentials.refresh_attempted_at, credentials.updated_at)
               ) <= NOW() - (
                 INTERVAL '30 minutes'
                 + make_interval(secs => get_byte(uuid_send(connections.id), 15) * 900 / 256)
               )
         ORDER BY GREATEST(
                    credentials.updated_at,
                    COALESCE(credentials.refresh_attempted_at, credentials.updated_at)
                  ) ASC",
    )
    .bind(recoverable_messages)
    .fetch_all(&state.pool)
    .await?;

    let rows = rows
        .into_iter()
        .map(|row| {
            let interval = scheduled_refresh_after(row.id);
            let mode = if row.availability_status == "reauth_required" {
                CredentialRefreshMode::Recover(interval)
            } else {
                CredentialRefreshMode::Stale(interval)
            };
            (row, mode)
        })
        .collect();
    refresh_scheduled_provider_credentials(state, rows).await
}

/// Once per Vietnam calendar day, rotate connected OAuth credentials that have
/// not already refreshed today and validate static DeepSeek keys. The row-lock
/// recheck keeps this idempotent across API replicas and restarts.
pub async fn refresh_nightly_provider_credentials(
    state: &AppState,
    day_start_utc: DateTime<Utc>,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT connections.id, connections.provider, connections.status, connections.availability_status,
                connections.account_label, connections.plan, connections.failure_message,
                connections.created_at, connections.updated_at
         FROM agent_connections AS connections
         JOIN agent_connection_credentials AS credentials
           ON credentials.connection_id = connections.id
         WHERE connections.status = 'connected'
           AND connections.availability_status <> 'reauth_required'
           AND GREATEST(
                 credentials.updated_at,
                 COALESCE(credentials.refresh_attempted_at, credentials.updated_at)
               ) < $1
         ORDER BY connections.provider, connections.created_at",
    )
    .bind(day_start_utc)
    .fetch_all(&state.pool)
    .await?;

    let rows = rows
        .into_iter()
        .map(|row| (row, CredentialRefreshMode::Nightly(day_start_utc)))
        .collect();
    refresh_scheduled_provider_credentials(state, rows).await
}

async fn refresh_scheduled_provider_credentials(
    state: &AppState,
    rows: Vec<(ConnectionRow, CredentialRefreshMode)>,
) -> Result<ProviderCredentialRefreshSummary, sqlx::Error> {
    let mut summary = ProviderCredentialRefreshSummary::default();
    for (row, mode) in rows {
        if SWEEPS_STOPPING.load(Ordering::SeqCst) {
            break;
        }
        let connection_id = row.id;
        let provider = row.provider.clone();
        match refresh_detached(state, row, mode).await {
            Ok(RefreshConnectionOutcome::Connected {
                refreshed: true,
                connection,
            }) => {
                summary.refreshed += 1;
                if matches!(mode, CredentialRefreshMode::Recover(_))
                    && connection.availability_status != "reauth_required"
                {
                    summary.recovered += 1;
                    println!(
                        "{provider} connection {connection_id} recovered after a reconnect-required mark"
                    );
                }
            }
            Ok(RefreshConnectionOutcome::Connected {
                refreshed: false, ..
            }) => {}
            Ok(RefreshConnectionOutcome::ReauthorizationRequired(_)) => {
                summary.reauthorization_required += 1;
            }
            Err(error) => {
                summary.failed += 1;
                record_scheduled_refresh_attempt(state, connection_id).await;
                eprintln!(
                    "scheduled {provider} credential refresh failed for {connection_id}: {error:?}"
                );
            }
        }
    }

    Ok(summary)
}

/// Explicit operator maintenance: refresh every connected pool using its stored
/// credentials, including validating static DeepSeek keys. Does not start an
/// interactive authorization flow or stop after one provider fails.
pub async fn refresh_all_provider_credentials(
    state: &AppState,
) -> Result<Vec<ProviderCredentialRefreshResult>, sqlx::Error> {
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at
         FROM agent_connections WHERE status = 'connected' ORDER BY provider, created_at",
    )
    .fetch_all(&state.pool)
    .await?;

    let mut results = Vec::with_capacity(rows.len());
    for row in rows {
        let connection_id = row.id;
        let provider = row.provider.clone();
        let status = match refresh_detached(state, row, CredentialRefreshMode::Force).await {
            Ok(RefreshConnectionOutcome::Connected { .. }) => {
                ProviderCredentialRefreshStatus::Refreshed
            }
            Ok(RefreshConnectionOutcome::ReauthorizationRequired(_)) => {
                ProviderCredentialRefreshStatus::ReauthorizationRequired
            }
            Err(_) => ProviderCredentialRefreshStatus::Failed,
        };
        record_scheduled_refresh_attempt(state, connection_id).await;
        results.push(ProviderCredentialRefreshResult {
            connection_id,
            provider,
            status,
        });
    }
    Ok(results)
}

async fn record_scheduled_refresh_attempt(state: &AppState, connection_id: Uuid) {
    if let Err(error) = sqlx::query(
        "UPDATE agent_connection_credentials SET refresh_attempted_at = NOW()
         WHERE connection_id = $1",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    {
        eprintln!(
            "scheduled credential refresh attempt could not be recorded for {connection_id}: {error}"
        );
    }
}

fn normalize_plan_label(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "k12" => "K12".to_owned(),
        "max" => "Max".to_owned(),
        "plus" => "Plus".to_owned(),
        _ => value.trim().to_owned(),
    }
}

async fn finish_refresh_reauthorization(
    mut transaction: Transaction<'_, Postgres>,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    // Keep the credential lock until the failure state is committed. A fresh
    // login that writes this credential must then finish after this update.
    // Do not delete a concurrent manual reauthorization prompt.
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required',
             failure_message = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'connected'
           AND availability_status <> 'reauth_required'
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(row.id)
    .bind(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let updated = match updated {
        Some(updated) => {
            eprintln!(
                "{} connection {} requires reauthorization: the provider rejected its stored refresh credential during {}",
                row.provider,
                row.id,
                mode.label()
            );
            updated
        }
        None => {
            if matches!(mode, CredentialRefreshMode::Recover(_)) {
                // The refresh credential itself is dead, so stop retrying this
                // account until its owner reconnects it.
                sqlx::query(
                    "UPDATE agent_connections SET failure_message = $2, updated_at = NOW()
                     WHERE id = $1 AND availability_status = 'reauth_required'
                       AND failure_message = ANY($3)",
                )
                .bind(row.id)
                .bind(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE)
                .bind(
                    RECOVERABLE_REAUTHORIZATION_MESSAGES
                        .iter()
                        .map(|message| (*message).to_owned())
                        .collect::<Vec<_>>(),
                )
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
            }
            sqlx::query_as::<_, ConnectionRow>(
                "SELECT id, provider, status, availability_status, account_label, plan, failure_message,
                        created_at, updated_at
                 FROM agent_connections WHERE id = $1",
            )
            .bind(row.id)
            .fetch_one(&mut *transaction)
            .await
            .map_err(database_error)?
        }
    };
    transaction.commit().await.map_err(database_error)?;
    Ok(RefreshConnectionOutcome::ReauthorizationRequired(updated))
}

async fn finish_refresh_error(
    transaction: Transaction<'_, Postgres>,
    mode: CredentialRefreshMode,
    error: ApiError,
) -> Result<RefreshConnectionOutcome, ApiError> {
    if mode.records_scheduled_attempt() {
        transaction.commit().await.map_err(database_error)?;
    } else {
        transaction.rollback().await.map_err(database_error)?;
    }
    Err(error)
}

async fn refresh_connected_connection(
    state: &AppState,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at, refresh_attempted_at, updated_at
         FROM agent_connection_credentials
         WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(row.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some(credential) = credential else {
        let current = sqlx::query_as::<_, ConnectionRow>(
            "SELECT id, provider, status, availability_status, account_label, plan, failure_message,
                    created_at, updated_at
             FROM agent_connections WHERE id = $1 FOR UPDATE",
        )
        .bind(row.id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        let credential_now_exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(SELECT 1 FROM agent_connection_credentials WHERE connection_id = $1)",
        )
        .bind(row.id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(database_error)?;
        if credential_now_exists {
            transaction.commit().await.map_err(database_error)?;
            return connection_from_row(current, None).map(|connection| {
                RefreshConnectionOutcome::Connected {
                    connection,
                    refreshed: false,
                }
            });
        }
        return finish_refresh_reauthorization(transaction, current, mode).await;
    };

    let last_refresh_activity_at = credential
        .refresh_attempted_at
        .map_or(credential.updated_at, |attempted_at| {
            attempted_at.max(credential.updated_at)
        });
    let should_refresh = if let CredentialRefreshMode::Rejected(observed) = mode {
        match decrypt_json::<Value>(
            &state.config.credential_encryption_key,
            &credential.credential_ciphertext,
            &credential.credential_nonce,
        ) {
            Ok(stored) => {
                stored
                    .get("access_token")
                    .and_then(Value::as_str)
                    .map(access_token_fingerprint)
                    == Some(observed)
            }
            Err(error) => return finish_refresh_error(transaction, mode, error).await,
        }
    } else {
        should_refresh_credential(
            mode,
            credential.access_token_expires_at,
            last_refresh_activity_at,
            Utc::now(),
        )
    };
    if !should_refresh {
        transaction.commit().await.map_err(database_error)?;
        return connection_from_row(row, None).map(|connection| {
            RefreshConnectionOutcome::Connected {
                connection,
                refreshed: false,
            }
        });
    }
    if mode.records_scheduled_attempt() {
        sqlx::query(
            "UPDATE agent_connection_credentials SET refresh_attempted_at = NOW()
             WHERE connection_id = $1",
        )
        .bind(row.id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    }
    if credential
        .refresh_token_expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now())
    {
        return finish_refresh_reauthorization(transaction, row, mode).await;
    }

    let stored_token: Value = match decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    ) {
        Ok(stored_token) => stored_token,
        Err(error) => {
            return finish_refresh_error(transaction, mode, error).await;
        }
    };
    let provider = AgentProvider::from_str(&row.provider)?;
    if matches!(provider, AgentProvider::Deepseek | AgentProvider::Groq) {
        let Some(api_key) = stored_token.get("access_token").and_then(Value::as_str) else {
            return finish_refresh_reauthorization(transaction, row, mode).await;
        };
        match validate_static_key(state, provider, api_key).await {
            Ok(()) => {}
            Err(ApiError::Validation(_)) => {
                return finish_refresh_reauthorization(transaction, row, mode).await;
            }
            Err(error) => return finish_refresh_error(transaction, mode, error).await,
        }
        if mode.restores_availability() {
            restore_refreshed_availability(&mut transaction, row.id, mode).await?;
        }
        transaction.commit().await.map_err(database_error)?;
        let updated = owned_connection_by_id(state, row.id).await?;
        return connection_from_row(updated, None).map(|connection| {
            RefreshConnectionOutcome::Connected {
                connection,
                refreshed: true,
            }
        });
    }
    let Some(refresh_token) = stored_token.get("refresh_token").and_then(Value::as_str) else {
        return finish_refresh_reauthorization(transaction, row, mode).await;
    };
    let refreshed =
        match refresh_provider_token(state, provider, refresh_token, &stored_token).await {
            Ok(refreshed) => refreshed,
            Err(ProviderRefreshError::ReauthorizationRequired) => {
                return finish_refresh_reauthorization(transaction, row, mode).await;
            }
            Err(ProviderRefreshError::Api(error)) => {
                return finish_refresh_error(transaction, mode, error).await;
            }
        };
    let access_token_expires_at = refreshed
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds));
    let refresh_token_expires_at = refreshed
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds))
        .or(credential.refresh_token_expires_at);
    let merged = merge_token_response(stored_token, refreshed);
    let (credential_ciphertext, credential_nonce) =
        match encrypt_json(&state.config.credential_encryption_key, &merged) {
            Ok(encrypted) => encrypted,
            Err(error) => return finish_refresh_error(transaction, mode, error).await,
        };
    let (account_label, plan) = resolved_connection_metadata(state, provider, &merged).await;
    let verification_probe = if provider == AgentProvider::Gemini && mode.restores_availability() {
        match (
            merged.get("access_token").and_then(Value::as_str),
            merged
                .get("cloudaicompanion_project")
                .and_then(Value::as_str),
        ) {
            (Some(access_token), Some(project)) => {
                crate::gateway::probe_gemini_account_verification(state, access_token, project)
                    .await
            }
            _ => crate::gateway::GeminiVerificationProbe::Inconclusive,
        }
    } else {
        crate::gateway::GeminiVerificationProbe::Verified
    };

    let verification_required =
        verification_probe == crate::gateway::GeminiVerificationProbe::ReauthorizationRequired;
    let restores_availability = mode.restores_availability()
        && verification_probe == crate::gateway::GeminiVerificationProbe::Verified;
    if mode.records_scheduled_attempt() {
        sqlx::query("SAVEPOINT scheduled_credential_persistence")
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
    }
    let persistence = async {
        sqlx::query(
            "UPDATE agent_connection_credentials SET credential_ciphertext = $2,
         credential_nonce = $3, access_token_expires_at = $4,
         refresh_token_expires_at = $5, refresh_attempted_at = NOW(), updated_at = NOW()
         WHERE connection_id = $1",
        )
        .bind(row.id)
        .bind(credential_ciphertext)
        .bind(credential_nonce)
        .bind(access_token_expires_at)
        .bind(refresh_token_expires_at)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        sqlx::query(
            "UPDATE agent_connections SET
            account_label = COALESCE($2, account_label),
            plan = COALESCE($3, plan),
            availability_status = CASE WHEN $4 THEN 'reauth_required' ELSE availability_status END,
            failure_message = CASE WHEN $4 THEN $5 ELSE failure_message END,
            updated_at = NOW()
         WHERE id = $1",
        )
        .bind(row.id)
        .bind(account_label)
        .bind(plan)
        .bind(verification_required)
        .bind(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
        if restores_availability {
            restore_refreshed_availability(&mut transaction, row.id, mode).await?;
        }
        Ok::<(), ApiError>(())
    }
    .await;
    if let Err(error) = persistence {
        if mode.records_scheduled_attempt() {
            sqlx::query("ROLLBACK TO SAVEPOINT scheduled_credential_persistence")
                .execute(&mut *transaction)
                .await
                .map_err(database_error)?;
        }
        return finish_refresh_error(transaction, mode, error).await;
    }
    transaction.commit().await.map_err(database_error)?;
    let updated = owned_connection_by_id(state, row.id).await?;
    let remains_reauthorization_required = provider == AgentProvider::Gemini
        && mode.restores_availability()
        && verification_probe == crate::gateway::GeminiVerificationProbe::Inconclusive
        && sqlx::query_scalar::<_, String>(
            "SELECT availability_status FROM agent_connections WHERE id = $1",
        )
        .bind(row.id)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?
            == "reauth_required";
    if verification_required || remains_reauthorization_required {
        return Ok(RefreshConnectionOutcome::ReauthorizationRequired(updated));
    }
    connection_from_row(updated, None).map(|connection| RefreshConnectionOutcome::Connected {
        connection,
        refreshed: true,
    })
}

fn should_refresh_credential(
    mode: CredentialRefreshMode,
    access_token_expires_at: Option<DateTime<Utc>>,
    updated_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    match mode {
        CredentialRefreshMode::Force | CredentialRefreshMode::Rejected(_) => true,
        CredentialRefreshMode::NearExpiry => access_token_expires_at
            .is_some_and(|expires_at| expires_at <= now + Duration::minutes(5)),
        CredentialRefreshMode::Stale(interval) | CredentialRefreshMode::Recover(interval) => {
            updated_at <= now - interval
        }
        CredentialRefreshMode::Nightly(day_start_utc) => updated_at < day_start_utc,
    }
}

/// Restore an account after its provider accepted a refreshed credential.
/// Scheduled recovery only restores the reconnect states it may retry; a
/// verification challenge or an owner's pending reconnect is left alone.
async fn restore_refreshed_availability(
    transaction: &mut Transaction<'_, Postgres>,
    connection_id: Uuid,
    mode: CredentialRefreshMode,
) -> Result<(), ApiError> {
    let recover_only = matches!(mode, CredentialRefreshMode::Recover(_));
    let restored = sqlx::query(
        "UPDATE agent_connections SET availability_status = 'active',
             rate_limited_until = NULL, retry_claimed_at = NULL, failure_message = NULL,
             updated_at = NOW()
         WHERE id = $1
           AND (NOT $2 OR (availability_status = 'reauth_required'
                           AND failure_message = ANY($3)))",
    )
    .bind(connection_id)
    .bind(recover_only)
    .bind(
        RECOVERABLE_REAUTHORIZATION_MESSAGES
            .iter()
            .map(|message| (*message).to_owned())
            .collect::<Vec<_>>(),
    )
    .execute(&mut **transaction)
    .await
    .map_err(database_error)?
    .rows_affected();
    if restored > 0 {
        // A successful refresh makes any unfinished reconnect prompt obsolete.
        // Leaving it would later expire and wrongly mark the account again.
        sqlx::query("DELETE FROM agent_connection_authorizations WHERE connection_id = $1")
            .bind(connection_id)
            .execute(&mut **transaction)
            .await
            .map_err(database_error)?;
    }
    Ok(())
}

/// Run a credential refresh in its own task. The provider may rotate the
/// refresh token as soon as it answers; if a dropped request or timeout
/// cancelled the caller before commit, the new token would be rolled back and
/// the next refresh would be rejected as reused.
async fn refresh_detached(
    state: &AppState,
    row: ConnectionRow,
    mode: CredentialRefreshMode,
) -> Result<RefreshConnectionOutcome, ApiError> {
    let state = state.clone();
    let in_flight = InFlightRefresh::start();
    tokio::spawn(async move {
        let _in_flight = in_flight;
        refresh_connected_connection(&state, row, mode).await
    })
    .await
    .map_err(|error| {
        eprintln!("credential refresh task failed: {error}");
        ApiError::Internal
    })?
}

static SWEEPS_STOPPING: AtomicBool = AtomicBool::new(false);
static IN_FLIGHT_REFRESHES: AtomicUsize = AtomicUsize::new(0);
static REFRESHES_SETTLED: Notify = Notify::const_new();

/// Counts a detached refresh until its task finishes, even if it panics.
struct InFlightRefresh;

impl InFlightRefresh {
    fn start() -> Self {
        IN_FLIGHT_REFRESHES.fetch_add(1, Ordering::SeqCst);
        Self
    }
}

impl Drop for InFlightRefresh {
    fn drop(&mut self) {
        if IN_FLIGHT_REFRESHES.fetch_sub(1, Ordering::SeqCst) == 1 {
            REFRESHES_SETTLED.notify_waiters();
        }
    }
}

/// Stop scheduled sweeps from starting another account. Called as soon as the
/// process is asked to shut down; a refresh already talking to its provider
/// still finishes and commits.
pub fn stop_credential_sweeps() {
    SWEEPS_STOPPING.store(true, Ordering::SeqCst);
}

/// Wait until no detached credential refresh is running, or `limit` passes.
/// Returns whether every refresh settled. A provider may already have rotated
/// a refresh token, so shutdown waits for the commit instead of dropping it.
pub async fn wait_for_credential_refreshes(limit: std::time::Duration) -> bool {
    tokio::time::timeout(limit, async {
        loop {
            let settled = REFRESHES_SETTLED.notified();
            tokio::pin!(settled);
            settled.as_mut().enable();
            if IN_FLIGHT_REFRESHES.load(Ordering::SeqCst) == 0 {
                return;
            }
            settled.await;
        }
    })
    .await
    .is_ok()
}

pub(crate) async fn provider_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<(AgentProvider, Value), ApiError> {
    match gateway_credential(state, connection_id).await? {
        CredentialLookup::Ready(provider, token) => Ok((provider, token)),
        CredentialLookup::ReauthorizationRequired => Err(ApiError::Forbidden),
    }
}

/// The current credential for a request. Most requests read it without a row
/// lock, so many members sharing one account do not queue behind each other or
/// behind a background refresh; only a credential about to expire takes the
/// lock and refreshes.
pub(crate) async fn gateway_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let provider = AgentProvider::from_str(&row.provider)?;
    if let Some(credential) = stored_credential_row(state, connection_id).await?
        && !should_refresh_credential(
            CredentialRefreshMode::NearExpiry,
            credential.access_token_expires_at,
            credential.updated_at,
            Utc::now(),
        )
    {
        let token = decrypt_json(
            &state.config.credential_encryption_key,
            &credential.credential_ciphertext,
            &credential.credential_nonce,
        )?;
        return Ok(CredentialLookup::Ready(provider, token));
    }

    match refresh_detached(state, row, CredentialRefreshMode::NearExpiry).await? {
        RefreshConnectionOutcome::Connected { .. } => {}
        RefreshConnectionOutcome::ReauthorizationRequired(_) => {
            return Ok(CredentialLookup::ReauthorizationRequired);
        }
    }
    current_credential(state, connection_id).await
}

/// Recover from a provider rejecting `observed_access_token`. Under the
/// credential lock, rotate it once if it is still the stored token, or return
/// the token another request already rotated in. Only a rejected refresh
/// credential marks the account for reconnect here; a transient provider or
/// network failure is returned as an error and leaves the account unchanged.
pub(crate) async fn recover_rejected_credential(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let mode = CredentialRefreshMode::Rejected(access_token_fingerprint(observed_access_token));
    match refresh_detached(state, row, mode).await? {
        RefreshConnectionOutcome::Connected { .. } => {
            current_credential(state, connection_id).await
        }
        RefreshConnectionOutcome::ReauthorizationRequired(_) => {
            Ok(CredentialLookup::ReauthorizationRequired)
        }
    }
}

async fn stored_credential_row(
    state: &AppState,
    connection_id: Uuid,
) -> Result<Option<CredentialRow>, ApiError> {
    sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at, refresh_attempted_at, updated_at
         FROM agent_connection_credentials
         WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)
}

async fn current_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<CredentialLookup, ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let credential = stored_credential_row(state, connection_id)
        .await?
        .ok_or(ApiError::Forbidden)?;
    let token = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;

    Ok(CredentialLookup::Ready(
        AgentProvider::from_str(&row.provider)?,
        token,
    ))
}

/// Apply an observed Code Assist verification challenge only while the same
/// access token is still stored. A completed reconnect changes the credential
/// under this row lock and must not be overwritten by an older response.
pub(crate) async fn mark_gemini_verification_required(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
) -> Result<bool, ApiError> {
    mark_reauthorization_required_if_current(
        state,
        connection_id,
        observed_access_token,
        ACCOUNT_VERIFICATION_REQUIRED_MESSAGE,
    )
    .await
}

/// Mark an account for reconnect because the provider rejected
/// `observed_access_token`, but only while that token is still the stored one.
/// A refresh, reconnect or recovery that replaced it under the credential lock
/// wins over this older rejection.
pub(crate) async fn mark_reauthorization_required_if_current(
    state: &AppState,
    connection_id: Uuid,
    observed_access_token: &str,
    message: &'static str,
) -> Result<bool, ApiError> {
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
                refresh_token_expires_at, refresh_attempted_at, updated_at
         FROM agent_connection_credentials WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(connection_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    let Some(credential) = credential else {
        transaction.commit().await.map_err(database_error)?;
        return Ok(false);
    };
    let current: Value = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;
    if current.get("access_token").and_then(Value::as_str) != Some(observed_access_token) {
        transaction.commit().await.map_err(database_error)?;
        return Ok(false);
    }
    let marked = sqlx::query_scalar::<_, String>(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', rate_limited_until = NULL,
             retry_claimed_at = NULL, failure_message = $2, updated_at = NOW()
         WHERE id = $1 AND status = 'connected'
         RETURNING provider",
    )
    .bind(connection_id)
    .bind(message)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    if let Some(provider) = &marked {
        eprintln!("{provider} connection {connection_id} marked for reconnect: {message}");
    }
    Ok(marked.is_some())
}

async fn refresh_provider_token(
    state: &AppState,
    provider: AgentProvider,
    refresh_token: &str,
    stored_token: &Value,
) -> Result<Value, ProviderRefreshError> {
    let response = match provider {
        AgentProvider::Chatgpt => {
            state
                .http
                .post(format!("{}/oauth/token", state.config.codex_issuer))
                .header(
                    "user-agent",
                    format!("codex_cli_rs/{}", state.config.codex_client_version),
                )
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", CODEX_CLIENT_ID),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
        AgentProvider::Claude => {
            let scope = stored_token
                .get("scope")
                .and_then(Value::as_str)
                .unwrap_or(CLAUDE_SCOPES);
            state
                .http
                .post(&state.config.claude_token_url)
                .json(&serde_json::json!({
                    "grant_type": "refresh_token",
                    "refresh_token": refresh_token,
                    "client_id": CLAUDE_CLIENT_ID,
                    "scope": scope,
                }))
                .send()
                .await
        }
        AgentProvider::Gemini => {
            state
                .http
                .post(&state.config.gemini_token_url)
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("refresh_token", refresh_token),
                    ("client_id", state.config.gemini_client_id.as_str()),
                    ("client_secret", state.config.gemini_client_secret.as_str()),
                ])
                .send()
                .await
        }
        AgentProvider::Deepseek | AgentProvider::Groq => {
            return Err(ProviderRefreshError::ReauthorizationRequired);
        }
        AgentProvider::Grok => {
            grok_oauth_request(state, "/oauth2/token")
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", state.config.grok_client_id.as_str()),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
    }
    .map_err(|error| ProviderRefreshError::Api(upstream_network_error(provider, error)))?;

    if !response.status().is_success() {
        let status = response.status();
        let payload = response.json::<Value>().await.ok();
        if refresh_requires_reauthorization(provider, status, payload.as_ref()) {
            return Err(ProviderRefreshError::ReauthorizationRequired);
        }
        return Err(ProviderRefreshError::Api(upstream_status_error(
            provider, status,
        )));
    }

    parse_token_response(provider, response)
        .await
        .map_err(ProviderRefreshError::Api)
}

fn refresh_requires_reauthorization(
    provider: AgentProvider,
    status: reqwest::StatusCode,
    payload: Option<&Value>,
) -> bool {
    if !matches!(
        status,
        reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::UNAUTHORIZED
    ) {
        return false;
    }
    let error = payload
        .and_then(|payload| payload.get("error"))
        .and_then(|error| {
            error
                .as_str()
                .or_else(|| error.get("type").and_then(Value::as_str))
        });
    if error == Some("invalid_grant") {
        return true;
    }
    provider == AgentProvider::Chatgpt
        && payload
            .and_then(|payload| payload.pointer("/error/code"))
            .and_then(Value::as_str)
            == Some("refresh_token_invalidated")
}

fn merge_token_response(mut stored: Value, refreshed: Value) -> Value {
    let Some(stored_object) = stored.as_object_mut() else {
        return refreshed;
    };
    let Some(refreshed_object) = refreshed.as_object() else {
        return refreshed;
    };
    for (key, value) in refreshed_object {
        stored_object.insert(key.clone(), value.clone());
    }
    stored
}

async fn fail_connection(
    state: &AppState,
    row: ConnectionRow,
    message: &'static str,
) -> Result<AgentConnection, ApiError> {
    sqlx::query("DELETE FROM agent_connection_authorizations WHERE connection_id = $1")
        .bind(row.id)
        .execute(&state.pool)
        .await
        .map_err(database_error)?;
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections
         SET status = CASE WHEN status = 'connected' THEN 'connected' ELSE 'failed' END,
             failure_message = CASE
               WHEN status <> 'connected' OR availability_status = 'reauth_required' THEN $2
               ELSE failure_message
             END,
             updated_at = NOW()
         WHERE id = $1
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(row.id)
    .bind(message)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    connection_from_row(updated, None)
}

async fn owned_connection(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at
         FROM agent_connections WHERE id = $1 AND user_id = $2",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

async fn owned_connection_by_id(
    state: &AppState,
    connection_id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, created_at, updated_at
         FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

async fn load_authorization(
    state: &AppState,
    connection_id: Uuid,
) -> Result<AuthorizationRow, ApiError> {
    sqlx::query_as::<_, AuthorizationRow>(
        "SELECT secret_ciphertext, secret_nonce, expires_at
         FROM agent_connection_authorizations WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

async fn connection_has_authorization(
    state: &AppState,
    connection_id: Uuid,
) -> Result<bool, ApiError> {
    sqlx::query_scalar(
        "SELECT EXISTS(
            SELECT 1 FROM agent_connection_authorizations WHERE connection_id = $1
         )",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)
}

fn prompt_from_started(started: StartedAuthorization) -> AgentAuthorizationPrompt {
    AgentAuthorizationPrompt {
        authorization_url: started.prompt_url,
        expires_at: started.expires_at,
        poll_after_seconds: started.poll_after_seconds,
        requires_callback_url: started.requires_callback_url,
        user_code: started.user_code,
    }
}

fn connection_from_row(
    row: ConnectionRow,
    authorization: Option<AgentAuthorizationPrompt>,
) -> Result<AgentConnection, ApiError> {
    Ok(AgentConnection {
        account_label: row.account_label,
        authorization,
        availability_status: row.availability_status,
        created_at: row.created_at,
        failure_message: row.failure_message,
        id: row.id,
        plan: row.plan,
        provider: AgentProvider::from_str(&row.provider)?,
        status: AgentConnectionStatus::from_str(&row.status)?,
        updated_at: row.updated_at,
    })
}

fn encrypt_json<T: Serialize>(key: &[u8; 32], value: &T) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let mut nonce_bytes = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = serde_json::to_vec(value).map_err(|_| ApiError::Internal)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| ApiError::Internal)?;
    Ok((ciphertext, nonce_bytes.to_vec()))
}

fn decrypt_json<T: for<'de> Deserialize<'de>>(
    key: &[u8; 32],
    ciphertext: &[u8],
    nonce: &[u8],
) -> Result<T, ApiError> {
    if nonce.len() != 12 {
        return Err(ApiError::Internal);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| ApiError::Internal)?;
    serde_json::from_slice(&plaintext).map_err(|_| ApiError::Internal)
}

fn random_url_token(bytes: usize) -> String {
    let mut random = vec![0_u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut random);
    URL_SAFE_NO_PAD.encode(random)
}

fn parse_callback_value(value: &str) -> Result<(String, Option<String>), ApiError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ApiError::Validation(
            "Paste the authorization callback URL.",
        ));
    }
    if let Ok(url) = Url::parse(value) {
        let code = url
            .query_pairs()
            .find_map(|(key, value)| (key == "code").then(|| value.into_owned()))
            .filter(|code| !code.is_empty())
            .ok_or(ApiError::Validation(
                "The callback URL does not contain an authorization code.",
            ))?;
        let state = url
            .query_pairs()
            .find_map(|(key, value)| (key == "state").then(|| value.into_owned()));
        return Ok((code, state));
    }
    let (code, state) = value
        .split_once('#')
        .map_or((value, None), |(code, state)| {
            (code, Some(state.to_owned()))
        });
    if code.is_empty() {
        return Err(ApiError::Validation(
            "The authorization code cannot be empty.",
        ));
    }
    Ok((code.to_owned(), state))
}

fn mask_account_label(email: &str) -> String {
    let Some((local, domain)) = email.split_once('@') else {
        return "connected account".to_owned();
    };
    let local = local.split_once('+').map_or(local, |(base, _)| base);
    let Some((domain_without_suffix, suffix)) = domain.rsplit_once('.') else {
        return "connected account".to_owned();
    };
    let domain_prefix = domain_without_suffix
        .split('.')
        .next()
        .unwrap_or_default()
        .chars()
        .take(3)
        .collect::<String>();
    let local_chars = local.chars().collect::<Vec<_>>();
    if local_chars.is_empty() || domain_prefix.is_empty() || suffix.is_empty() {
        return "connected account".to_owned();
    }
    let local_prefix_len = local_chars.len().min(2);
    let local_prefix = local_chars
        .iter()
        .take(local_prefix_len)
        .collect::<String>();
    let suffix_start = local_chars.len().saturating_sub(3).max(local_prefix_len);
    let local_suffix = local_chars.iter().skip(suffix_start).collect::<String>();
    format!("{local_prefix}**{local_suffix}@{domain_prefix}**.{suffix}")
}

fn decoded_token_claims(encoded_token: &str) -> Option<Value> {
    let encoded = encoded_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&decoded).ok()
}

fn token_claims(token: &Value) -> Option<Value> {
    ["id_token", "access_token"]
        .into_iter()
        .find_map(|field| decoded_token_claims(token.get(field)?.as_str()?))
}

fn token_claim(token: &Value, claim: &str) -> Option<Value> {
    ["access_token", "id_token"].into_iter().find_map(|field| {
        decoded_token_claims(token.get(field)?.as_str()?)?
            .get(claim)
            .cloned()
    })
}

fn grok_oauth_request(state: &AppState, path: &str) -> reqwest::RequestBuilder {
    let user_agent = format!("xai-grok-build/{}", state.config.grok_client_version);
    state
        .http
        .post(format!(
            "{}{}",
            state.config.grok_issuer.trim_end_matches('/'),
            path
        ))
        .header("user-agent", user_agent)
        .header("accept", "application/json")
        .header("x-grok-client-version", &state.config.grok_client_version)
        .header("x-grok-client-surface", GROK_CLIENT_SURFACE)
}

fn validate_prompt_url(issuer: &str, prompt_url: &str) -> Result<(), ApiError> {
    let issuer = Url::parse(issuer).map_err(|_| ApiError::Internal)?;
    let prompt = Url::parse(prompt_url).map_err(|_| upstream_payload_error(AgentProvider::Grok))?;
    let expected_prompt = if issuer.host_str() == Some("auth.x.ai") {
        Url::parse("https://accounts.x.ai").map_err(|_| ApiError::Internal)?
    } else {
        issuer
    };
    let same_origin = expected_prompt.scheme() == prompt.scheme()
        && expected_prompt.host_str() == prompt.host_str()
        && expected_prompt.port_or_known_default() == prompt.port_or_known_default();
    same_origin
        .then_some(())
        .ok_or_else(|| upstream_payload_error(AgentProvider::Grok))
}

fn upstream_network_error(provider: AgentProvider, error: reqwest::Error) -> ApiError {
    eprintln!("{} authorization request failed: {error}", provider.label());
    ApiError::Provider(format!(
        "{} authorization is temporarily unavailable. Try again.",
        provider.label()
    ))
}

fn upstream_status_error(provider: AgentProvider, status: reqwest::StatusCode) -> ApiError {
    eprintln!("{} authorization returned HTTP {status}", provider.label());
    ApiError::Provider(format!(
        "{} rejected the authorization request. Try again later.",
        provider.label()
    ))
}

fn upstream_payload_error(provider: AgentProvider) -> ApiError {
    eprintln!(
        "{} authorization returned an unexpected response",
        provider.label()
    );
    ApiError::Provider(format!(
        "{} returned an unexpected authorization response.",
        provider.label()
    ))
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("agent connection database operation failed: {error}");
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    use axum::{
        Form, Json, Router,
        http::HeaderMap,
        routing::{get, post},
    };
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use reqwest::Url;
    use serde_json::{Value, json};
    use tokio::net::TcpListener;

    use super::{
        ANTIGRAVITY_CLIENT_VERSION, AgentProvider, AuthorizationSecret, CODEX_REDIRECT_URI,
        CODEX_SCOPES, CredentialRefreshMode, GEMINI_SCOPES, GROK_SCOPES, connection_metadata,
        decrypt_json, encrypt_json, exchange_gemini_code, fetch_claude_profile,
        gemini_code_assist_body, mask_account_label, merge_token_response, parse_callback_value,
        provider_account_identity, reauthorization_identity_matches, refresh_provider_token,
        refresh_requires_reauthorization, scheduled_refresh_after, should_refresh_credential,
        start_claude_authorization, start_codex_authorization, start_gemini_authorization,
        start_grok_authorization, token_claims, validate_api_key_input, validate_prompt_url,
        validate_static_key,
    };
    use crate::AppConfig;
    use chrono::Duration;
    use uuid::Uuid;

    #[test]
    fn authorization_secrets_are_encrypted_and_round_trip() {
        let key = [42_u8; 32];
        let secret = AuthorizationSecret::Grok {
            device_code: "device-secret".to_owned(),
            user_code: "ABCD-EFGH".to_owned(),
            verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH"
                .to_owned(),
        };
        let (ciphertext, nonce) = encrypt_json(&key, &secret).unwrap();
        assert!(!String::from_utf8_lossy(&ciphertext).contains("device-secret"));
        let decoded: AuthorizationSecret = decrypt_json(&key, &ciphertext, &nonce).unwrap();
        assert_eq!(
            serde_json::to_value(decoded).unwrap(),
            serde_json::to_value(secret).unwrap()
        );
    }

    #[tokio::test]
    async fn claude_authorization_uses_pkce_and_official_manual_callback() {
        let state = crate::AppState {
            config: AppConfig::default(),
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };
        let started = start_claude_authorization(&state).unwrap();
        let url = reqwest::Url::parse(&started.prompt_url).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(url.host_str(), Some("claude.com"));
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(
            query.get("redirect_uri").unwrap(),
            "https://platform.claude.com/oauth/code/callback"
        );
        assert!(started.requires_callback_url);
    }

    #[tokio::test]
    async fn gemini_authorization_uses_agy_google_oauth_with_pkce() {
        let state = crate::AppState {
            config: AppConfig::default(),
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };
        let started = start_gemini_authorization(&state).unwrap();
        let url = reqwest::Url::parse(&started.prompt_url).unwrap();
        let query = url
            .query_pairs()
            .collect::<std::collections::HashMap<_, _>>();

        assert_eq!(url.host_str(), Some("accounts.google.com"));
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert_eq!(query.get("scope").unwrap(), GEMINI_SCOPES);
        assert_eq!(query.get("access_type").unwrap(), "offline");
        assert_eq!(query.get("prompt").unwrap(), "consent");
        assert_eq!(
            query.get("redirect_uri").unwrap(),
            "https://antigravity.google/oauth-callback"
        );
        assert!(started.requires_callback_url);
    }

    #[tokio::test]
    async fn claude_plan_is_read_from_the_oauth_profile_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(None));
        let captured_request = captured.clone();
        let server = Router::new().route(
            "/api/oauth/profile",
            get(move |headers: HeaderMap| {
                let captured_request = captured_request.clone();
                async move {
                    *captured_request.lock().unwrap() = Some(headers);
                    Json(json!({
                        "organization": {
                            "organization_type": "claude_max",
                            "organization_rate_limit_tier": "default_claude_max_5x"
                        }
                    }))
                }
            }),
        );
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await });
        let state = crate::AppState {
            config: AppConfig {
                claude_profile_url: format!("{origin}/api/oauth/profile"),
                ..AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };
        let token = json!({ "access_token": "claude-access" });

        let profile = fetch_claude_profile(&state, &token).await.unwrap();
        server_task.abort();

        let headers = captured.lock().unwrap();
        let headers = headers.as_ref().unwrap();
        assert_eq!(headers["authorization"], "Bearer claude-access");
        assert_eq!(headers["cache-control"], "no-cache");
        assert_eq!(
            connection_metadata(AgentProvider::Claude, &token, Some(&profile)).1,
            Some("MAX".to_owned())
        );
    }

    #[test]
    fn claude_profile_types_use_concise_plan_labels() {
        for (organization_type, label) in [
            ("claude_max", "MAX"),
            ("claude_pro", "Pro"),
            ("claude_team", "Team"),
            ("claude_enterprise", "Enterprise"),
        ] {
            let profile = json!({
                "organization": { "organization_type": organization_type }
            });
            assert_eq!(
                connection_metadata(
                    AgentProvider::Claude,
                    &json!({ "access_token": "token" }),
                    Some(&profile)
                )
                .1,
                Some(label.to_owned())
            );
        }
    }

    #[tokio::test]
    async fn gemini_token_exchange_sends_the_agy_client_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(None));
        let captured_request = captured.clone();
        let captured_load_headers = Arc::new(Mutex::new(None));
        let load_headers = captured_load_headers.clone();
        let server = Router::new()
            .route(
                "/token",
                post(move |Form(form): Form<HashMap<String, String>>| {
                    let captured_request = captured_request.clone();
                    async move {
                        *captured_request.lock().unwrap() = Some(form);
                        Json(json!({
                            "access_token": "google-access-token",
                            "refresh_token": "google-refresh-token"
                        }))
                    }
                }),
            )
            .route(
                "/userinfo",
                get(|| async { Json(json!({ "email": "owner@example.com" })) }),
            )
            .route(
                "/v1internal:loadCodeAssist",
                post(
                    move |headers: HeaderMap, Json(body): Json<Value>| async move {
                        *load_headers.lock().unwrap() = Some((headers, body));
                        Json(json!({
                            "cloudaicompanionProject": "subscription-project",
                            "currentTier": { "name": "Google AI Pro" }
                        }))
                    },
                ),
            );
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

        let state = crate::AppState {
            config: AppConfig {
                gemini_client_id: "agy-client-id".to_owned(),
                gemini_client_secret: "agy-client-secret".to_owned(),
                gemini_code_assist_url: issuer.clone(),
                gemini_token_url: format!("{issuer}/token"),
                gemini_userinfo_url: format!("{issuer}/userinfo"),
                ..AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };

        let token = exchange_gemini_code(
            &state,
            "one-time-code",
            "pkce-code-verifier",
            "https://antigravity.google/oauth-callback",
        )
        .await
        .unwrap();
        server_task.abort();

        let captured = captured.lock().unwrap();
        let form = captured.as_ref().unwrap();
        assert_eq!(form.get("client_id").unwrap(), "agy-client-id");
        assert_eq!(form.get("client_secret").unwrap(), "agy-client-secret");
        assert_eq!(form.get("code_verifier").unwrap(), "pkce-code-verifier");
        let load_headers = captured_load_headers.lock().unwrap();
        let (headers, body) = load_headers.as_ref().unwrap();
        assert_eq!(headers["user-agent"], ANTIGRAVITY_CLIENT_VERSION);
        assert_eq!(body, &json!({ "metadata": { "ideType": "ANTIGRAVITY" } }));
        assert_eq!(
            token.get("cloudaicompanion_project").unwrap(),
            "subscription-project"
        );
    }

    #[test]
    fn gemini_code_assist_refresh_matches_the_current_agy_metadata_shape() {
        assert_eq!(
            gemini_code_assist_body(Some("aicode-consumers")),
            json!({
                "cloudaicompanionProject": "aicode-consumers",
                "metadata": { "ideType": "ANTIGRAVITY" }
            })
        );
    }

    #[tokio::test]
    async fn gemini_token_refresh_sends_the_agy_client_secret() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let captured = Arc::new(Mutex::new(None));
        let captured_request = captured.clone();
        let server = Router::new().route(
            "/token",
            post(move |Form(form): Form<HashMap<String, String>>| {
                let captured_request = captured_request.clone();
                async move {
                    *captured_request.lock().unwrap() = Some(form);
                    Json(json!({ "access_token": "refreshed-access-token" }))
                }
            }),
        );
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

        let state = crate::AppState {
            config: AppConfig {
                gemini_client_id: "agy-client-id".to_owned(),
                gemini_client_secret: "agy-client-secret".to_owned(),
                gemini_token_url: format!("{issuer}/token"),
                ..AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };

        let refreshed = match refresh_provider_token(
            &state,
            AgentProvider::Gemini,
            "google-refresh-token",
            &json!({}),
        )
        .await
        {
            Ok(token) => token,
            Err(_) => panic!("Gemini token refresh should succeed"),
        };
        server_task.abort();

        let captured = captured.lock().unwrap();
        let form = captured.as_ref().unwrap();
        assert_eq!(form.get("grant_type").unwrap(), "refresh_token");
        assert_eq!(form.get("client_secret").unwrap(), "agy-client-secret");
        assert_eq!(
            refreshed.get("access_token").unwrap(),
            "refreshed-access-token"
        );
    }

    #[tokio::test]
    async fn grok_device_authorization_uses_the_current_oauth_contract() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let issuer = format!("http://{}", listener.local_addr().unwrap());
        let prompt_url = format!("{issuer}/oauth2/device?user_code=ABCD-EFGH");
        let captured = Arc::new(Mutex::new(None));
        let captured_request = captured.clone();
        let response_prompt_url = prompt_url.clone();
        let server = Router::new().route(
            "/oauth2/device/code",
            post(
                move |headers: HeaderMap, Form(form): Form<HashMap<String, String>>| {
                    let captured_request = captured_request.clone();
                    let response_prompt_url = response_prompt_url.clone();
                    async move {
                        *captured_request.lock().unwrap() = Some((headers, form));
                        Json(json!({
                            "device_code": "device-secret",
                            "user_code": "ABCD-EFGH",
                            "verification_uri": response_prompt_url.clone(),
                            "verification_uri_complete": response_prompt_url,
                            "expires_in": 900,
                            "interval": 5
                        }))
                    }
                },
            ),
        );
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

        let config = AppConfig {
            grok_client_id: "current-client-id".to_owned(),
            grok_client_version: "9.8.7".to_owned(),
            grok_issuer: issuer,
            ..AppConfig::default()
        };
        let state = crate::AppState {
            config,
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };

        let started = start_grok_authorization(&state).await.unwrap();
        server_task.abort();

        let captured = captured.lock().unwrap();
        let (headers, form) = captured.as_ref().unwrap();
        assert_eq!(form.get("client_id").unwrap(), "current-client-id");
        assert_eq!(form.get("scope").unwrap(), GROK_SCOPES);
        assert_eq!(
            GROK_SCOPES,
            "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write"
        );
        assert_eq!(headers["x-grok-client-version"], "9.8.7");
        assert_eq!(headers["x-grok-client-surface"], "grok-build");
        assert_eq!(headers["user-agent"], "xai-grok-build/9.8.7");
        assert_eq!(started.prompt_url, prompt_url);
        assert_eq!(started.user_code.as_deref(), Some("ABCD-EFGH"));
        assert!(!started.requires_callback_url);
    }

    #[test]
    fn grok_device_prompt_is_restricted_to_the_official_account_origin() {
        assert!(
            validate_prompt_url(
                "https://auth.x.ai",
                "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH"
            )
            .is_ok()
        );
        assert!(
            validate_prompt_url(
                "https://auth.x.ai",
                "https://accounts.x.ai.evil.example/oauth2/device"
            )
            .is_err()
        );
    }

    #[test]
    fn callback_parser_accepts_urls_and_claude_code_state_pairs() {
        assert_eq!(
            parse_callback_value(
                "https://platform.claude.com/oauth/code/callback?code=abc&state=state-1"
            )
            .unwrap(),
            ("abc".to_owned(), Some("state-1".to_owned()))
        );
        assert_eq!(
            parse_callback_value("abc#state-1").unwrap(),
            ("abc".to_owned(), Some("state-1".to_owned()))
        );
    }

    #[tokio::test]
    async fn codex_browser_authorization_uses_the_official_local_callback_contract() {
        let state = crate::AppState {
            config: AppConfig::default(),
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };
        let started = start_codex_authorization(&state).unwrap();
        let url = Url::parse(&started.prompt_url).unwrap();
        let query = url.query_pairs().collect::<HashMap<_, _>>();

        assert_eq!(url.path(), "/oauth/authorize");
        assert_eq!(query.get("redirect_uri").unwrap(), CODEX_REDIRECT_URI);
        assert_eq!(query.get("scope").unwrap(), CODEX_SCOPES);
        assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
        assert!(started.requires_callback_url);
        assert_eq!(started.user_code, None);
    }

    #[test]
    fn account_labels_are_masked_before_browser_storage() {
        assert_eq!(
            mask_account_label("10279579+maplenorth@utc2eduvn.onmicrosoft.com"),
            "10**579@utc**.com"
        );
        assert_eq!(mask_account_label("duy@example.com"), "du**y@exa**.com");
        assert_eq!(mask_account_label("ab@x.dev"), "ab**@x**.dev");
        assert_eq!(mask_account_label("not-an-email"), "connected account");
        assert_eq!(json!({ "masked": true })["masked"], true);
    }

    #[test]
    fn deepseek_api_keys_are_validated_without_exposing_the_secret() {
        assert_eq!(
            validate_api_key_input("  sk-deepseek-secret-123456  ").unwrap(),
            "sk-deepseek-secret-123456"
        );
        assert!(validate_api_key_input("short").is_err());
        assert!(validate_api_key_input("sk-deepseek secret 123456").is_err());

        let (label, plan) = connection_metadata(
            AgentProvider::Deepseek,
            &json!({
                "access_token": "sk-do-not-display",
                "api_key_last_four": "3456",
                "plan": "API"
            }),
            None,
        );
        assert_eq!(label.as_deref(), Some("••••3456"));
        assert_eq!(plan.as_deref(), Some("API"));
    }

    #[tokio::test]
    async fn deepseek_api_key_validation_uses_bearer_auth_on_the_models_endpoint() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let api_url = format!("http://{}", listener.local_addr().unwrap());
        let server = Router::new().route(
            "/models",
            get(|headers: HeaderMap| async move {
                assert_eq!(
                    headers.get("authorization").unwrap(),
                    "Bearer sk-deepseek-secret-123456"
                );
                Json(json!({ "object": "list", "data": [] }))
            }),
        );
        let server_task = tokio::spawn(async move { axum::serve(listener, server).await });
        let state = crate::AppState {
            config: AppConfig {
                deepseek_api_url: api_url,
                ..AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool: sqlx::postgres::PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .unwrap(),
        };

        validate_static_key(&state, AgentProvider::Deepseek, "sk-deepseek-secret-123456")
            .await
            .unwrap();
        server_task.abort();
    }

    #[test]
    fn provider_identity_metadata_can_be_read_from_trusted_token_claims() {
        let claims = json!({
            "email": "owner@example.com",
            "https://api.openai.com/auth.chatgpt_plan_type": "plus"
        });
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );

        assert_eq!(token_claims(&json!({ "id_token": token })), Some(claims));
    }

    #[test]
    fn provider_account_identity_prefers_stable_ids_and_normalizes_email() {
        let claims = json!({
            "email": "OTHER@example.com",
            "sub": "personal-user-123",
            "https://api.openai.com/auth.chatgpt_account_id": "account-123"
        });
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );
        assert_eq!(
            provider_account_identity(AgentProvider::Chatgpt, &json!({ "id_token": token }), None),
            Some("chatgpt:sub:personal-user-123".to_owned())
        );
        assert_eq!(
            provider_account_identity(
                AgentProvider::Gemini,
                &json!({ "email": " Owner@Example.COM " }),
                None
            ),
            Some("email:owner@example.com".to_owned())
        );
    }

    #[test]
    fn chatgpt_identity_never_uses_a_workspace_or_legacy_cache_alone() {
        assert_eq!(
            provider_account_identity(
                AgentProvider::Chatgpt,
                &json!({
                    "account_id": "shared-workspace", "hub_account_identity": "id:shared-workspace"
                }),
                None
            ),
            None
        );
        for email in ["person+maple@example.test", "person+juliet@example.test"] {
            assert_eq!(
                provider_account_identity(
                    AgentProvider::Chatgpt,
                    &json!({
                        "account_id": "shared-workspace", "email": format!(" {} ", email.to_uppercase()),
                        "hub_account_identity": "id:shared-workspace"
                    }),
                    None
                ),
                Some(format!("chatgpt:email:{email}"))
            );
        }
    }

    #[test]
    fn reauthorization_requires_the_exact_same_provider_identity() {
        assert!(reauthorization_identity_matches(
            Some("id:account-1"),
            Some("id:account-1")
        ));
        assert!(!reauthorization_identity_matches(
            Some("id:account-1"),
            Some("id:account-2")
        ));
        assert!(!reauthorization_identity_matches(
            Some("id:account-1"),
            None
        ));
    }

    #[test]
    fn chatgpt_plan_is_read_from_the_live_nested_auth_claim() {
        for (raw_plan, displayed_plan) in [("plus", "Plus"), ("k12", "K12")] {
            let claims = json!({
                "email": "owner@example.com",
                "https://api.openai.com/auth": {
                    "chatgpt_plan_type": raw_plan,
                }
            });
            let token = format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
            );

            assert_eq!(
                connection_metadata(AgentProvider::Chatgpt, &json!({ "id_token": token }), None),
                (
                    Some("ow**ner@exa**.com".to_owned()),
                    Some(displayed_plan.to_owned())
                )
            );
        }
    }

    #[test]
    fn grok_numeric_tiers_use_product_plan_labels() {
        for (tier, displayed_plan) in [(1, "Grok"), (5, "Heavy"), (6, "Lite"), (7, "Plus")] {
            let claims = json!({ "email": "owner@example.com", "tier": tier });
            let token = format!(
                "header.{}.signature",
                URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
            );

            assert_eq!(
                connection_metadata(AgentProvider::Grok, &json!({ "access_token": token }), None),
                (
                    Some("ow**ner@exa**.com".to_owned()),
                    Some(displayed_plan.to_owned())
                )
            );
        }
    }

    #[test]
    fn refresh_rotation_replaces_returned_tokens_and_preserves_omitted_refresh_tokens() {
        let stored = json!({
            "access_token": "old-access",
            "refresh_token": "old-refresh",
            "expires_in": 300,
        });
        let rotated = merge_token_response(
            stored.clone(),
            json!({
                "access_token": "new-access",
                "refresh_token": "new-refresh",
                "expires_in": 600,
            }),
        );
        assert_eq!(rotated["refresh_token"], "new-refresh");
        let preserved = merge_token_response(
            stored,
            json!({ "access_token": "new-access", "expires_in": 600 }),
        );
        assert_eq!(preserved["refresh_token"], "old-refresh");
    }

    #[test]
    fn rejected_refresh_tokens_require_provider_authorization() {
        assert!(refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::BAD_REQUEST,
            Some(&json!({ "error": "invalid_grant" }))
        ));
        assert!(refresh_requires_reauthorization(
            AgentProvider::Claude,
            reqwest::StatusCode::UNAUTHORIZED,
            Some(&json!({ "error": { "type": "invalid_grant" } }))
        ));
        assert!(refresh_requires_reauthorization(
            AgentProvider::Chatgpt,
            reqwest::StatusCode::UNAUTHORIZED,
            Some(&json!({ "error": {
                "type": "invalid_request_error",
                "code": "refresh_token_invalidated"
            } }))
        ));
        assert!(!refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::UNAUTHORIZED,
            Some(&json!({ "error": { "code": "refresh_token_invalidated" } }))
        ));
        assert!(!refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::UNAUTHORIZED,
            Some(&json!({ "error": "invalid_client" }))
        ));
        assert!(!refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::BAD_REQUEST,
            Some(&json!({ "error": "invalid_request" }))
        ));
        assert!(!refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::BAD_REQUEST,
            None
        ));
        assert!(!refresh_requires_reauthorization(
            AgentProvider::Gemini,
            reqwest::StatusCode::TOO_MANY_REQUESTS,
            Some(&json!({ "error": "invalid_grant" }))
        ));
    }

    #[test]
    fn scheduled_credentials_refresh_every_thirty_to_forty_five_minutes() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-15T00:00:00Z")
            .unwrap()
            .to_utc();
        let earliest = Uuid::from_bytes([0; 16]);
        let mut latest_bytes = [0; 16];
        latest_bytes[15] = u8::MAX;
        let latest = Uuid::from_bytes(latest_bytes);

        assert_eq!(scheduled_refresh_after(earliest), Duration::minutes(30));
        assert_eq!(
            scheduled_refresh_after(latest),
            Duration::seconds(44 * 60 + 56)
        );
        for connection_id in [earliest, latest, Uuid::new_v4(), Uuid::new_v4()] {
            let interval = scheduled_refresh_after(connection_id);
            assert!(interval >= Duration::minutes(30) && interval < Duration::minutes(45));
            assert!(!should_refresh_credential(
                CredentialRefreshMode::Stale(interval),
                None,
                now - interval + Duration::seconds(1),
                now,
            ));
            assert!(should_refresh_credential(
                CredentialRefreshMode::Stale(interval),
                None,
                now - interval,
                now,
            ));
            assert!(should_refresh_credential(
                CredentialRefreshMode::Recover(interval),
                None,
                now - interval,
                now,
            ));
        }
    }

    #[test]
    fn nightly_refresh_skips_credentials_already_checked_today() {
        let day_start = chrono::DateTime::parse_from_rfc3339("2026-09-25T17:00:00Z")
            .unwrap()
            .to_utc();

        assert!(should_refresh_credential(
            CredentialRefreshMode::Nightly(day_start),
            None,
            day_start - chrono::Duration::seconds(1),
            day_start,
        ));
        assert!(!should_refresh_credential(
            CredentialRefreshMode::Nightly(day_start),
            None,
            day_start,
            day_start,
        ));
    }

    #[test]
    fn request_refresh_still_uses_access_token_expiry() {
        let now = chrono::DateTime::parse_from_rfc3339("2026-09-15T00:00:00Z")
            .unwrap()
            .to_utc();

        assert!(!should_refresh_credential(
            CredentialRefreshMode::NearExpiry,
            Some(now + chrono::Duration::minutes(6)),
            now - chrono::Duration::hours(2),
            now,
        ));
        assert!(should_refresh_credential(
            CredentialRefreshMode::NearExpiry,
            Some(now + chrono::Duration::minutes(5)),
            now,
            now,
        ));
    }
}
