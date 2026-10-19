use axum::{
    Json,
    body::Body,
    http::{StatusCode, header},
    response::Response,
};

use crate::{
    core::ApiError,
    utils::tts::{TtsRequest, synthesize_speech},
};

mod routes;
pub(crate) use routes::{TtsApi, routes};

#[utoipa::path(
    post,
    path = "/tts",
    request_body = TtsRequest,
    responses(
        (status = 200, description = "Generated MP3 audio", content_type = "audio/mpeg"),
        (status = 400, body = crate::core::ErrorResponse),
        (status = 502, body = crate::core::ErrorResponse)
    ),
    tag = "tools"
)]
pub async fn synthesize(Json(request): Json<TtsRequest>) -> Result<Response, ApiError> {
    let audio_bytes = synthesize_speech(&request).await?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "audio/mpeg")
        .header(header::CONTENT_LENGTH, audio_bytes.len().to_string())
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(audio_bytes))
        .map_err(|_| ApiError::Internal)?;

    Ok(response)
}
