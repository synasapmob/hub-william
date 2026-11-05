//! What an owner does with a connection once it exists: list, read, refresh, redeem
//! credits and disconnect.

use std::str::FromStr;

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

use super::{
    AgentAuthorizationPrompt, AgentConnection, AgentConnectionStatus, ConnectionRow,
    authorize::{poll_pending_connection, start_connection_reauthorization},
    credentials::provider_credential,
    database_error,
    refresh::{CredentialRefreshMode, RefreshConnectionOutcome, refresh_detached},
};
use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

#[derive(Debug, FromRow)]
pub(super) struct AuthorizationRow {
    pub(super) expires_at: DateTime<Utc>,
    pub(super) secret_ciphertext: Vec<u8>,
    pub(super) secret_nonce: Vec<u8>,
}

#[utoipa::path(
    get,
    path = "/agent-connections",
    responses(
        (status = 200, description = "Current user's provider connections", body = [AgentConnection]),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn list_connections(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<AgentConnection>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at
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
        (status = 404, description = "Connection not found", body = crate::core::ErrorResponse)
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
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Connection not found", body = crate::core::ErrorResponse),
        (status = 502, description = "Provider refresh unavailable", body = crate::core::ErrorResponse)
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
    path = "/agent-connections/{connection_id}/reset-credits",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 204, description = "One banked ChatGPT reset credit was redeemed"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Connection not found", body = crate::core::ErrorResponse),
        (status = 422, description = "This account has no reset credits", body = crate::core::ErrorResponse),
        (status = 502, description = "OpenAI reset credits are unavailable", body = crate::core::ErrorResponse)
    ),
    tag = "agent connections"
)]
pub async fn reset_connection_credits(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let row = owned_connection(&state, user_id, connection_id).await?;
    if AgentConnectionStatus::from_str(&row.status)? != AgentConnectionStatus::Connected {
        return Err(ApiError::Validation(
            "Only a connected account can use reset credits.",
        ));
    }
    if AgentProvider::from_str(&row.provider)? != AgentProvider::Chatgpt {
        return Err(ApiError::Validation(
            "Only ChatGPT accounts have reset credits.",
        ));
    }
    let (_, token) = provider_credential(&state, connection_id).await?;
    let Some(access_token) = token.get("access_token").and_then(Value::as_str) else {
        return Err(ApiError::Provider(
            "This account has no access token.".to_owned(),
        ));
    };
    crate::api::agent::usage::reset_chatgpt_credits(&state, &token, access_token).await?;

    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    delete,
    path = "/agent-connections/{connection_id}",
    params(("connection_id" = Uuid, Path, description = "Agent connection ID")),
    responses(
        (status = 204, description = "Connected account pool deleted"),
        (status = 404, description = "Connection not found", body = crate::core::ErrorResponse)
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

pub(super) async fn fail_connection(
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
         RETURNING id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at",
    )
    .bind(row.id)
    .bind(message)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    connection_from_row(updated, None)
}

pub(super) async fn owned_connection(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at
         FROM agent_connections WHERE id = $1 AND user_id = $2",
    )
    .bind(connection_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

pub(super) async fn owned_connection_by_id(
    state: &AppState,
    connection_id: Uuid,
) -> Result<ConnectionRow, ApiError> {
    sqlx::query_as::<_, ConnectionRow>(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message, validation_url, created_at, updated_at
         FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

pub(super) async fn load_authorization(
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

pub(super) fn connection_from_row(
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
        validation_url: row.validation_url,
    })
}
