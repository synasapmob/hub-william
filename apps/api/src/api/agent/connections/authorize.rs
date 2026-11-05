//! Connecting a provider account: starting an authorization, completing it, and
//! storing the connection.

use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use reqwest::Url;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use super::{
    ANTIGRAVITY_CLIENT_VERSION, AgentAuthorizationPrompt, AgentConnection, CLAUDE_CLIENT_ID,
    CLAUDE_SCOPES, CODEX_CLIENT_ID, CompleteAuthorizationRequest, ConnectDeepseekRequest,
    ConnectGroqRequest, ConnectionRow, EXPIRED_AUTHORIZATION_PROMPT_MESSAGE,
    StartAgentConnectionRequest, database_error,
    manage::{connection_from_row, fail_connection, load_authorization, owned_connection},
    metadata::{
        connection_metadata, fetch_claude_profile, provider_account_identity,
        reauthorization_identity_matches,
    },
    refresh::next_regular_refresh_at,
    token::{decrypt_json, encrypt_json, provider_expiry_at, random_url_token},
    upstream_network_error, upstream_payload_error, upstream_status_error,
};
use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub(super) const CODEX_REDIRECT_URI: &str = "http://localhost:1455/auth/callback";
pub(super) const CODEX_SCOPES: &str =
    "openid profile email offline_access api.connectors.read api.connectors.invoke";

pub(super) const GEMINI_SCOPES: &str = "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs";
pub(super) const GROK_SCOPES: &str = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";
const GROK_CLIENT_SURFACE: &str = "grok-build";
const DEFAULT_DEVICE_EXPIRY_SECONDS: i64 = 900;
const DEFAULT_POLL_SECONDS: u64 = 5;

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "provider", rename_all = "snake_case")]
pub(super) enum AuthorizationSecret {
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

pub(super) struct StartedAuthorization {
    expires_at: DateTime<Utc>,
    poll_after_seconds: u64,
    pub(super) prompt_url: String,
    pub(super) requires_callback_url: bool,
    secret: AuthorizationSecret,
    pub(super) user_code: Option<String>,
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
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 502, description = "Provider authorization unavailable", body = crate::core::ErrorResponse)
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
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
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
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 422, description = "Invalid DeepSeek API key", body = crate::core::ErrorResponse),
        (status = 502, description = "DeepSeek validation unavailable", body = crate::core::ErrorResponse)
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
    responses((status = 201, body = AgentConnection), (status = 401, body = crate::core::ErrorResponse),
        (status = 422, body = crate::core::ErrorResponse), (status = 502, body = crate::core::ErrorResponse)),
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
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
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

pub(super) async fn start_connection_reauthorization(
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
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
    )
    .bind(row.id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    connection_from_row(updated, Some(prompt_from_started(started)))
}

#[utoipa::path(
    post,
    path = "/agent-connections/{connection_id}/complete",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    request_body = CompleteAuthorizationRequest,
    responses(
        (status = 200, description = "Authorization completed", body = AgentConnection),
        (status = 422, description = "Invalid callback URL", body = crate::core::ErrorResponse),
        (status = 502, description = "Provider rejected the exchange", body = crate::core::ErrorResponse)
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

pub(super) fn validate_api_key_input(value: &str) -> Result<&str, ApiError> {
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

pub(super) async fn validate_static_key(
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

pub(super) fn start_codex_authorization(
    state: &AppState,
) -> Result<StartedAuthorization, ApiError> {
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

pub(super) fn start_claude_authorization(
    state: &AppState,
) -> Result<StartedAuthorization, ApiError> {
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

pub(super) fn start_gemini_authorization(
    state: &AppState,
) -> Result<StartedAuthorization, ApiError> {
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

pub(super) async fn start_grok_authorization(
    state: &AppState,
) -> Result<StartedAuthorization, ApiError> {
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

pub(super) async fn poll_pending_connection(
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

pub(super) async fn exchange_gemini_code(
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

pub(super) fn gemini_code_assist_body(project: Option<&str>) -> Value {
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

pub(super) async fn parse_token_response(
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

pub(super) async fn finish_connection(
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
    let access_token_expires_at = provider_expiry_at(&token, "expires_in");
    let refresh_token_expires_at = provider_expiry_at(&token, "refresh_token_expires_in");
    let next_refresh_at = next_regular_refresh_at(Utc::now(), refresh_token_expires_at);
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
             refresh_token_expires_at, next_refresh_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (connection_id) DO UPDATE SET
            credential_ciphertext = EXCLUDED.credential_ciphertext,
            credential_nonce = EXCLUDED.credential_nonce,
            access_token_expires_at = EXCLUDED.access_token_expires_at,
            refresh_token_expires_at = EXCLUDED.refresh_token_expires_at,
            next_refresh_at = EXCLUDED.next_refresh_at,
            updated_at = NOW()",
    )
    .bind(target_id)
    .bind(credential_ciphertext)
    .bind(credential_nonce)
    .bind(access_token_expires_at)
    .bind(refresh_token_expires_at)
    .bind(next_refresh_at)
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
          retry_claimed_at = NULL, user_id = $4, validation_url = NULL,
          updated_at = NOW() WHERE id = $1
          RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
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

fn prompt_from_started(started: StartedAuthorization) -> AgentAuthorizationPrompt {
    AgentAuthorizationPrompt {
        authorization_url: started.prompt_url,
        expires_at: started.expires_at,
        poll_after_seconds: started.poll_after_seconds,
        requires_callback_url: started.requires_callback_url,
        user_code: started.user_code,
    }
}

pub(super) fn parse_callback_value(value: &str) -> Result<(String, Option<String>), ApiError> {
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

pub(super) fn grok_oauth_request(state: &AppState, path: &str) -> reqwest::RequestBuilder {
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

pub(super) fn validate_prompt_url(issuer: &str, prompt_url: &str) -> Result<(), ApiError> {
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
