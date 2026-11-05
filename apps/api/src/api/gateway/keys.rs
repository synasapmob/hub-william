//! Hub keys: create, list and revoke them, and authenticate a request by its key.

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
};
use axum_extra::extract::CookieJar;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use super::database_error;
use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
};

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
pub(super) struct AuthorizedGatewayKey {
    pub(super) id: Uuid,
    pub(super) user_id: Uuid,
    pub(super) organization_id: Option<Uuid>,
}

#[utoipa::path(
    post,
    path = "/gateway-keys",
    responses(
        (status = 201, description = "Gateway key created and returned once", body = CreatedGatewayKey),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Connected provider not found", body = crate::core::ErrorResponse)
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
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse)
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
        (status = 404, description = "Gateway key not found", body = crate::core::ErrorResponse)
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

/// The gateway key a request presents, if it is shaped like one.
pub(crate) fn gateway_key_from_headers(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .or_else(|| {
            headers
                .get("x-goog-api-key")
                .and_then(|value| value.to_str().ok())
        })
        .filter(|value| value.starts_with("hw_live_") && value.len() > 24)
}

pub(super) async fn authorize_gateway_key(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthorizedGatewayKey, ApiError> {
    let key = gateway_key_from_headers(headers).ok_or(ApiError::GatewayUnauthorized)?;
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

fn generate_gateway_key() -> String {
    let mut secret = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    format!("hw_live_{}", URL_SAFE_NO_PAD.encode(secret))
}

pub(super) fn hash_gateway_key(key: &str) -> Vec<u8> {
    Sha256::digest(key.as_bytes()).to_vec()
}
