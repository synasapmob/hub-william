use axum::{Router, routing::get};
use utoipa::OpenApi;

use crate::core::AppState;

use super::health;

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health))
}

#[derive(OpenApi)]
#[openapi(
    paths(super::health),
    components(schemas(super::HealthResponse)),
    tags((name = "system", description = "Runtime health and diagnostics"))
)]
pub(crate) struct HealthApi;
