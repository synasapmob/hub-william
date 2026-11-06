//! Service keys: made, listed and revoked here, and used at the gateway, where a
//! request that presents one is served by the platform's stock and charged to the
//! key owner's wallet. They are not Hub keys: they never appear with them, and a
//! key of another kind cannot be revoked here.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use uuid::Uuid;

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

/// A user may hold this many service keys at once.
const MAX_ACTIVE_KEYS: usize = 20;

#[utoipa::path(
    post,
    path = "/service/keys",
    operation_id = "create_service_key",
    responses(
        (status = 201, description = "Service key created and returned once", body = CreatedGatewayKey),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 422, description = "The user already holds the most keys allowed", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn create_service_key(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(StatusCode, Json<CreatedGatewayKey>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let held = list_keys_of_kind(&state.pool, user_id, KeyKind::Service, None)
        .await?
        .len();
    if held >= MAX_ACTIVE_KEYS {
        return Err(ApiError::Validation(
            "You hold the most service keys allowed. Revoke one first.",
        ));
    }

    Ok((
        StatusCode::CREATED,
        Json(create_key_of_kind(&state.pool, user_id, KeyKind::Service, None).await?),
    ))
}

#[utoipa::path(
    get,
    path = "/service/keys",
    operation_id = "list_service_keys",
    responses(
        (status = 200, description = "The signed-in user's active service keys, newest first", body = [GatewayKey]),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn list_service_keys(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<GatewayKey>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;

    Ok(Json(
        list_keys_of_kind(&state.pool, user_id, KeyKind::Service, None).await?,
    ))
}

#[utoipa::path(
    delete,
    path = "/service/keys/{key_id}",
    operation_id = "revoke_service_key",
    params(("key_id" = Uuid, Path, description = "Service key ID")),
    responses(
        (status = 204, description = "Service key revoked"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 404, description = "Service key not found", body = crate::core::ErrorResponse)
    ),
    tag = "service"
)]
pub async fn revoke_service_key(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(key_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    revoke_key_of_kind(&state.pool, user_id, key_id, KeyKind::Service, None).await?;

    Ok(StatusCode::NO_CONTENT)
}
