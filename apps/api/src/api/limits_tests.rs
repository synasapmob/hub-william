use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
    middleware::{Next, from_fn, from_fn_with_state},
    routing::post,
};
use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use std::time::Duration;
use tower::ServiceExt;
use uuid::Uuid;

use super::{
    app,
    limits::{Limit, SessionUserId, UserLimit, limit_by_user},
};
use crate::core::{AppConfig, AppState};

fn state_with(config: AppConfig) -> AppState {
    AppState {
        config,
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    }
}

fn state() -> AppState {
    state_with(AppConfig::default())
}

async fn send(
    router: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
) -> Response<Body> {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", "application/json");
    for (name, value) in headers {
        request = request.header(*name, *value);
    }

    router
        .clone()
        .oneshot(
            request
                .body(Body::from("{}"))
                .expect("request should build"),
        )
        .await
        .expect("router should respond")
}

async fn statuses(
    router: &Router,
    method: &str,
    uri: &str,
    headers: &[(&str, &str)],
    count: usize,
) -> Vec<StatusCode> {
    let mut statuses = Vec::new();
    for _ in 0..count {
        statuses.push(send(router, method, uri, headers).await.status());
    }

    statuses
}

#[tokio::test]
async fn login_is_limited_with_retry_after_json_and_cors_headers() {
    let router = app(state());
    let origin = [("origin", "http://localhost:5173")];

    let first = statuses(&router, "POST", "/auth/login", &origin, 10).await;
    let limited = send(&router, "POST", "/auth/login", &origin).await;

    assert!(
        first
            .iter()
            .all(|status| *status != StatusCode::TOO_MANY_REQUESTS)
    );
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    let retry_after: u64 = limited.headers()["retry-after"]
        .to_str()
        .expect("retry-after should be text")
        .parse()
        .expect("retry-after should be whole seconds");
    assert!((1..=6).contains(&retry_after), "{retry_after}");
    assert_eq!(
        limited.headers()["access-control-allow-origin"],
        "http://localhost:5173"
    );
    assert!(
        limited.headers()["access-control-expose-headers"]
            .to_str()
            .unwrap()
            .to_ascii_lowercase()
            .contains("retry-after")
    );
    let body = to_bytes(limited.into_body(), usize::MAX).await.unwrap();
    let payload: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["code"], "rate_limited");
}

