//! Money that arrives for an order that has already run out settles nothing,
//! but the buyer is told who it was for, so they can write to the owner. Every
//! order and transfer here is made up.

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use super::{delivery::sepay, support::Order};
use crate::{api::app, core::AppState};

async fn status_of(pool: &PgPool, reference: &str) -> String {
    sqlx::query_scalar("SELECT status FROM telegram_orders WHERE reference = $1")
        .bind(reference)
        .fetch_one(pool)
        .await
        .unwrap()
}

/// A transfer with any note, of any kind, made at `transferred_at` (Vietnam time).
async fn transfer(
    state: &AppState,
    id: i64,
    kind: &str,
    note: &str,
    amount: i64,
    transferred_at: Option<&str>,
) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri("/internal/telegram/payments/sepay")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(Body::from(
            json!({
                "id": id,
                "gateway": "Techcombank",
                "transferAmount": amount,
                "transferType": kind,
                "content": note,
                "transactionDate": transferred_at
            })
            .to_string(),
        ))
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    serde_json::from_slice(&bytes).unwrap()
}

#[sqlx::test]
async fn money_for_an_order_that_ran_out_settles_nothing_and_says_who_it_was_for(pool: PgPool) {
    let state = super::state(pool.clone());
    // Made an hour ago, good for fifteen minutes.
    Order::new("LATE00000001")
        .awaiting("1 hour")
        .quantity(2)
        .by(4_242, Some("late_buyer"), "Late")
        .insert(&pool)
        .await;

    let result = sepay(&state, 1, "LATE00000001", 98_000).await;

    assert_eq!(result["order"], Value::Null);
    assert_eq!(result["duplicate"], false);
    assert_eq!(result["late"]["amount_vnd"], 98_000);
    assert_eq!(result["late"]["order"]["reference"], "LATE00000001");
    assert_eq!(result["late"]["order"]["telegram_user_id"], 4_242);
    // Still not paid: the owner decides.
    assert_eq!(status_of(&pool, "LATE00000001").await, "awaiting_payment");
    // And the money is kept, for the owner to reconcile.
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telegram_payments")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1);
}

#[sqlx::test]
async fn the_same_transfer_sent_again_is_not_announced_a_second_time(pool: PgPool) {
    let state = super::state(pool.clone());
    Order::new("LATE00000002")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    let first = sepay(&state, 7, "LATE00000002", 49_000).await;
    let again = sepay(&state, 7, "LATE00000002", 49_000).await;

    assert_eq!(first["late"]["order"]["reference"], "LATE00000002");
    assert_eq!(again["duplicate"], true);
    assert_eq!(again["late"], Value::Null);
}

#[sqlx::test]
async fn a_transfer_that_settles_an_order_is_not_late(pool: PgPool) {
    let state = super::state(pool.clone());
    Order::new("LATE00000003")
        .awaiting("2 minutes")
        .insert(&pool)
        .await;

    let result = sepay(&state, 1, "LATE00000003", 49_000).await;

    assert_eq!(result["order"]["reference"], "LATE00000003");
    assert_eq!(result["late"], Value::Null);
}

#[sqlx::test]
async fn an_order_still_open_that_was_paid_short_is_not_late(pool: PgPool) {
    let state = super::state(pool.clone());
    Order::new("LATE00000004")
        .awaiting("2 minutes")
        .insert(&pool)
        .await;

    // Not enough for the total: nothing settles, but the order has not run out.
    let result = sepay(&state, 1, "LATE00000004", 10_000).await;

    assert_eq!(result["order"], Value::Null);
    assert_eq!(result["late"], Value::Null);
    assert_eq!(status_of(&pool, "LATE00000004").await, "awaiting_payment");
}

#[sqlx::test]
async fn a_transfer_made_in_time_that_reaches_us_late_still_settles_and_is_not_late(pool: PgPool) {
    let state = super::state(pool.clone());
    Order::new("LATE00000005")
        .awaiting("1 hour")
        .insert(&pool)
        .await;
    // The order was made an hour ago and ran out forty-five minutes ago. Money
    // that moved ten minutes after it was made was in time.
    let moved: String = sqlx::query_scalar(
        "SELECT to_char((created_at + INTERVAL '10 minutes') AT TIME ZONE 'Asia/Ho_Chi_Minh',
                        'YYYY-MM-DD HH24:MI:SS')
         FROM telegram_orders WHERE reference = 'LATE00000005'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let result = transfer(&state, 1, "in", "CK LATE00000005", 49_000, Some(&moved)).await;

    assert_eq!(result["order"]["reference"], "LATE00000005");
    assert_eq!(result["late"], Value::Null);
}

#[sqlx::test]
async fn money_going_out_a_note_that_names_no_order_and_an_order_already_paid_are_not_late(
    pool: PgPool,
) {
    let state = super::state(pool.clone());
    Order::new("LATE00000006")
        .awaiting("1 hour")
        .insert(&pool)
        .await;
    Order::new("LATE00000007")
        .paid("1 hour")
        .created("2 hours")
        .insert(&pool)
        .await;

    let out = transfer(&state, 1, "out", "LATE00000006", 49_000, None).await;
    let nameless = transfer(&state, 2, "in", "chuyen tien an trua", 49_000, None).await;
    let paid_twice = transfer(&state, 3, "in", "LATE00000007", 49_000, None).await;

    for result in [out, nameless, paid_twice] {
        assert_eq!(result["order"], Value::Null);
        assert_eq!(result["late"], Value::Null);
    }
}

#[sqlx::test]
async fn an_order_stopped_by_the_buyer_is_left_to_the_owner_not_called_late(pool: PgPool) {
    let state = super::state(pool.clone());
    Order::new("LATE00000008")
        .awaiting("1 hour")
        .cancelled()
        .insert(&pool)
        .await;

    let result = sepay(&state, 1, "LATE00000008", 49_000).await;

    assert_eq!(result["late"], Value::Null);
}
