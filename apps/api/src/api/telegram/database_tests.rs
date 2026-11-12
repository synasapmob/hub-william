//! A buyer holds one open order at a time.

use axum::{
    Router,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use super::catalogue::{NewProduct, insert_product};
use crate::{
    api::app,
    core::{AppConfig, AppState, ShopKey, TELEGRAM_KEY_NAME},
};

const BOT_KEY: &[u8] = b"test-service-token";

fn state(pool: PgPool) -> AppState {
    AppState {
        config: AppConfig {
            shop_keys: vec![ShopKey {
                name: TELEGRAM_KEY_NAME.to_owned(),
                key: BOT_KEY.to_vec(),
            }],
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

/// A listed package with `available` on hand. Its slug is what an order names.
async fn product(state: &AppState, plan: &str, available: i32) -> String {
    insert_product(
        state,
        NewProduct {
            available,
            category: None,
            delivers_accounts: false,
            detail: None,
            guide: None,
            hot: false,
            image_id: None,
            listed: true,
            plan: plan.to_owned(),
            price_vnd: 50_000,
            provider: "Acme Tools".to_owned(),
            variant: None,
            warranty: "WF".to_owned(),
            warranty_note: None,
        },
    )
    .await
    .expect("the package should be created")
    .slug
}

async fn buyer(pool: &PgPool, id: i64) {
    sqlx::query(
        "INSERT INTO telegram_contacts (telegram_user_id, chat_id, first_name) VALUES ($1, $1, 'Test')",
    )
    .bind(id)
    .execute(pool)
    .await
    .expect("the buyer should be created");
}

async fn order(router: &Router, buyer: i64, slug: &str, quantity: i32) -> (StatusCode, Value) {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/internal/telegram/contacts/{buyer}/orders"))
                .header("content-type", "application/json")
                .header("x-hub-william-telegram-token", "test-service-token")
                .body(Body::from(
                    json!({
                        "chat_id": buyer,
                        "lifetime_minutes": 5,
                        "product": slug,
                        "quantity": quantity,
                    })
                    .to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");

    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn reference(body: &Value) -> String {
    body["reference"]
        .as_str()
        .expect("an order has a reference")
        .to_owned()
}

/// A SePay webhook for a transfer in, whose note names `reference`.
async fn transfer(router: &Router, id: i64, amount: i64, reference: &str) -> Value {
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/internal/telegram/payments/sepay")
                .header("content-type", "application/json")
                .header("x-hub-william-telegram-token", "test-service-token")
                .body(Body::from(
                    json!({
                        "id": id,
                        "gateway": "TEST",
                        "transferAmount": amount,
                        "transferType": "in",
                        "content": format!("MOT NGAY VUI VE {reference}"),
                    })
                    .to_string(),
                ))
                .expect("request should build"),
        )
        .await
        .expect("router should respond");
    let bytes = to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body should read");

    serde_json::from_slice(&bytes).expect("the answer should be JSON")
}

async fn status_of(pool: &PgPool, reference: &str) -> String {
    sqlx::query_scalar("SELECT status FROM telegram_orders WHERE reference = $1")
        .bind(reference)
        .fetch_one(pool)
        .await
        .expect("the order should exist")
}

async fn open_orders(pool: &PgPool, buyer: i64) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM telegram_orders
         WHERE telegram_user_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()",
    )
    .bind(buyer)
    .fetch_one(pool)
    .await
    .expect("the count should read")
}

#[sqlx::test]
async fn a_new_order_cancels_the_buyers_earlier_open_one(pool: PgPool) {
    let state = state(pool.clone());
    let first_package = product(&state, "Plan One", 5).await;
    let second_package = product(&state, "Plan Two", 5).await;
    buyer(&pool, 1001).await;
    let router = app(state);

    let (_, first) = order(&router, 1001, &first_package, 1).await;
    let (status, second) = order(&router, 1001, &second_package, 1).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(status_of(&pool, &reference(&first)).await, "cancelled");
    assert_eq!(
        status_of(&pool, &reference(&second)).await,
        "awaiting_payment"
    );
    assert_eq!(open_orders(&pool, 1001).await, 1);
}

#[sqlx::test]
async fn the_cancelled_order_stops_holding_stock(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 3).await;
    buyer(&pool, 1002).await;
    let router = app(state);

    order(&router, 1002, &package, 3).await;
    // All 3 are held by the first order; ordering them again still works because
    // the first is cancelled before the stock is read.
    let (status, _) = order(&router, 1002, &package, 3).await;

    assert_eq!(status, StatusCode::OK);
    let reserved: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(quantity), 0) FROM telegram_orders
         WHERE item_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()",
    )
    .bind(&package)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(reserved, 3, "one order holds the stock, not two");
}

#[sqlx::test]
async fn a_refused_order_leaves_the_open_one_alone(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 2).await;
    buyer(&pool, 1003).await;
    let router = app(state);

    let (_, open) = order(&router, 1003, &package, 1).await;
    let (status, _) = order(&router, 1003, &package, 50).await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        status_of(&pool, &reference(&open)).await,
        "awaiting_payment"
    );
}

