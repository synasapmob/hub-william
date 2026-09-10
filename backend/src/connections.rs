use std::{fmt, str::FromStr};

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
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{AppState, auth::authenticated_user_id, error::ApiError};

const CODEX_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
const CLAUDE_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const CLAUDE_SCOPES: &str = "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";
const GROK_CLIENT_ID: &str = "codex-grok-client";
const DEFAULT_DEVICE_EXPIRY_SECONDS: i64 = 900;
const DEFAULT_POLL_SECONDS: u64 = 5;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    Chatgpt,
    Claude,
    Grok,
}

impl AgentProvider {
    fn as_str(self) -> &'static str {
        match self {
            Self::Chatgpt => "chatgpt",
            Self::Claude => "claude",
            Self::Grok => "grok",
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Chatgpt => "ChatGPT",
            Self::Claude => "Claude",
            Self::Grok => "Grok",
        }
    }
}

impl FromStr for AgentProvider {
    type Err = ApiError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "chatgpt" => Ok(Self::Chatgpt),
            "claude" => Ok(Self::Claude),
            "grok" => Ok(Self::Grok),
            _ => Err(ApiError::Internal),
        }
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
    refresh_token_expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
enum AuthorizationSecret {
    Chatgpt {
        device_auth_id: String,
        user_code: String,
    },
    Claude {
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

#[derive(Debug, Deserialize)]
struct CodexDeviceResponse {
    device_auth_id: String,
    user_code: String,
    #[serde(default)]
    expires_in: Option<i64>,
    #[serde(default)]
    expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    interval: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CodexPollResponse {
    authorization_code: String,
    code_verifier: String,
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
         RETURNING id, provider, status, account_label, plan, failure_message, created_at, updated_at",
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
        "SELECT id, provider, status, account_label, plan, failure_message, created_at, updated_at
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

    if status == AgentConnectionStatus::Pending {
        return poll_pending_connection(&state, row).await.map(Json);
    }
    if status == AgentConnectionStatus::Connected {
        return refresh_connected_connection(&state, row).await.map(Json);
    }

    connection_from_row(row, None).map(Json)
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
    let AuthorizationSecret::Claude {
        code_verifier,
        redirect_uri,
        state: expected_state,
        ..
    } = secret
    else {
        return Err(ApiError::Validation(
            "This provider completes automatically; keep the dialog open while it polls.",
        ));
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

    let token = exchange_claude_code(
        &state,
        &code,
        &code_verifier,
        &redirect_uri,
        &expected_state,
    )
    .await?;
    finish_connection(&state, row, token).await.map(Json)
}

#[utoipa::path(
    delete,
    path = "/agent-connections/{connection_id}",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 204, description = "Connection credential removed"),
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
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    sqlx::query("DELETE FROM agent_connection_authorizations WHERE connection_id = $1")
        .bind(connection_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query("DELETE FROM agent_connection_credentials WHERE connection_id = $1")
        .bind(connection_id)
        .execute(&mut *transaction)
        .await
        .map_err(database_error)?;
    sqlx::query(
        "UPDATE agent_connections SET status = 'disconnected', account_label = NULL,
         plan = NULL, failure_message = NULL, updated_at = NOW() WHERE id = $1",
    )
    .bind(connection_id)
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
        AgentProvider::Chatgpt => start_codex_authorization(state).await,
        AgentProvider::Claude => start_claude_authorization(state),
        AgentProvider::Grok => start_grok_authorization(state).await,
    }
}

async fn start_codex_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let url = format!(
        "{}/api/accounts/deviceauth/usercode",
        state.config.codex_issuer
    );
    let response = state
        .http
        .post(url)
        .header("originator", "codex_cli_rs")
        .header("user-agent", "codex_cli_rs/0.153.4")
        .json(&serde_json::json!({ "client_id": CODEX_CLIENT_ID }))
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Chatgpt, error))?;
    let status = response.status();
    if !status.is_success() {
        eprintln!("ChatGPT device authorization returned HTTP {status}");
        return Err(upstream_status_error(AgentProvider::Chatgpt, status));
    }
    let payload = response
        .json::<CodexDeviceResponse>()
        .await
        .map_err(|_| upstream_payload_error(AgentProvider::Chatgpt))?;
    let expires_at = payload.expires_at.unwrap_or_else(|| {
        Utc::now() + Duration::seconds(payload.expires_in.unwrap_or(DEFAULT_DEVICE_EXPIRY_SECONDS))
    });
    let prompt_url = format!(
        "{}/codex/device?user_code={}",
        state.config.codex_issuer,
        url_encode(&payload.user_code)
    );

    Ok(StartedAuthorization {
        expires_at,
        poll_after_seconds: poll_seconds(payload.interval.as_ref()),
        prompt_url,
        requires_callback_url: false,
        user_code: Some(payload.user_code.clone()),
        secret: AuthorizationSecret::Chatgpt {
            device_auth_id: payload.device_auth_id,
            user_code: payload.user_code,
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

async fn start_grok_authorization(state: &AppState) -> Result<StartedAuthorization, ApiError> {
    let url = format!(
        "{}/oauth2/device/{}-surfacegrok-build",
        state.config.grok_issuer, GROK_CLIENT_ID
    );
    let response = state
        .http
        .post(url)
        .header("user-agent", "xai-grok-build/1.0.13")
        .header("accept", "application/json")
        .header("x-grok-client-version", "1.0.13")
        .header("x-grok-client-identifier", "grok-shell")
        .send()
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Grok, error))?;
    let status = response.status();
    if !status.is_success() {
        eprintln!("Grok device authorization returned HTTP {status}");
        return Err(upstream_status_error(AgentProvider::Grok, status));
    }
    let payload = response
        .json::<GrokDeviceResponse>()
        .await
        .map_err(|_| upstream_payload_error(AgentProvider::Grok))?;
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
        return fail_connection(state, row, "Authorization expired. Start again.").await;
    }
    let secret: AuthorizationSecret = decrypt_json(
        &state.config.credential_encryption_key,
        &authorization.secret_ciphertext,
        &authorization.secret_nonce,
    )?;

    match secret {
        AuthorizationSecret::Chatgpt {
            device_auth_id,
            user_code,
        } => {
            let response = state
                .http
                .post(format!(
                    "{}/api/accounts/deviceauth/token",
                    state.config.codex_issuer
                ))
                .header("originator", "codex_cli_rs")
                .header("user-agent", "codex_cli_rs/0.153.4")
                .json(&serde_json::json!({
                    "device_auth_id": device_auth_id,
                    "user_code": user_code,
                }))
                .send()
                .await
                .map_err(|error| upstream_network_error(AgentProvider::Chatgpt, error))?;
            if response.status().is_success() {
                let approval = response
                    .json::<CodexPollResponse>()
                    .await
                    .map_err(|_| upstream_payload_error(AgentProvider::Chatgpt))?;
                let token = exchange_codex_code(state, approval).await?;
                return finish_connection(state, row, token).await;
            }
            if response.status().is_client_error() {
                return connection_from_row(
                    row,
                    Some(AgentAuthorizationPrompt {
                        authorization_url: format!(
                            "{}/codex/device?user_code={}",
                            state.config.codex_issuer,
                            url_encode(&user_code)
                        ),
                        expires_at: authorization.expires_at,
                        poll_after_seconds: DEFAULT_POLL_SECONDS,
                        requires_callback_url: false,
                        user_code: Some(user_code),
                    }),
                );
            }
            Err(upstream_status_error(
                AgentProvider::Chatgpt,
                response.status(),
            ))
        }
        AuthorizationSecret::Grok {
            device_code,
            user_code,
            verification_uri_complete,
        } => {
            let response = state
                .http
                .post(format!("{}/oauth2/token", state.config.grok_issuer))
                .header("user-agent", "xai-grok-build/1.0.13")
                .header("x-grok-client-version", "1.0.13")
                .form(&[
                    ("client_id", GROK_CLIENT_ID),
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
    }
}

async fn exchange_codex_code(
    state: &AppState,
    approval: CodexPollResponse,
) -> Result<Value, ApiError> {
    let response = state
        .http
        .post(format!("{}/oauth/token", state.config.codex_issuer))
        .header("user-agent", "codex_cli_rs/0.153.4")
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", CODEX_CLIENT_ID),
            ("code", approval.authorization_code.as_str()),
            ("code_verifier", approval.code_verifier.as_str()),
            (
                "redirect_uri",
                "https://auth.openai.com/deviceauth/callback",
            ),
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
    token: Value,
) -> Result<AgentConnection, ApiError> {
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
    let (account_label, plan) = connection_metadata(&token);
    let mut transaction = state.pool.begin().await.map_err(database_error)?;

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
    .bind(row.id)
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
    let updated = sqlx::query_as::<_, ConnectionRow>(
        "UPDATE agent_connections SET status = 'connected', account_label = $2, plan = $3,
         failure_message = NULL, updated_at = NOW() WHERE id = $1
         RETURNING id, provider, status, account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(row.id)
    .bind(account_label)
    .bind(plan)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    connection_from_row(updated, None)
}

fn connection_metadata(token: &Value) -> (Option<String>, Option<String>) {
    let claims = token_claims(token);
    let account_label = token
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
        .map(mask_account_label);
    let plan = token
        .get("subscription_type")
        .or_else(|| token.get("rate_limit_tier"))
        .or_else(|| token.get("plan"))
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
            })
        })
        .and_then(Value::as_str)
        .map(normalize_plan_label);

    (account_label, plan)
}

