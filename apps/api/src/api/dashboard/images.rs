use axum::{
    Json,
    body::Bytes,
    extract::{Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use axum_extra::extract::CookieJar;
use serde::Serialize;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::core::{ApiError, AppState};

use super::{
    access::{Permission, authorize, staff_member},
    database_error,
};

/// The most a picture may weigh; the column enforces the same limit.
pub(crate) const MAXIMUM_IMAGE_BYTES: usize = 5 * 1024 * 1024;

/// What the bytes are, read from the bytes. A client says what it uploads, but
/// the type served back is decided here, so a file cannot pass for a picture.
pub(crate) fn image_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UploadedImage {
    pub id: Uuid,
}

#[utoipa::path(
    post,
    path = "/dashboard/images",
    request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "A PNG, JPEG, GIF or WebP picture of at most 5 MiB"),
    responses(
        (status = 201, description = "The picture was stored", body = UploadedImage),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 413, description = "The picture is over 5 MiB"),
        (status = 422, description = "The body is not a PNG, JPEG, GIF or WebP picture", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn upload_image(
    State(state): State<AppState>,
    jar: CookieJar,
    body: Bytes,
) -> Result<(StatusCode, Json<UploadedImage>), ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;

    if body.len() > MAXIMUM_IMAGE_BYTES {
        return Err(ApiError::Validation("A picture may weigh at most 5 MiB."));
    }
    let content_type = image_type(&body).ok_or(ApiError::Validation(
        "A picture must be a PNG, JPEG, GIF or WebP file.",
    ))?;

    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO dashboard_images (id, content_type, data, uploaded_by)
         VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(content_type)
    .bind(body.as_ref())
    .bind(user.id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;

    Ok((StatusCode::CREATED, Json(UploadedImage { id })))
}

#[utoipa::path(
    get,
    path = "/dashboard/images/{id}",
    params(("id" = Uuid, Path, description = "The picture")),
    responses(
        (status = 200, description = "The picture", content_type = "image/*"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "Not a member of staff", body = crate::core::ErrorResponse),
        (status = 404, description = "No such picture", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn get_image(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
) -> Result<Response, ApiError> {
    staff_member(&state, &jar).await?;

    let (content_type, data) = sqlx::query_as::<_, (String, Vec<u8>)>(
        "SELECT content_type, data FROM dashboard_images WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    // The id cannot be guessed and the bytes never change, so a browser may keep
    // them; `nosniff` stops it from second-guessing the type.
    Ok((
        [
            (header::CONTENT_TYPE, content_type.as_str()),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
            (
                header::CACHE_CONTROL,
                "private, max-age=31536000, immutable",
            ),
        ],
        data,
    )
        .into_response())
}
