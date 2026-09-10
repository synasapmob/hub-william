use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

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
