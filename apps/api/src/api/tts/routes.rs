use axum::{Router, middleware::from_fn_with_state, routing::post};
use utoipa::OpenApi;

use crate::core::{AppState, rate_limit::limit_by_ip};

use crate::api::limits::{Limit, ip_limit};

use super::synthesize;

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    let limit = ip_limit(state, Limit::Tts);

    Router::new().route(
        "/tts",
        post(synthesize).layer(from_fn_with_state(limit, limit_by_ip)),
    )
}

#[derive(OpenApi)]
#[openapi(
    paths(super::synthesize),
    components(schemas(crate::utils::tts::TtsRequest))
)]
pub(crate) struct TtsApi;
