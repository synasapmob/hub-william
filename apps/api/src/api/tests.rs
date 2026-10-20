use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use reqwest::Client;
use tower::ServiceExt;

use sqlx::postgres::PgPoolOptions;

use utoipa::OpenApi;

use super::{ApiDoc, app};
use crate::core::{AppConfig, AppState, gateway_http_client};

#[tokio::test]
async fn health_endpoint_identifies_the_service() {
    let state = AppState {
        config: AppConfig::default(),
        http: Client::new(),
        gateway_http: Client::new(),
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
async fn only_gateway_routes_accept_large_request_bodies() {
    let state = AppState {
        config: AppConfig::default(),
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    };
    let gateway_body = vec![b' '; 17 * 1024 * 1024];

    let gateway_response = app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/gateway/deepseek/responses")
                .header("content-type", "application/json")
                .body(Body::from(gateway_body))
                .expect("large gateway request should build"),
        )
        .await
        .expect("gateway should respond");
    assert_eq!(gateway_response.status(), StatusCode::UNAUTHORIZED);

    let browser_response = app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/auth/login")
                .header("content-type", "application/json")
                .body(Body::from(vec![b' '; 3 * 1024 * 1024]))
                .expect("large browser request should build"),
        )
        .await
        .expect("browser API should respond");
    assert_eq!(browser_response.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[test]
fn gateway_http_client_has_no_total_request_timeout() {
    let client = gateway_http_client().expect("gateway client should build");
    let debug = format!("{client:?}");

    assert!(
        !debug.contains("TotalTimeout"),
        "gateway client unexpectedly has a total request timeout: {debug}"
    );
}

#[tokio::test]
async fn gemini_native_model_routes_reach_gateway_authentication() {
    let state = AppState {
        config: AppConfig::default(),
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    };
    let response = app(state)
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/gateway/gemini/v1beta/models/gemini-test:generateContent")
                .header("content-type", "application/json")
                .header("x-goog-api-key", "invalid")
                .body(Body::from(r#"{"contents": []}"#))
                .expect("Gemini request should be valid"),
        )
        .await
        .expect("Gemini route should respond");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
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
        gateway_http: Client::new(),
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

#[tokio::test]
async fn cors_allows_every_method_the_browser_api_documents() {
    let state = AppState {
        config: AppConfig {
            cookie_secure: false,
            ..AppConfig::default()
        },
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    };
    let mut documented = std::collections::BTreeSet::new();
    for item in ApiDoc::openapi().paths.paths.values() {
        for (method, operation) in [
            ("GET", &item.get),
            ("POST", &item.post),
            ("PUT", &item.put),
            ("PATCH", &item.patch),
            ("DELETE", &item.delete),
        ] {
            if operation.is_some() {
                documented.insert(method);
            }
        }
    }
    // A browser refuses a call whose method the preflight does not list, so
    // one missing here is a feature that only fails outside the tests.
    assert!(documented.contains("PUT"), "the API documents a PUT route");

    for method in documented {
        let response = app(state.clone())
            .oneshot(
                Request::builder()
                    .method("OPTIONS")
                    .uri("/organizations")
                    .header("origin", "http://localhost:5173")
                    .header("access-control-request-method", method)
                    .body(Body::empty())
                    .expect("CORS preflight request should be valid"),
            )
            .await
            .expect("CORS preflight should respond");

        let allowed = response.headers()["access-control-allow-methods"]
            .to_str()
            .expect("allowed methods should be text")
            .to_owned();
        assert!(
            allowed.split(',').any(|item| item.trim() == method),
            "a browser cannot send {method}: the preflight allows only {allowed}"
        );
    }
}

async fn reel_response(method: &str, uri: &str, body: &str) -> (StatusCode, serde_json::Value) {
    let state = AppState {
        config: AppConfig::default(),
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    };
    let response = app(state)
        .oneshot(
            Request::builder()
                .method(method)
                .uri(uri)
                .header("content-type", "application/json")
                .body(Body::from(body.to_owned()))
                .expect("reel request should be valid"),
        )
        .await
        .expect("reel route should respond");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("reel response should have a body");

    (status, serde_json::from_slice(&bytes).unwrap_or_default())
}

#[tokio::test]
async fn reel_resolve_rejects_links_it_must_not_fetch() {
    for body in [
        r#"{}"#,
        r#"{"url":"   "}"#,
        r#"{"url":"http://www.facebook.com/reel/1"}"#,
        r#"{"url":"https://evil.test/x.com/status/1"}"#,
        r#"{"url":"https://169.254.169.254/latest/meta-data","platform":"facebook"}"#,
        r#"{"url":"https://x.com/jack/status/20","platform":"facebook"}"#,
    ] {
        let (status, payload) = reel_response("POST", "/reel/resolve", body).await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert_eq!(payload["code"], "validation_error", "{body}");
        assert!(payload["message"].is_string(), "{body}");
    }
}

#[tokio::test]
async fn reel_media_relay_only_opens_known_cdn_hosts() {
    for uri in [
        "/reel/stream?url=https%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data",
        "/reel/download?url=http%3A%2F%2Fvideo.twimg.com%2Fa.mp4",
        "/reel/stream?url=https%3A%2F%2Ffbcdn.net.evil.test%2Fa.mp4",
    ] {
        let (status, payload) = reel_response("GET", uri, "").await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{uri}");
        assert_eq!(payload["code"], "validation_error", "{uri}");
    }
}

#[test]
fn openapi_documents_the_reel_endpoints() {
    let document = ApiDoc::openapi();

    for path in ["/reel/resolve", "/reel/stream", "/reel/download"] {
        assert!(document.paths.paths.contains_key(path), "{path}");
    }
}