#[tokio::test]
async fn a_limit_on_one_route_does_not_affect_another() {
    let router = app(state());

    statuses(&router, "POST", "/auth/login", &[], 11).await;

    assert_eq!(
        send(&router, "POST", "/auth/login", &[]).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        send(&router, "GET", "/health", &[]).await.status(),
        StatusCode::OK
    );
    assert_ne!(
        send(&router, "POST", "/auth/register", &[]).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn forged_ip_headers_cannot_dodge_the_limit_when_proxy_headers_are_untrusted() {
    let router = app(state());

    for index in 0..10 {
        let forged = format!("10.0.0.{index}");
        send(&router, "POST", "/auth/login", &[("x-real-ip", &forged)]).await;
    }
    let limited = send(&router, "POST", "/auth/login", &[("x-real-ip", "10.9.9.9")]).await;

    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
}

#[tokio::test]
async fn trusted_proxy_header_gives_each_client_its_own_budget() {
    let router = app(state_with(AppConfig {
        trust_proxy_headers: true,
        ..AppConfig::default()
    }));
    let busy = [("x-real-ip", "203.0.113.1")];

    statuses(&router, "POST", "/auth/login", &busy, 10).await;

    assert_eq!(
        send(&router, "POST", "/auth/login", &busy).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_ne!(
        send(
            &router,
            "POST",
            "/auth/login",
            &[("x-real-ip", "203.0.113.2")]
        )
        .await
        .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn reel_stream_and_download_share_one_budget() {
    let router = app(state());
    let uri = "/reel/stream?url=https%3A%2F%2F169.254.169.254%2Fa.mp4";
    let download = "/reel/download?url=https%3A%2F%2F169.254.169.254%2Fa.mp4";

    statuses(&router, "GET", uri, &[], 20).await;
    statuses(&router, "GET", download, &[], 10).await;

    assert_eq!(
        send(&router, "GET", uri, &[]).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_ne!(
        send(&router, "POST", "/reel/resolve", &[]).await.status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[tokio::test]
async fn organization_writes_are_limited_but_reads_are_not() {
    let router = app(state());

    let writes = statuses(&router, "POST", "/organizations", &[], 11).await;
    let reads = statuses(&router, "GET", "/organizations", &[], 12).await;

    assert_eq!(writes[10], StatusCode::TOO_MANY_REQUESTS);
    assert!(
        writes[..10]
            .iter()
            .all(|status| *status != StatusCode::TOO_MANY_REQUESTS)
    );
    assert!(
        reads
            .iter()
            .all(|status| *status != StatusCode::TOO_MANY_REQUESTS)
    );
}

#[tokio::test]
async fn public_pool_listing_is_limited_per_client_without_a_session() {
    // The handler needs the database; a short acquire timeout keeps each of the
    // allowed requests quick while the limiter is the thing under test.
    let router = app(AppState {
        pool: PgPoolOptions::new()
            .acquire_timeout(Duration::from_millis(20))
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
        ..state()
    });

    let allowed = statuses(&router, "GET", "/agent-pools", &[], 30).await;
    let blocked = send(&router, "GET", "/agent-pools", &[]).await;

    assert!(
        allowed
            .iter()
            .all(|status| *status != StatusCode::TOO_MANY_REQUESTS)
    );
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers().contains_key("retry-after"));
}

#[tokio::test]
async fn gateway_counts_only_failed_key_attempts_per_ip() {
    let router = app(state());
    let uri = "/gateway/openai/v1/models";

    let attempts = statuses(&router, "GET", uri, &[], 30).await;
    let blocked = send(&router, "GET", uri, &[]).await;

    assert!(
        attempts
            .iter()
            .all(|status| *status == StatusCode::UNAUTHORIZED)
    );
    assert_eq!(blocked.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(blocked.headers().contains_key("retry-after"));
}

#[tokio::test]
async fn gateway_failures_are_counted_per_ip_not_globally() {
    let router = app(state_with(AppConfig {
        trust_proxy_headers: true,
        ..AppConfig::default()
    }));
    let uri = "/gateway/openai/v1/models";

    statuses(&router, "GET", uri, &[("x-real-ip", "198.51.100.1")], 30).await;

    assert_eq!(
        send(&router, "GET", uri, &[("x-real-ip", "198.51.100.1")])
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        send(&router, "GET", uri, &[("x-real-ip", "198.51.100.2")])
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

async fn session_from_header(mut request: Request<Body>, next: Next) -> axum::response::Response {
    let user = request
        .headers()
        .get("x-test-user")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value).ok());
    if let Some(user) = user {
        request.extensions_mut().insert(SessionUserId(user));
    }

    next.run(request).await
}

#[tokio::test]
async fn user_limits_are_per_user_and_ignore_the_ip() {
    let state = state();
    let limit = UserLimit::new(&state, Limit::AuthRefresh);
    let router: Router = Router::new()
        .route(
            "/limited",
            post(|| async { StatusCode::NO_CONTENT })
                .layer(from_fn_with_state(limit, limit_by_user)),
        )
        .layer(from_fn(session_from_header))
        .with_state(state);
    let alice = Uuid::new_v4().to_string();
    let bob = Uuid::new_v4().to_string();

    let alice_statuses =
        statuses(&router, "POST", "/limited", &[("x-test-user", &alice)], 11).await;
    let bob_status = send(&router, "POST", "/limited", &[("x-test-user", &bob)]).await;

    assert!(
        alice_statuses[..10]
            .iter()
            .all(|status| *status == StatusCode::NO_CONTENT)
    );
    assert_eq!(alice_statuses[10], StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(bob_status.status(), StatusCode::NO_CONTENT);
}
