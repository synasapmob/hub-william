use axum::{
    Json,
    body::Body,
    extract::Query,
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde::Deserialize;
use utoipa::IntoParams;

use crate::{
    core::ApiError,
    utils::reel::{ResolveRequest, ResolvedVideo, open_media, resolve_video, safe_filename},
};

mod routes;
pub(crate) use routes::{ReelApi, routes};

#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub struct MediaQuery {
    /// Media URL returned by `/reel/resolve`.
    url: String,
    /// File name offered to the browser when downloading.
    filename: Option<String>,
}

#[utoipa::path(
    post,
    path = "/reel/resolve",
    request_body = ResolveRequest,
    responses(
        (status = 200, description = "Direct media URLs for the video", body = ResolvedVideo),
        (status = 422, body = crate::core::ErrorResponse),
        (status = 502, body = crate::core::ErrorResponse)
    ),
    tag = "tools"
)]
pub async fn resolve(Json(request): Json<ResolveRequest>) -> Result<Json<ResolvedVideo>, ApiError> {
    Ok(Json(resolve_video(&request).await?))
}

#[utoipa::path(
    get,
    path = "/reel/stream",
    params(MediaQuery),
    responses(
        (status = 200, description = "Video bytes", content_type = "video/mp4"),
        (status = 206, description = "Requested byte range", content_type = "video/mp4"),
        (status = 422, body = crate::core::ErrorResponse),
        (status = 502, body = crate::core::ErrorResponse),
        (status = 503, description = "Every relay slot is busy", body = crate::core::ErrorResponse)
    ),
    tag = "tools"
)]
pub async fn stream(
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    relay(query, &headers, false).await
}

#[utoipa::path(
    get,
    path = "/reel/download",
    params(MediaQuery),
    responses(
        (status = 200, description = "Video bytes as an attachment", content_type = "video/mp4"),
        (status = 206, description = "Requested byte range", content_type = "video/mp4"),
        (status = 422, body = crate::core::ErrorResponse),
        (status = 502, body = crate::core::ErrorResponse),
        (status = 503, description = "Every relay slot is busy", body = crate::core::ErrorResponse)
    ),
    tag = "tools"
)]
pub async fn download(
    Query(query): Query<MediaQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    relay(query, &headers, true).await
}

async fn relay(
    query: MediaQuery,
    headers: &HeaderMap,
    attachment: bool,
) -> Result<Response, ApiError> {
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok());
    let media = open_media(&query.url, range).await?;
    let upstream = &media.response;

    let mut response = Response::builder()
        .status(StatusCode::from_u16(upstream.status().as_u16()).map_err(|_| ApiError::Internal)?)
        .header(header::ACCEPT_RANGES, "bytes")
        .header(header::CACHE_CONTROL, "no-store");

    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .cloned()
        .unwrap_or_else(|| header::HeaderValue::from_static("video/mp4"));
    response = response.header(header::CONTENT_TYPE, content_type);
    for name in [header::CONTENT_LENGTH, header::CONTENT_RANGE] {
        if let Some(value) = upstream.headers().get(&name) {
            response = response.header(name, value.clone());
        }
    }
    if attachment {
        response = response.header(
            header::CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                safe_filename(query.filename.as_deref())
            ),
        );
    }

    response
        .body(Body::from_stream(media.into_body()))
        .map_err(|_| ApiError::Internal)
}
