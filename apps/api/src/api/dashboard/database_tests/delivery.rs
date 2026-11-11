//! What a paid order is handed when its package hands out accounts: the oldest
//! first, to exactly one order each, and an order that finds none left is still
//! paid and is told how many it is missing. Every account here is made up.

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use futures_util::future::join_all;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

use super::{
    accounts::{SLUG, load, make_package, stored},
    call, owner_and_state,
    support::{Order, product},
};
use crate::{
    api::{app, telegram::accounts::take_accounts},
    core::AppState,
};

/// A SePay transfer of `amount` with the order's reference in the note.
pub(super) async fn sepay(
    state: &AppState,
    transaction_id: i64,
    reference: &str,
    amount: i64,
) -> Value {
    let request = Request::builder()
        .method("POST")
        .uri("/internal/telegram/payments/sepay")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(Body::from(
            json!({
                "id": transaction_id,
                "gateway": "Techcombank",
                "transferAmount": amount,
                "transferType": "in",
                "content": format!("CAM TIEN {reference}")
            })
            .to_string(),
        ))
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    serde_json::from_slice(&bytes).unwrap()
}

/// What the bot asks for after a payment, as the buyer `buyer`.
async fn delivery(state: &AppState, buyer: i64, reference: &str) -> (StatusCode, Value) {
    let request = Request::builder()
        .method("GET")
        .uri(format!(
            "/internal/telegram/contacts/{buyer}/orders/{reference}/delivery"
        ))
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(Body::empty())
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    let status = response.status();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn on_hand(pool: &PgPool, slug: &str) -> i32 {
    sqlx::query_scalar("SELECT available FROM telegram_products WHERE slug = $1")
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn a_paid_order_is_handed_the_oldest_accounts_and_the_count_comes_down(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    // Two loads, so one is plainly older than the other.
    load(&state, cookie, &["first@example.test|one"]).await;
    load(
        &state,
        cookie,
        &["second@example.test|two", "third@example.test|three"],
    )
    .await;

    Order::new("FIRST0000001")
        .awaiting("2 minutes")
        .by(1_001, None, "A")
        .insert(&pool)
        .await;
    Order::new("SECOND000001")
        .awaiting("2 minutes")
        .by(1_002, None, "B")
        .quantity(2)
        .insert(&pool)
        .await;

    sepay(&state, 1, "FIRST0000001", 49_000).await;
    sepay(&state, 2, "SECOND000001", 98_000).await;

    let (status, first) = delivery(&state, 1_001, "FIRST0000001").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        first,
        json!({ "accounts": ["first@example.test|one"], "missing": 0 })
    );

    let (_, second) = delivery(&state, 1_002, "SECOND000001").await;
    assert_eq!(second["missing"], 0);
    let mut handed: Vec<&str> = second["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a.as_str().unwrap())
        .collect();
    handed.sort_unstable();
    assert_eq!(
        handed,
        ["second@example.test|two", "third@example.test|three"]
    );

    // All three are sold, the count says so, and each belongs to one order.
    assert_eq!(on_hand(&pool, SLUG).await, 0);
    let owners: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT order_reference FROM telegram_stock_accounts ORDER BY created_at, id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        owners
            .iter()
            .filter(|o| o.as_deref() == Some("FIRST0000001"))
            .count(),
        1
    );
    assert_eq!(
        owners
            .iter()
            .filter(|o| o.as_deref() == Some("SECOND000001"))
            .count(),
        2
    );
    assert_eq!(owners[0].as_deref(), Some("FIRST0000001"));
}

#[sqlx::test]
async fn the_last_buyer_finds_none_left_and_is_paid_all_the_same(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["only@example.test|one"]).await;

    // Two buyers were both let through for the last account, and both pay.
    Order::new("EARLY0000001")
        .awaiting("2 minutes")
        .by(1_001, None, "A")
        .insert(&pool)
        .await;
    Order::new("LATE00000001")
        .awaiting("2 minutes")
        .by(1_002, None, "B")
        .insert(&pool)
        .await;
    sepay(&state, 1, "EARLY0000001", 49_000).await;
    let late = sepay(&state, 2, "LATE00000001", 49_000).await;

    // Paid, so the money is recorded and the buyer is notified...
    assert_eq!(late["order"]["status"], "paid");
    let (_, early) = delivery(&state, 1_001, "EARLY0000001").await;
    assert_eq!(
        early,
        json!({ "accounts": ["only@example.test|one"], "missing": 0 })
    );
    // ...but there is nothing to give, and the buyer is told how much is missing.
    let (_, left_out) = delivery(&state, 1_002, "LATE00000001").await;
    assert_eq!(left_out, json!({ "accounts": [], "missing": 1 }));
    assert_eq!(on_hand(&pool, SLUG).await, 0);
}