fn normalize_plan_label(value: &str) -> String {
    match value.trim().to_ascii_lowercase().as_str() {
        "k12" => "K12".to_owned(),
        "max" => "Max".to_owned(),
        "plus" => "Plus".to_owned(),
        _ => value.trim().to_owned(),
    }
}

async fn refresh_connected_connection(
    state: &AppState,
    row: ConnectionRow,
) -> Result<AgentConnection, ApiError> {
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at FROM agent_connection_credentials
         WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(row.id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Internal)?;

    let should_refresh = credential
        .access_token_expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now() + Duration::minutes(5));
    if !should_refresh {
        transaction.commit().await.map_err(database_error)?;
        return connection_from_row(row, None);
    }
    if credential
        .refresh_token_expires_at
        .is_some_and(|expires_at| expires_at <= Utc::now())
    {
        transaction.rollback().await.map_err(database_error)?;
        return fail_connection(state, row, "Provider authorization expired. Connect again.").await;
    }

    let stored_token: Value = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;
    let refresh_token = stored_token
        .get("refresh_token")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            ApiError::Provider(
                "The provider session cannot be refreshed. Connect the account again.".to_owned(),
            )
        })?;
    let provider = AgentProvider::from_str(&row.provider)?;
    let refreshed = refresh_provider_token(state, provider, refresh_token, &stored_token).await?;
    let merged = merge_token_response(stored_token, refreshed);
    let (credential_ciphertext, credential_nonce) =
        encrypt_json(&state.config.credential_encryption_key, &merged)?;
    let access_token_expires_at = merged
        .get("expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds));
    let refresh_token_expires_at = merged
        .get("refresh_token_expires_in")
        .and_then(Value::as_i64)
        .map(|seconds| Utc::now() + Duration::seconds(seconds))
        .or(credential.refresh_token_expires_at);
    let (account_label, plan) = connection_metadata(&merged);

    sqlx::query(
        "UPDATE agent_connection_credentials SET credential_ciphertext = $2,
         credential_nonce = $3, access_token_expires_at = $4,
         refresh_token_expires_at = $5, updated_at = NOW() WHERE connection_id = $1",
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
            updated_at = NOW()
         WHERE id = $1",
    )
    .bind(row.id)
    .bind(account_label)
    .bind(plan)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    let updated = owned_connection_by_id(state, row.id).await?;
    connection_from_row(updated, None)
}

