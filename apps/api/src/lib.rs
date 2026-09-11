mod agent_pools;
mod auth;
mod config;
mod connections;
mod error;
mod gateway;
mod health;
mod openapi;
mod telegram;
mod telegram_catalogue;

use axum::{
    Router,
    http::{
        Method,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    routing::{get, post, put},
};
use reqwest::Client;
use sqlx::PgPool;
use tower_http::cors::AllowOrigin;
use tower_http::cors::CorsLayer;
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

pub use agent_pools::{
    AgentPool, AgentPoolAvailability, AgentPoolAvailabilityStatus, AgentPoolJoinRequest,
    AgentPoolPerson, AgentPoolRequestStatus, AgentPoolUsageMetric, CreateAgentPoolJoinRequest,
    DecideAgentPoolJoinRequest, InviteAgentPoolMember,
};
use agent_pools::{
    create_request, decide_request, invite_member, list as list_agent_pools, remove_member,
    retry_pool,
};
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
pub use telegram::{
    CreateTelegramOrder, SepayResult, SepayTransaction, TelegramAudience, TelegramOrder,
};
use telegram::{
    block_contact, cancel_order, create_order, get_contact, get_order, list_audience, list_orders,
    observe_contact, record_sepay_payment, set_contact_language,
};
pub use telegram_catalogue::{
    AdjustTelegramProduct, CreateTelegramProduct, RestockTelegramProduct, TelegramCatalogue,
    TelegramCatalogueProvider, TelegramProduct, TelegramRestock,
};
use telegram_catalogue::{
    adjust_product, catalogue, create_product, full_catalogue, get_product, restock_product,
};

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
            "http://localhost:5174".parse().expect("valid local origin"),
            "http://127.0.0.1:5174".parse().expect("valid local origin"),
            "http://localhost:3000".parse().expect("valid local origin"),
            "http://127.0.0.1:3000".parse().expect("valid local origin"),
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
        .route("/internal/telegram/contacts", post(observe_contact))
        .route(
            "/internal/telegram/contacts/{telegram_user_id}",
            get(get_contact),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/language",
            put(set_contact_language),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders",
            get(list_orders).post(create_order),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}",
            get(get_order),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}/cancel",
            post(cancel_order),
        )
        .route(
            "/internal/telegram/payments/sepay",
            post(record_sepay_payment),
        )
        .route("/internal/telegram/audience", get(list_audience))
        .route(
            "/internal/telegram/audience/{chat_id}/block",
            post(block_contact),
        )
        .route("/internal/telegram/catalogue", get(catalogue))
        .route("/internal/telegram/catalogue/full", get(full_catalogue))
        .route("/internal/telegram/products", post(create_product))
        .route(
            "/internal/telegram/products/{slug}",
            get(get_product).patch(adjust_product),
        )
        .route(
            "/internal/telegram/products/{slug}/restock",
            post(restock_product),
        )
        .route("/agent-pools", get(list_agent_pools))
        .route(
            "/agent-pools/{connection_id}/requests",
            post(create_request),
        )
        .route("/agent-pools/{connection_id}/members", post(invite_member))
        .route(
            "/agent-pools/{connection_id}/members/{username}",
            axum::routing::delete(remove_member),
        )
        .route("/agent-pools/{connection_id}/retry", post(retry_pool))
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

    #[tokio::test]
    async fn local_cors_allows_only_the_supported_development_origins() {
        let config = AppConfig {
            cookie_secure: false,
            ..AppConfig::default()
        };
        let state = AppState {
            config,
            http: Client::new(),
            pool: PgPoolOptions::new()
                .connect_lazy("postgres://localhost/hub_william_test")
                .expect("test database URL should parse"),
        };
        let service = app(state);

        for origin in [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:5174",
            "http://127.0.0.1:5174",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ] {
            let response = service
                .clone()
                .oneshot(
                    Request::builder()
                        .method("OPTIONS")
                        .uri("/agent-pools")
                        .header("origin", origin)
                        .header("access-control-request-method", "GET")
                        .body(Body::empty())
                        .expect("CORS preflight request should be valid"),
                )
                .await
                .expect("CORS preflight should respond");

            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.headers()["access-control-allow-origin"], origin);
        }

        let response = service
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/agent-pools")
                    .header("origin", "http://localhost:9999")
                    .header("access-control-request-method", "GET")
                    .body(Body::empty())
                    .expect("unsupported-origin request should be valid"),
            )
            .await
            .expect("unsupported-origin preflight should respond");

        assert!(
            response
                .headers()
                .get("access-control-allow-origin")
                .is_none()
        );
    }
}
