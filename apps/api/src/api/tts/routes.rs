use axum::{Router, routing::post};
use utoipa::OpenApi;

use crate::core::AppState;

use super::synthesize;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/tts", post(synthesize))
}

#[derive(OpenApi)]
#[openapi(
    paths(super::synthesize),
    components(schemas(crate::utils::tts::TtsRequest))
)]
pub(crate) struct TtsApi;