pub(crate) async fn provider_credential(
    state: &AppState,
    connection_id: Uuid,
) -> Result<(AgentProvider, Value), ApiError> {
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }

    refresh_connected_connection(state, row).await?;
    let row = owned_connection_by_id(state, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Forbidden);
    }
    let credential = sqlx::query_as::<_, CredentialRow>(
        "SELECT credential_ciphertext, credential_nonce, access_token_expires_at,
         refresh_token_expires_at FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Forbidden)?;
    let token = decrypt_json(
        &state.config.credential_encryption_key,
        &credential.credential_ciphertext,
        &credential.credential_nonce,
    )?;

    Ok((AgentProvider::from_str(&row.provider)?, token))
}

async fn refresh_provider_token(
    state: &AppState,
    provider: AgentProvider,
    refresh_token: &str,
    stored_token: &Value,
) -> Result<Value, ApiError> {
    let response = match provider {
        AgentProvider::Chatgpt => {
            state
                .http
                .post(format!("{}/oauth/token", state.config.codex_issuer))
                .header("user-agent", "codex_cli_rs/0.153.4")
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
        AgentProvider::Grok => {
            state
                .http
                .post(format!("{}/oauth2/token", state.config.grok_issuer))
                .header("user-agent", "xai-grok-build/1.0.13")
                .header("x-grok-client-version", "1.0.13")
                .form(&[
                    ("grant_type", "refresh_token"),
                    ("client_id", GROK_CLIENT_ID),
                    ("refresh_token", refresh_token),
                ])
                .send()
                .await
        }
    }
    .map_err(|error| upstream_network_error(provider, error))?;

    parse_token_response(provider, response).await
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
        "UPDATE agent_connections SET status = 'failed', failure_message = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id, provider, status, account_label, plan, failure_message, created_at, updated_at",
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
        "SELECT id, provider, status, account_label, plan, failure_message, created_at, updated_at
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
        "SELECT id, provider, status, account_label, plan, failure_message, created_at, updated_at
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

fn poll_seconds(value: Option<&Value>) -> u64 {
    value
        .and_then(|value| {
            value
                .as_u64()
                .or_else(|| value.as_str().and_then(|value| value.parse().ok()))
        })
        .unwrap_or(DEFAULT_POLL_SECONDS)
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
    let visible = local.chars().take(3).collect::<String>();
    format!("{visible}*******@{domain}")
}

fn token_claims(token: &Value) -> Option<Value> {
    ["id_token", "access_token"].into_iter().find_map(|field| {
        let encoded = token.get(field)?.as_str()?.split('.').nth(1)?;
        let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
        serde_json::from_slice(&decoded).ok()
    })
}

fn validate_prompt_url(issuer: &str, prompt_url: &str) -> Result<(), ApiError> {
    let issuer = Url::parse(issuer).map_err(|_| ApiError::Internal)?;
    let prompt = Url::parse(prompt_url).map_err(|_| upstream_payload_error(AgentProvider::Grok))?;
    let same_origin = issuer.scheme() == prompt.scheme()
        && issuer.host_str() == prompt.host_str()
        && issuer.port_or_known_default() == prompt.port_or_known_default();
    same_origin
        .then_some(())
        .ok_or_else(|| upstream_payload_error(AgentProvider::Grok))
}

fn url_encode(value: &str) -> String {
    Url::parse_with_params("https://hub.invalid", &[("user_code", value)])
        .expect("static URL should parse")
        .query()
        .and_then(|query| query.strip_prefix("user_code="))
        .unwrap_or_default()
        .to_owned()
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
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    use serde_json::json;

    use super::{
        AuthorizationSecret, CodexDeviceResponse, connection_metadata, decrypt_json, encrypt_json,
        mask_account_label, merge_token_response, parse_callback_value, poll_seconds,
        start_claude_authorization, token_claims,
    };
    use crate::AppConfig;

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

    #[test]
    fn codex_device_payload_accepts_the_live_string_interval_and_expiry() {
        let payload: CodexDeviceResponse = serde_json::from_value(json!({
            "device_auth_id": "device-secret",
            "user_code": "ABCD-EFGH",
            "interval": "5",
            "expires_at": "2026-09-10T01:00:00Z"
        }))
        .unwrap();

        assert_eq!(poll_seconds(payload.interval.as_ref()), 5);
        assert_eq!(
            payload.expires_at.unwrap().to_rfc3339(),
            "2026-09-10T01:00:00+00:00"
        );
    }

    #[test]
    fn account_labels_are_masked_before_browser_storage() {
        assert_eq!(
            mask_account_label("duy@example.com"),
            "duy*******@example.com"
        );
        assert_eq!(mask_account_label("not-an-email"), "connected account");
        assert_eq!(json!({ "masked": true })["masked"], true);
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
                connection_metadata(&json!({ "id_token": token })),
                (
                    Some("own*******@example.com".to_owned()),
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
}
