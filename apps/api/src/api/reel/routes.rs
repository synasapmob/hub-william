use axum::{
    Router,
    routing::{get, post},
};
use utoipa::OpenApi;

use crate::core::AppState;

use super::{download, resolve, stream};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/reel/resolve", post(resolve))
        .route("/reel/stream", get(stream))
        .route("/reel/download", get(download))
}

#[derive(OpenApi)]
#[openapi(
    paths(super::resolve, super::stream, super::download),
    components(schemas(
        crate::utils::reel::ResolveRequest,
        crate::utils::reel::ResolvedVideo,
        crate::utils::reel::VideoVariant,
        crate::utils::reel::Platform
    ))
)]
pub(crate) struct ReelApi;
