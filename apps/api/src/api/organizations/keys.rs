//! The keys of an organization: made, listed and revoked on its Agents page, and
//! used at the gateway, where a request that presents one is served only by the
//! agents the organization shares and is counted in its usage. A member makes
//! and sees only their own keys, and they work only while the member is still in
//! the organization.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use uuid::Uuid;

use super::organization_for_user;
use crate::{
    api::{
        auth::authenticated_user_id,
        gateway::{
            CreatedGatewayKey, GatewayKey, KeyKind, create_key_of_kind, list_keys_of_kind,
            revoke_key_of_kind,
        },
    },
    core::{ApiError, AppState},
};

/// A member may hold this many keys of one organization at once.
const MAX_ACTIVE_KEYS: usize = 20;

#[utoipa::path(
    post,
    path = "/organizations/{id}/gateway-keys",
    params(("id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 201, description = "Organization key created and returned once", body = CreatedGatewayKey),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The user is not a member of the organization", body = crate::core::ErrorResponse),
        (status = 422, description = "The member already holds the most keys allowed", body = crate::core::ErrorResponse)
    ),
    tag = "organizations"
)]
pub async fn create_organization_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
) -> Result<(StatusCode, Json<CreatedGatewayKey>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    organization_for_user(&state, org_id, user_id).await?;
    let held = list_keys_of_kind(&state.pool, user_id, KeyKind::Organization, Some(org_id))
        .await?
        .len();
    if held >= MAX_ACTIVE_KEYS {
        return Err(ApiError::Validation(
            "You hold the most keys of this organization allowed. Revoke one first.",
        ));
    }

    Ok((
        StatusCode::CREATED,
        Json(create_key_of_kind(&state.pool, user_id, KeyKind::Organization, Some(org_id)).await?),
    ))
}

#[utoipa::path(
    get,
    path = "/organizations/{id}/gateway-keys",
    params(("id" = Uuid, Path, description = "Organization ID")),
    responses(
        (status = 200, description = "The signed-in member's active keys of this organization, newest first", body = [GatewayKey]),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The user is not a member of the organization", body = crate::core::ErrorResponse)
    ),
    tag = "organizations"
)]
pub async fn list_organization_keys(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<GatewayKey>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    organization_for_user(&state, org_id, user_id).await?;

    Ok(Json(
        list_keys_of_kind(&state.pool, user_id, KeyKind::Organization, Some(org_id)).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/organizations/{id}/gateway-keys/{key_id}",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("key_id" = Uuid, Path, description = "Key ID")
    ),
    responses(
        (status = 204, description = "Organization key revoked"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Key not found", body = crate::core::ErrorResponse)
    ),
    tag = "organizations"
)]
pub async fn revoke_organization_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((org_id, key_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    revoke_key_of_kind(
        &state.pool,
        user_id,
        key_id,
        KeyKind::Organization,
        Some(org_id),
    )
    .await?;

    Ok(StatusCode::NO_CONTENT)
}