#[sqlx::test]
async fn an_order_for_an_unknown_package_leaves_the_open_one_alone(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 2).await;
    buyer(&pool, 1004).await;
    let router = app(state);

    let (_, open) = order(&router, 1004, &package, 1).await;
    let (status, _) = order(&router, 1004, "no-such-package", 1).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        status_of(&pool, &reference(&open)).await,
        "awaiting_payment"
    );
}

#[sqlx::test]
async fn another_buyers_order_is_not_touched(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 5).await;
    buyer(&pool, 1005).await;
    buyer(&pool, 1006).await;
    let router = app(state);

    let (_, theirs) = order(&router, 1005, &package, 1).await;
    order(&router, 1006, &package, 1).await;

    assert_eq!(
        status_of(&pool, &reference(&theirs)).await,
        "awaiting_payment"
    );
}

#[sqlx::test]
async fn an_order_that_has_run_out_is_left_for_the_owner(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 5).await;
    buyer(&pool, 1007).await;
    sqlx::query(
        "INSERT INTO telegram_orders
            (id, reference, telegram_user_id, chat_id, item_id, item_title,
             quantity, unit_price_vnd, total_vnd, expires_at)
         VALUES (gen_random_uuid(), 'EXPIREDORDER1', 1007, 1007, $1, 'Plan One', 1, 50000, 50000,
                 NOW() - INTERVAL '10 minutes')",
    )
    .bind(&package)
    .execute(&pool)
    .await
    .unwrap();
    let router = app(state);

    order(&router, 1007, &package, 1).await;

    assert_eq!(status_of(&pool, "EXPIREDORDER1").await, "awaiting_payment");
}

#[sqlx::test]
async fn a_paid_order_is_never_cancelled(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 5).await;
    buyer(&pool, 1008).await;
    let router = app(state);

    let (_, paid) = order(&router, 1008, &package, 1).await;
    sqlx::query(
        "UPDATE telegram_orders
         SET status = 'paid', paid_at = NOW(), payment_method = 'bank_transfer'
         WHERE reference = $1",
    )
    .bind(reference(&paid))
    .execute(&pool)
    .await
    .unwrap();
    order(&router, 1008, &package, 1).await;

    assert_eq!(status_of(&pool, &reference(&paid)).await, "paid");
}

#[sqlx::test]
async fn two_requests_at_once_leave_exactly_one_open_order(pool: PgPool) {
    let state = state(pool.clone());
    let package = product(&state, "Plan One", 10).await;
    buyer(&pool, 1009).await;
    let router = app(state);

    let (first, second) = tokio::join!(
        order(&router, 1009, &package, 1),
        order(&router, 1009, &package, 1)
    );

    assert_eq!(first.0, StatusCode::OK);
    assert_eq!(second.0, StatusCode::OK);
    assert_eq!(open_orders(&pool, 1009).await, 1);
}

#[sqlx::test]
async fn the_order_that_replaced_it_still_settles(pool: PgPool) {
    let state = state(pool.clone());
    let first_package = product(&state, "Plan One", 5).await;
    let second_package = product(&state, "Plan Two", 5).await;
    buyer(&pool, 1011).await;
    let router = app(state);
    order(&router, 1011, &first_package, 1).await;
    let (_, second) = order(&router, 1011, &second_package, 1).await;

    let answer = transfer(&router, 9002, 50_000, &reference(&second)).await;

    assert_eq!(answer["order"]["reference"], reference(&second));
    assert_eq!(answer["order"]["status"], "paid");
    assert!(answer["late"].is_null());
}

/// The cost of cancelling at once, pinned so it is a choice and not a surprise:
/// money that still names the cancelled order settles nothing and the buyer is not
/// told (as for any cancelled order, see `late_transfer`). It is stored for the
/// owner to reconcile.
#[sqlx::test]
async fn money_for_the_order_it_replaced_is_kept_for_the_owner(pool: PgPool) {
    let state = state(pool.clone());
    let first_package = product(&state, "Plan One", 5).await;
    let second_package = product(&state, "Plan Two", 5).await;
    buyer(&pool, 1012).await;
    let router = app(state);
    let (_, first) = order(&router, 1012, &first_package, 1).await;
    order(&router, 1012, &second_package, 1).await;

    let answer = transfer(&router, 9003, 50_000, &reference(&first)).await;

    assert!(answer["order"].is_null());
    assert!(answer["late"].is_null());
    assert_eq!(status_of(&pool, &reference(&first)).await, "cancelled");
    let unmatched: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM telegram_payments WHERE order_id IS NULL")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(unmatched, 1, "the money is recorded, not lost");
}
