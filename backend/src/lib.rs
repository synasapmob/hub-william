mod agent_pools;
mod auth;
mod config;
mod connections;
mod error;
mod gateway;
mod health;
mod openapi;

use axum::{
    Router,
    http::{
        Method,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    routing::{get, post},
};
use reqwest::Client;
use sqlx::PgPool;
use tower_http::cors::AllowOrigin;
use tower_http::cors::CorsLayer;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

pub use agent_pools::{
    AgentPool, AgentPoolJoinRequest, AgentPoolPerson, AgentPoolRequestStatus, AgentPoolUsageMetric,
    CreateAgentPoolJoinRequest, DecideAgentPoolJoinRequest,
};
use agent_pools::{create_request, decide_request, list as list_agent_pools};
pub use auth::{AuthenticatedUser, LoginRequest, RegisterRequest, SessionResponse};
use auth::{login, logout, refresh, register, session};
pub use config::AppConfig;
pub use connections::{
    AgentConnection, AgentConnectionStatus, AgentProvider, CompleteAuthorizationRequest,
    StartAgentConnectionRequest,
};
use connections::{complete_authorization, disconnect, get_connection, list_connections, start};
pub use error::ErrorResponse;
pub use gateway::{CreatedGatewayKey, GatewayKey};
use gateway::{
    claude_count_tokens, claude_messages, create_key, grok_chat, grok_models, list_keys,
    openai_responses, revoke_key,
};
pub use health::HealthResponse;
use health::health;
pub use openapi::ApiDoc;

#[derive(Clone)]
pub struct AppState {
    pub config: AppConfig,
    pub http: Client,
    pub pool: PgPool,
}

pub fn app(state: AppState) -> Router {
    let mut browser_origins = vec![state.config.frontend_origin.clone()];
    if !state.config.cookie_secure {
        for origin in [
            "http://localhost:5173".parse().expect("valid local origin"),
            "http://127.0.0.1:5173".parse().expect("valid local origin"),
        ] {
            if !browser_origins.contains(&origin) {
                browser_origins.push(origin);
            }
        }
    }
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::list(browser_origins))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([AUTHORIZATION, CONTENT_TYPE])
        .allow_credentials(true);

    Router::new()
        .route("/health", get(health))
        .route("/auth/register", post(register))
        .route("/auth/login", post(login))
        .route("/auth/session", get(session))
        .route("/auth/logout", post(logout))
        .route("/auth/refresh", post(refresh))
        .route("/agent-pools", get(list_agent_pools))
        .route(
            "/agent-pools/{connection_id}/requests",
            post(create_request),
        )
        .route(
            "/agent-pool-requests/{request_id}/decision",
            post(decide_request),
        )
        .route("/agent-connections", get(list_connections))
        .route("/agent-connections/start", post(start))
        .route(
            "/agent-connections/{connection_id}",
            get(get_connection).delete(disconnect),
        )
        .route(
            "/agent-connections/{connection_id}/complete",
            post(complete_authorization),
        )
        .route("/gateway-keys", get(list_keys).post(create_key))
        .route("/gateway-keys/{key_id}", axum::routing::delete(revoke_key))
        .route("/gateway/openai/v1/responses", post(openai_responses))
        .route("/gateway/claude/v1/messages", post(claude_messages))
        .route(
            "/gateway/claude/v1/messages/count_tokens",
            post(claude_count_tokens),
        )
        .route("/gateway/grok/v1/chat/completions", post(grok_chat))
        .route("/gateway/grok/v1/models", get(grok_models))
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(cors)
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use axum::{
        body::{Body, to_bytes},
        http::{Request, StatusCode},
    };
    use reqwest::Client;
    use tower::ServiceExt;

    use sqlx::postgres::PgPoolOptions;

    use super::{AppConfig, AppState, app};

    #[tokio::test]
    async fn health_endpoint_identifies_the_service() {
        let state = AppState {
            config: AppConfig::default(),
            http: Client::new(),
            pool: PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .expect("test database URL should parse"),
        };
        let response = app(state)
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
