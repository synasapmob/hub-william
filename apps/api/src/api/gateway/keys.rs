//! Gateway keys: create, list and revoke them, and authenticate a request by its
//! key. A key belongs to one product. A workspace key is served by its owner's
//! own accounts and pools, and an organization key by the agents that
//! organization shares; both cost nothing. A service key is served only by the
//! platform's stock of accounts and is charged to its owner's service wallet. A
//! request is told apart by the key it presents.

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
use sqlx::{FromRow, PgPool};
use utoipa::ToSchema;
use uuid::Uuid;

use super::database_error;
use crate::{
    api::auth::authenticated_user_id,
    core::{ApiError, AppState},
};

/// The product a key belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KeyKind {
    /// The Workspace's: the owner's own accounts and pools.
    Workspace,
    /// An organization's: the agents that organization shares.
    Organization,
    /// The Service's: the platform's stock, charged to the owner's wallet.
    Service,
    /// A ticket's: the one account its listing sold, free, until it expires.
    Ticket,
}

impl KeyKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Organization => "organization",
            Self::Service => "service",
            Self::Ticket => "ticket",
        }
    }

    /// What every key of this kind starts with, so a person can tell them apart.
    fn prefix(self) -> &'static str {
        match self {
            Self::Workspace => "hw_live_",
            Self::Organization => "hw_org_",
            Self::Service => "hw_svc_",
            Self::Ticket => "hw_tkt_",
        }
    }
}

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
    kind: String,
}

impl AuthorizedGatewayKey {
    /// Whether the key is a service key.
    pub(super) fn is_service(&self) -> bool {
        self.kind == KeyKind::Service.as_str()
    }
}

/// Creates a key of `kind` for `user_id` and returns it; the key itself is shown
/// only here, since only its hash is kept. An organization key names its
/// organization, and no other kind does.
pub(crate) async fn create_key_of_kind(
    pool: &PgPool,
    user_id: Uuid,
    kind: KeyKind,
    organization_id: Option<Uuid>,
) -> Result<CreatedGatewayKey, ApiError> {
    let key = generate_gateway_key(kind);
    let key_hash = hash_gateway_key(&key);
    let last_four: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let row = sqlx::query_as::<_, GatewayKeyRow>(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four, kind, organization_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, last_four, created_at, last_used_at",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(key_hash)
    .bind(last_four)
    .bind(kind.as_str())
    .bind(organization_id)
    .fetch_one(pool)
    .await
    .map_err(database_error)?;

    Ok(CreatedGatewayKey {
        metadata: gateway_key_from_row(row),
        key,
    })
}

/// Makes the key a customer gets for the ticket `listing_id`, inside the
/// transaction that charges them for it, so a key never exists without its sale. It
/// belongs to `user_id` and stops working at `expires_at`; it is shown once, here.
pub(crate) async fn create_ticket_key(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    user_id: Uuid,
    listing_id: Uuid,
    expires_at: DateTime<Utc>,
) -> Result<CreatedGatewayKey, ApiError> {
    let key = generate_gateway_key(KeyKind::Ticket);
    let last_four: String = key
        .chars()
        .rev()
        .take(4)
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let row = sqlx::query_as::<_, GatewayKeyRow>(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four, kind, listing_id, expires_at)
         VALUES ($1, $2, $3, $4, 'ticket', $5, $6)
         RETURNING id, last_four, created_at, last_used_at",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(hash_gateway_key(&key))
    .bind(last_four)
    .bind(listing_id)
    .bind(expires_at)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;

    Ok(CreatedGatewayKey {
        metadata: gateway_key_from_row(row),
        key,
    })
}

/// The active keys of `kind` that `user_id` owns, newest first; for an
/// organization, those of that organization.
pub(crate) async fn list_keys_of_kind(
    pool: &PgPool,
    user_id: Uuid,
    kind: KeyKind,
    organization_id: Option<Uuid>,
) -> Result<Vec<GatewayKey>, ApiError> {
    let rows = sqlx::query_as::<_, GatewayKeyRow>(
        "SELECT id, last_four, created_at, last_used_at
         FROM gateway_keys
         WHERE user_id = $1 AND kind = $2 AND revoked_at IS NULL
           AND organization_id IS NOT DISTINCT FROM $3
         ORDER BY created_at DESC",
    )
    .bind(user_id)
    .bind(kind.as_str())
    .bind(organization_id)
    .fetch_all(pool)
    .await
    .map_err(database_error)?;

    Ok(rows.into_iter().map(gateway_key_from_row).collect())
}

/// Revokes a key of `kind` that `user_id` owns (in that organization, for an
/// organization key); a key of another kind is not found.
pub(crate) async fn revoke_key_of_kind(
    pool: &PgPool,
    user_id: Uuid,
    key_id: Uuid,
    kind: KeyKind,
    organization_id: Option<Uuid>,
) -> Result<(), ApiError> {
    let result = sqlx::query(
        "UPDATE gateway_keys SET revoked_at = NOW()
         WHERE id = $1 AND user_id = $2 AND kind = $3 AND revoked_at IS NULL
           AND organization_id IS NOT DISTINCT FROM $4",
    )
    .bind(key_id)
    .bind(user_id)
    .bind(kind.as_str())
    .bind(organization_id)
    .execute(pool)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }

    Ok(())
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

    Ok((
        StatusCode::CREATED,
        Json(create_key_of_kind(&state.pool, user_id, KeyKind::Workspace, None).await?),
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

    Ok(Json(
        list_keys_of_kind(&state.pool, user_id, KeyKind::Workspace, None).await?,
    ))
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
    revoke_key_of_kind(&state.pool, user_id, key_id, KeyKind::Workspace, None).await?;

    Ok(StatusCode::NO_CONTENT)
}

/// The gateway key a request presents, if it is shaped like one of either kind.
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
        .filter(|value| {
            value.len() > 24
                && [
                    KeyKind::Workspace,
                    KeyKind::Organization,
                    KeyKind::Service,
                    KeyKind::Ticket,
                ]
                .iter()
                .any(|kind| value.starts_with(kind.prefix()))
        })
}

pub(super) async fn authorize_gateway_key(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<AuthorizedGatewayKey, ApiError> {
    let key = gateway_key_from_headers(headers).ok_or(ApiError::GatewayUnauthorized)?;
    let key_hash = hash_gateway_key(key);
    let authorized = sqlx::query_as::<_, AuthorizedGatewayKey>(
        "SELECT id, user_id, organization_id, kind FROM gateway_keys
         WHERE key_hash = $1 AND revoked_at IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())",
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

fn gateway_key_from_row(row: GatewayKeyRow) -> GatewayKey {
    GatewayKey {
        created_at: row.created_at,
        id: row.id,
        last_four: row.last_four,
        last_used_at: row.last_used_at,
    }
}

fn generate_gateway_key(kind: KeyKind) -> String {
    let mut secret = [0_u8; 32];
    rand::thread_rng().fill_bytes(&mut secret);
    format!("{}{}", kind.prefix(), URL_SAFE_NO_PAD.encode(secret))
}

pub(super) fn hash_gateway_key(key: &str) -> Vec<u8> {
    Sha256::digest(key.as_bytes()).to_vec()
}
