use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::Value;
use sqlx::PgPool;
use tower::ServiceExt;

use crate::{
    api::{
        app,
        telegram::catalogue::{NewProduct, insert_product},
    },
    core::{AppConfig, AppState, ShopKey},
};

const SHOP_KEY: &str = "shop-key-shop-key-shop-key-shop-key";

fn state(pool: PgPool) -> AppState {
    AppState {
        config: AppConfig {
            shop_keys: vec![ShopKey {
                name: "shopwatcher.org".to_owned(),
                key: SHOP_KEY.as_bytes().to_vec(),
            }],
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

fn product(provider: &str, plan: &str, available: i32, listed: bool) -> NewProduct {
    NewProduct {
        available,
        category: Some("AI Tools".to_owned()),
        delivers_accounts: false,
        detail: None,
        hot: true,
        image_id: None,
        listed,
        plan: plan.to_owned(),
        price_vnd: 135_000,
        provider: provider.to_owned(),
        variant: Some("1M".to_owned()),
        warranty: "WF".to_owned(),
        warranty_note: Some("Written for buyers".to_owned()),
    }
}

async fn read(router: &Router) -> (StatusCode, Option<String>, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/partner/products")
                .header("authorization", format!("Bearer {SHOP_KEY}"))
                .body(Body::empty())
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    let status = response.status();
    let cache_control = response
        .headers()
        .get("cache-control")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");

    (
        status,
        cache_control,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[sqlx::test]
async fn a_shop_sees_what_is_on_sale_and_not_what_the_stock_is(pool: PgPool) {
    let state = state(pool);
    insert_product(&state, product("Acme Tools", "MAX X20", 7, true))
        .await
        .unwrap();
    insert_product(&state, product("Acme Tools", "MAX X5", 0, true))
        .await
        .unwrap();
    insert_product(&state, product("Hidden Co", "Hidden", 3, false))
        .await
        .unwrap();

    let (status, _, body) = read(&app(state)).await;

    assert_eq!(status, StatusCode::OK);
    let providers = body["providers"].as_array().unwrap();
    let provider = |name: &str| providers.iter().find(|provider| provider["name"] == name);
    assert!(
        provider("Hidden Co").is_none(),
        "a provider with nothing on sale is left out"
    );
    let products = &provider("Acme Tools").unwrap()["products"];
    assert_eq!(products.as_array().unwrap().len(), 2);
    assert_eq!(products[0]["plan"], "MAX X20");
    assert_eq!(products[0]["price_vnd"], 135_000);
    assert_eq!(products[0]["warranty"], "WF");
    assert_eq!(products[0]["in_stock"], true);
    assert_eq!(products[1]["in_stock"], false);
    for hidden in [
        "available",
        "on_hand",
        "reserved",
        "hot",
        "warranty_note_en",
    ] {
        assert!(products[0].get(hidden).is_none(), "{hidden}");
    }
}

#[sqlx::test]
async fn a_read_is_kept_for_the_cache_lifetime(pool: PgPool) {
    let state = state(pool);
    insert_product(&state, product("Acme Tools", "MAX X20", 7, true))
        .await
        .unwrap();
    let router = app(state.clone());

    let (_, cache_control, first) = read(&router).await;
    insert_product(&state, product("Acme Tools", "MAX X5", 7, true))
        .await
        .unwrap();
    let (_, _, second) = read(&router).await;

    assert_eq!(cache_control.as_deref(), Some("private, max-age=30"));
    assert_eq!(first, second);
    assert_eq!(
        first["providers"][0]["products"].as_array().unwrap().len(),
        1
    );
}