#[sqlx::test]
async fn an_order_for_more_than_is_left_gets_what_there_is_and_the_rest_is_missing(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1", "b@example.test|2"]).await;

    Order::new("THREE0000001")
        .awaiting("2 minutes")
        .quantity(3)
        .insert(&pool)
        .await;
    sepay(&state, 1, "THREE0000001", 147_000).await;

    let (_, body) = delivery(&state, 1_000, "THREE0000001").await;
    assert_eq!(body["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(body["missing"], 1);
    assert_eq!(on_hand(&pool, SLUG).await, 0);
}

/// Two sales that overlap, held open on purpose so the overlap is certain rather
/// than hoped for: the second must neither wait for the first nor take its account.
#[sqlx::test]
async fn a_sale_that_is_still_open_neither_holds_up_another_nor_shares_its_account(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(
        &state,
        cookie,
        &["a@example.test|1", "b@example.test|2", "c@example.test|3"],
    )
    .await;
    let product_id: uuid::Uuid =
        sqlx::query_scalar("SELECT id FROM telegram_products WHERE slug = $1")
            .bind(SLUG)
            .fetch_one(&pool)
            .await
            .unwrap();

    let mut first = pool.begin().await.unwrap();
    let mut second = pool.begin().await.unwrap();
    let mut third = pool.begin().await.unwrap();
    let mut fourth = pool.begin().await.unwrap();
    let wait = std::time::Duration::from_secs(5);

    let a = take_accounts(&mut first, product_id, "OPEN00000001", 2)
        .await
        .unwrap();
    // The first has two of the three locked and has not committed. The second still
    // gets the one that is free, at once.
    let b = tokio::time::timeout(
        wait,
        take_accounts(&mut second, product_id, "OPEN00000002", 2),
    )
    .await
    .expect("the second sale waited for the first")
    .unwrap();
    // And a third finds nothing free and is told so at once, not made to wait.
    let c = tokio::time::timeout(
        wait,
        take_accounts(&mut third, product_id, "OPEN00000003", 1),
    )
    .await
    .expect("the third sale waited for the others")
    .unwrap();
    assert_eq!((a, b, c), (2, 1, 0));

    first.commit().await.unwrap();
    second.commit().await.unwrap();
    third.commit().await.unwrap();
    // Nothing is left for a sale that starts after them.
    assert_eq!(
        take_accounts(&mut fourth, product_id, "OPEN00000004", 1)
            .await
            .unwrap(),
        0
    );
    fourth.commit().await.unwrap();

    // Each account went to one order, and only one.
    let rows: Vec<Option<String>> = sqlx::query_scalar(
        "SELECT order_reference FROM telegram_stock_accounts ORDER BY order_reference",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        rows.iter()
            .filter(|r| r.as_deref() == Some("OPEN00000001"))
            .count(),
        2
    );
    assert_eq!(
        rows.iter()
            .filter(|r| r.as_deref() == Some("OPEN00000002"))
            .count(),
        1
    );
    assert!(rows.iter().all(Option::is_some));
}

#[sqlx::test]
async fn eight_orders_paid_together_for_five_accounts_are_given_five_and_no_repeat(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    let lines: Vec<String> = (0..5)
        .map(|n| format!("acc{n}@example.test|pw{n}"))
        .collect();
    let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
    load(&state, cookie, &lines).await;

    // Eight orders for five accounts, all paid together. This checks the totals; that
    // two overlapping sales cannot take the same account is shown, with the overlap held
    // open on purpose, by the test above.
    let references: Vec<String> = (0..8).map(|n| format!("RACE{n:08}")).collect();
    for (n, reference) in references.iter().enumerate() {
        Order::new(Box::leak(reference.clone().into_boxed_str()))
            .awaiting("2 minutes")
            .by(2_000 + n as i64, None, "Racer")
            .insert(&pool)
            .await;
    }
    let results = join_all(references.iter().enumerate().map(|(n, reference)| {
        let state = state.clone();
        async move { sepay(&state, 100 + n as i64, reference, 49_000).await }
    }))
    .await;
    assert!(
        results
            .iter()
            .all(|result| result["order"]["status"] == "paid")
    );

    // Five orders got an account each, three got none, and no account went twice.
    let mut given = 0;
    let mut seen = std::collections::HashSet::new();
    for (n, reference) in references.iter().enumerate() {
        let (_, body) = delivery(&state, 2_000 + n as i64, reference).await;
        for account in body["accounts"].as_array().unwrap() {
            given += 1;
            assert!(
                seen.insert(account.as_str().unwrap().to_owned()),
                "{account} went twice"
            );
        }
    }
    assert_eq!(given, 5);
    let sold: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM telegram_stock_accounts WHERE order_reference IS NOT NULL",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(sold, 5);
    assert_eq!(on_hand(&pool, SLUG).await, 0);
}

#[sqlx::test]
async fn a_transfer_sepay_sends_twice_hands_out_once(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1", "b@example.test|2"]).await;
    Order::new("RETRY0000001")
        .awaiting("2 minutes")
        .insert(&pool)
        .await;

    sepay(&state, 7, "RETRY0000001", 49_000).await;
    let retried = sepay(&state, 7, "RETRY0000001", 49_000).await;

    assert_eq!(retried["duplicate"], true);
    let (_, body) = delivery(&state, 1_000, "RETRY0000001").await;
    assert_eq!(body["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(on_hand(&pool, SLUG).await, 1);
}

#[sqlx::test]
async fn only_the_buyer_of_a_paid_order_can_ask_for_its_accounts(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1"]).await;
    Order::new("MINE00000001")
        .awaiting("2 minutes")
        .by(1_001, None, "Owner of it")
        .insert(&pool)
        .await;

    // Unpaid: nothing to ask for yet.
    assert_eq!(
        delivery(&state, 1_001, "MINE00000001").await.0,
        StatusCode::NOT_FOUND
    );
    sepay(&state, 1, "MINE00000001", 49_000).await;

    assert_eq!(
        delivery(&state, 1_001, "MINE00000001").await.0,
        StatusCode::OK
    );
    // Someone else's order, an order that is not there, and no service token.
    assert_eq!(
        delivery(&state, 1_002, "MINE00000001").await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        delivery(&state, 1_001, "NOSUCH000001").await.0,
        StatusCode::NOT_FOUND
    );
    let request = Request::builder()
        .method("GET")
        .uri("/internal/telegram/contacts/1001/orders/MINE00000001/delivery")
        .body(Body::empty())
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn an_ordinary_package_hands_out_nothing_and_loses_its_count_as_before(pool: PgPool) {
    let state = super::state(pool.clone());
    product(&pool, "acme-pro", 10).await;
    Order::new("PLAIN0000001")
        .awaiting("2 minutes")
        .quantity(2)
        .insert(&pool)
        .await;

    sepay(&state, 1, "PLAIN0000001", 98_000).await;

    assert_eq!(
        delivery(&state, 1_000, "PLAIN0000001").await.1,
        json!({ "accounts": [], "missing": 0 })
    );
    assert_eq!(on_hand(&pool, "acme-pro").await, 8);
}

#[sqlx::test]
async fn an_order_staff_mark_paid_is_handed_its_accounts_too(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1", "b@example.test|2"]).await;
    Order::new("HAND00000001")
        .awaiting("2 minutes")
        .insert(&pool)
        .await;

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/HAND00000001/pay",
        cookie,
        Some(json!({ "payment_method": "usdt" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let (_, body) = delivery(&state, 1_000, "HAND00000001").await;
    assert_eq!(body["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(on_hand(&pool, SLUG).await, 1);
}

#[sqlx::test]
async fn without_the_key_an_order_stays_paid_and_its_accounts_stay_assigned(pool: PgPool) {
    let (mut state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1"]).await;
    Order::new("NOKEY0000001")
        .awaiting("2 minutes")
        .insert(&pool)
        .await;
    sepay(&state, 1, "NOKEY0000001", 49_000).await;

    state.config.stock_encryption_key = None;
    let (status, body) = delivery(&state, 1_000, "NOKEY0000001").await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert!(!body.to_string().contains("example.test"));
    // Nothing was lost: with the key back, the same ask answers.
    state.config.stock_encryption_key = Some([9; 32]);
    assert_eq!(
        delivery(&state, 1_000, "NOKEY0000001").await.0,
        StatusCode::OK
    );
    assert_eq!(stored(&pool).await.len(), 1);
}

#[sqlx::test]
async fn an_order_for_a_package_that_hands_out_accounts_is_capped_at_ten(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    let lines: Vec<String> = (0..12)
        .map(|n| format!("acc{n}@example.test|pw{n}"))
        .collect();
    let lines: Vec<&str> = lines.iter().map(String::as_str).collect();
    load(&state, cookie, &lines).await;

    let order = |quantity: i32| {
        let state = state.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri("/internal/telegram/contacts/3000/orders")
                .header("content-type", "application/json")
                .header("x-hub-william-telegram-token", "test-service-token")
                .body(Body::from(
                    json!({ "chat_id": 3000, "product": SLUG, "quantity": quantity, "lifetime_minutes": 5 })
                        .to_string(),
                ))
                .unwrap();
            app(state).oneshot(request).await.unwrap().status()
        }
    };
    sqlx::query("INSERT INTO telegram_contacts (telegram_user_id, chat_id, first_name) VALUES (3000, 3000, 'Big')")
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(order(11).await, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(order(10).await, StatusCode::OK);
}

#[sqlx::test]
async fn an_order_is_titled_as_the_package_is_called_without_the_provider_in_front(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    // The package is made as the shop writes it: its name with the variant in
    // brackets, under a provider that only groups it.
    let mut product = super::new_product("Gemini AI PRO your mail");
    product["variant"] = json!("Personal");
    let (status, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(product),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let slug = created["slug"].as_str().unwrap().to_owned();
    sqlx::query("INSERT INTO telegram_contacts (telegram_user_id, chat_id, first_name) VALUES (3001, 3001, 'Buyer')")
        .execute(&pool)
        .await
        .unwrap();

    let request = Request::builder()
        .method("POST")
        .uri("/internal/telegram/contacts/3001/orders")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(Body::from(
            json!({ "chat_id": 3001, "product": slug, "quantity": 1, "lifetime_minutes": 5 })
                .to_string(),
        ))
        .unwrap();
    let response = app(state.clone()).oneshot(request).await.unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();
    let order: Value = serde_json::from_slice(&bytes).unwrap();

    // Not "Acme Gemini AI PRO your mail (Personal)": the provider is not put in front.
    assert_eq!(order["item_title"], "Gemini AI PRO your mail (Personal)");
}
