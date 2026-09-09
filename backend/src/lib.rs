mod health;
mod openapi;

use axum::{Router, routing::get};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

pub use health::HealthResponse;
use health::health;
use openapi::ApiDoc;

pub fn app() -> Router {
    Router::new()
        .route("/health", get(health))
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use tower::ServiceExt;

    use super::app;

    #[tokio::test]
    async fn health_endpoint_identifies_the_service() {
        let response = app()
            .oneshot(
                Request::builder()
                    .uri("/health")
                    .body(Body::empty())
                    .expect("health request should be valid"),
            )
            .await
            .expect("health route should respond");

        assert_eq!(response.status(), StatusCode::OK);

        let body = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("health response should have a body");
        let payload: serde_json::Value =
            serde_json::from_slice(&body).expect("health response should be valid JSON");

        assert_eq!(payload["status"], "ok");
        assert_eq!(payload["service"], "hub-william-backend");
    }
}
