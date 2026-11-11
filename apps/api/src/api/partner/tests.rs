use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, Response, StatusCode},
};
use reqwest::Client;
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use tower::ServiceExt;

use crate::{
    api::app,
    core::{AppConfig, AppState, ShopKey, TELEGRAM_KEY_NAME},
};

const BOT_KEY: &str = "bot-key-bot-key-bot-key-bot-key-0000";
const STRANGER_KEY: &str = "stranger-key-stranger-key-stranger-0";

fn router() -> Router {
    app(AppState {
        config: AppConfig {
            shop_keys: [(TELEGRAM_KEY_NAME, BOT_KEY), ("stranger", STRANGER_KEY)]
                .map(|(name, key)| ShopKey {
                    name: name.to_owned(),
                    key: key.as_bytes().to_vec(),
                })
                .to_vec(),
            ..AppConfig::default()
        },
        http: Client::new(),
        gateway_http: Client::new(),
        pool: PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .expect("test database URL should parse"),
    })
}

async fn get(router: &Router, uri: &str, key: Option<&str>) -> Response<Body> {
    let mut request = Request::builder().method("GET").uri(uri);
    if let Some(key) = key {
        request = request.header("authorization", format!("Bearer {key}"));
    }

    router
        .clone()
        .oneshot(request.body(Body::empty()).expect("request should build"))
        .await
        .expect("router should respond")
}

async fn products(router: &Router, key: Option<&str>) -> Response<Body> {
    get(router, "/partner/products", key).await
}

async fn code(response: Response<Body>) -> String {
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");
    let body: Value = serde_json::from_slice(&bytes).expect("body should be JSON");

    body["code"].as_str().unwrap_or_default().to_owned()
}

#[tokio::test]
async fn a_request_without_a_key_is_refused() {
    let response = products(&router(), None).await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(code(response).await, "invalid_partner_key");
}

#[tokio::test]
async fn a_key_that_was_not_issued_is_refused() {
    let response = products(&router(), Some("a-key-nobody-was-given-a-key-nobody")).await;

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_bot_key_is_not_a_shop_key() {
    let response = products(&router(), Some(BOT_KEY)).await;

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_key_whose_name_has_no_grant_reads_nothing() {
    let response = products(&router(), Some(STRANGER_KEY)).await;

    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn a_shop_key_does_not_open_the_bots_routes() {
    let router = router();

    for uri in [
        "/internal/telegram/catalogue",
        "/internal/telegram/audience",
    ] {
        let response = get(&router, uri, Some(STRANGER_KEY)).await;

        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{uri}");
    }
}

#[tokio::test]
async fn a_caller_has_ten_requests_a_minute() {
    let router = router();

    for _ in 0..10 {
        let response = products(&router, Some(STRANGER_KEY)).await;
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let limited = products(&router, Some(STRANGER_KEY)).await;

    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
    assert_eq!(
        products(&router, Some(BOT_KEY)).await.status(),
        StatusCode::FORBIDDEN,
        "another caller keeps its own budget"
    );
}

#[tokio::test]
async fn an_address_that_keeps_sending_bad_keys_is_slowed_down() {
    let router = router();

    for _ in 0..10 {
        let response = products(&router, Some("a-key-nobody-was-given-a-key-nobody")).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let limited = products(&router, Some("a-key-nobody-was-given-a-key-nobody")).await;

    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    assert!(limited.headers().contains_key("retry-after"));
}

#[tokio::test]
async fn bad_keys_from_anyone_cannot_lock_a_shop_out() {
    let router = router();

    for _ in 0..30 {
        products(&router, Some("a-key-nobody-was-given-a-key-nobody")).await;
    }

    assert_eq!(
        products(&router, Some(STRANGER_KEY)).await.status(),
        StatusCode::FORBIDDEN,
        "a valid key still gets through; only its own budget can stop it"
    );
}
