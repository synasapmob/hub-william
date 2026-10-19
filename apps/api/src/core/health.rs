use axum::{Json, Router, routing::get};
use serde::Serialize;
use utoipa::ToSchema;

use super::AppState;

#[derive(Debug, PartialEq, Serialize, ToSchema)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
}

#[utoipa::path(
    get,
    path = "/health",
    responses(
        (status = 200, description = "Backend is ready to accept requests", body = HealthResponse)
    ),
    tag = "system"
)]
pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        service: "hub-william-backend",
    })
}

pub(crate) fn routes() -> Router<AppState> {
    Router::new().route("/health", get(health))
}
