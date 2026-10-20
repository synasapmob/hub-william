use axum::{
    Router,
    middleware::from_fn_with_state,
    routing::{get, post},
};
use utoipa::OpenApi;

use crate::core::{AppState, rate_limit::limit_by_ip};

use crate::api::limits::{Limit, ip_limit};

use super::{download, resolve, stream};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    let resolve_limit = ip_limit(state, Limit::ReelResolve);
    // Stream and download share one budget: both pull the same video.
    let media_limit = ip_limit(state, Limit::ReelMedia);

    Router::new()
        .route(
            "/reel/resolve",
            post(resolve).layer(from_fn_with_state(resolve_limit, limit_by_ip)),
        )
        .route(
            "/reel/stream",
            get(stream).layer(from_fn_with_state(media_limit.clone(), limit_by_ip)),
        )
        .route(
            "/reel/download",
            get(download).layer(from_fn_with_state(media_limit, limit_by_ip)),
        )
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
