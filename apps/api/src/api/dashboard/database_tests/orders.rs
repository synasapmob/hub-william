//! The queue of orders the bot's buyers placed, and what staff do with each.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{
    account, call, owner_and_state, state, state_with_bot,
    support::{FakeBot, Order, product},
};

fn references(body: &Value) -> Vec<&str> {
    body["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|order| order["reference"].as_str().unwrap())
        .collect()
}

async fn available(pool: &PgPool, slug: &str) -> i32 {
    sqlx::query_scalar("SELECT available FROM telegram_products WHERE slug = $1")
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn row(pool: &PgPool, reference: &str) -> (String, Option<String>, Option<uuid::Uuid>) {
    sqlx::query_as(
        "SELECT status, payment_method, handled_by FROM telegram_orders WHERE reference = $1",
    )
    .bind(reference)
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test]
async fn the_queue_lists_what_awaits_payment_oldest_first_with_the_count_of_each_status(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    Order::new("NEWEST000001")
        .awaiting("5 minutes")
        .by(1, Some("lan_anh"), "Lan Anh")
        .insert(&pool)
        .await;
    Order::new("OLDEST000001")
        .awaiting("3 hours")
        .by(2, None, "Minh")
        .insert(&pool)
        .await;
    Order::new("MIDDLE000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;
    Order::new("PAID00000001")
        .paid("2 hours")
        .insert(&pool)
        .await;
    Order::new("GONE00000001").cancelled().insert(&pool).await;

    let (status, body) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=awaiting_payment",
        cookie,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        references(&body),
        ["OLDEST000001", "MIDDLE000001", "NEWEST000001"]
    );
    assert_eq!(body["total"], 3);
    assert_eq!(
        body["counts"],
        json!({ "all": 5, "awaiting_payment": 3, "paid": 1, "cancelled": 1 })
    );

    // A buyer with no username is known by their first name.
    let oldest = &body["orders"][0];
    assert_eq!(oldest["customer_username"], Value::Null);
    assert_eq!(oldest["customer_first_name"], "Minh");
    assert_eq!(oldest["item_title"], "Acme Pro");
    assert_eq!(oldest["total_vnd"], 49_000);
    assert_eq!(oldest["status"], "awaiting_payment");
    assert_eq!(oldest["payment_method"], Value::Null);
    assert_eq!(oldest["handled_by"], Value::Null);
}

#[sqlx::test]
async fn every_other_view_shows_the_newest_first(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    Order::new("PAID00000001")
        .created("3 hours")
        .paid("2 hours")
        .insert(&pool)
        .await;
    Order::new("PAID00000002")
        .created("1 hour")
        .paid("30 minutes")
        .insert(&pool)
        .await;
    Order::new("WAIT00000001")
        .awaiting("2 hours")
        .insert(&pool)
        .await;

    let (_, paid) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=paid",
        cookie,
        None,
    )
    .await;
    // Made an hour ago and three hours ago: the newer one first, unlike the queue.
    assert_eq!(references(&paid), ["PAID00000002", "PAID00000001"]);

    let (_, everything) = call(&state, "GET", "/dashboard/telegram/orders", cookie, None).await;
    assert_eq!(
        references(&everything),
        ["PAID00000002", "WAIT00000001", "PAID00000001"]
    );
    assert_eq!(everything["total"], 3);
}

#[sqlx::test]
async fn a_page_holds_what_was_asked_and_the_total_counts_every_page(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    for (reference, ago) in [
        ("AAAAAAAAAAA1", "5 hours"),
        ("AAAAAAAAAAA2", "4 hours"),
        ("AAAAAAAAAAA3", "3 hours"),
        ("AAAAAAAAAAA4", "2 hours"),
        ("AAAAAAAAAAA5", "1 hour"),
    ] {
        Order::new(reference).awaiting(ago).insert(&pool).await;
    }

    let (_, second) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=awaiting_payment&page=2&page_size=2",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&second), ["AAAAAAAAAAA3", "AAAAAAAAAAA4"]);
    assert_eq!(second["total"], 5);

    let (_, last) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=awaiting_payment&page=3&page_size=2",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&last), ["AAAAAAAAAAA5"]);

    // Past the end is empty, not an error.
    let (status, past) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=awaiting_payment&page=9&page_size=2",
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(references(&past).is_empty());
    assert_eq!(past["total"], 5);
}

#[sqlx::test]
async fn a_search_finds_a_buyer_a_reference_or_an_item_and_the_counts_follow_it(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    Order::new("LANANH000001")
        .awaiting("1 hour")
        .by(1, Some("lan_anh"), "Lan Anh")
        .insert(&pool)
        .await;
    Order::new("LANANH000002")
        .paid("1 hour")
        .by(1, Some("lan_anh"), "Lan Anh")
        .insert(&pool)
        .await;
    Order::new("MINH00000001")
        .awaiting("2 hours")
        .by(2, Some("minh"), "Minh")
        .of("claude-max", "Claude MAX X5", 79_000)
        .insert(&pool)
        .await;
    Order::new("SALE00000001")
        .awaiting("3 hours")
        .by(3, Some("hoa"), "Hoa")
        .of("sale", "Sale 100% off", 1_000)
        .insert(&pool)
        .await;

    let (_, by_name) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=LAN",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&by_name), ["LANANH000002", "LANANH000001"]);
    assert_eq!(
        by_name["counts"],
        json!({ "all": 2, "awaiting_payment": 1, "paid": 1, "cancelled": 0 })
    );

    let (_, by_item) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=claude",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&by_item), ["MINH00000001"]);

    let (_, by_reference) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=minh0000",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&by_reference), ["MINH00000001"]);

    // `%` and `_` mean themselves, not "anything".
    let (_, percent) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=100%25",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&percent), ["SALE00000001"]);
    let (_, only_percent) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=%25",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&only_percent), ["SALE00000001"]);
    let (_, underscore) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=lan_anh",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&underscore), ["LANANH000002", "LANANH000001"]);
    let (_, not_a_wildcard) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=lan_nh",
        cookie,
        None,
    )
    .await;
    assert!(references(&not_a_wildcard).is_empty());

    // A blank search is no search.
    let (_, blank) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?q=%20%20",
        cookie,
        None,
    )
    .await;
    assert_eq!(blank["total"], 4);
}

#[sqlx::test]
async fn a_status_or_a_page_that_makes_no_sense_is_refused(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    for query in [
        "status=shipped",
        "page=0",
        "page=-1",
        "page_size=0",
        "page_size=101",
    ] {
        let (status, _) = call(
            &state,
            "GET",
            &format!("/dashboard/telegram/orders?{query}"),
            Some(&owner.cookie),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}");
    }
}

#[sqlx::test]
async fn orders_are_for_the_roles_that_work_with_them(pool: PgPool) {
    let state = state(pool.clone());
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    for role in ["cashier", "manager"] {
        let member = account(&pool, Some((role, true))).await;
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/telegram/orders",
            Some(&member.cookie),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{role}");
    }

    // A stock keeper looks after the shelves, not the queue.
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    for (method, uri, body) in [
        ("GET", "/dashboard/telegram/orders", None),
        (
            "POST",
            "/dashboard/telegram/orders/WAIT00000001/pay",
            Some(json!({ "payment_method": "cash" })),
        ),
        (
            "POST",
            "/dashboard/telegram/orders/WAIT00000001/cancel",
            None,
        ),
    ] {
        let (status, _) = call(&state, method, uri, Some(&keeper.cookie), body).await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }
    assert_eq!(row(&pool, "WAIT00000001").await.0, "awaiting_payment");
}

// ----------------------------------------------------------------- marking paid

#[sqlx::test]
async fn marking_an_order_paid_records_who_and_how_and_takes_the_stock(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    product(&pool, "acme-pro", 10).await;
    Order::new("WAIT00000001")
        .awaiting("20 minutes")
        .quantity(3)
        .insert(&pool)
        .await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/wait00000001/pay",
        Some(&owner.cookie),
        Some(json!({ "payment_method": "cash" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["order"]["status"], "paid");
    assert_eq!(body["order"]["payment_method"], "cash");
    assert_eq!(body["order"]["handled_by"], owner.username);
    assert!(body["order"]["paid_at"].is_string());
    // No bot is connected, so nobody could be told; the order is paid regardless.
    assert_eq!(body["notified"], false);

    assert_eq!(available(&pool, "acme-pro").await, 7);
    assert_eq!(
        row(&pool, "WAIT00000001").await,
        ("paid".to_owned(), Some("cash".to_owned()), Some(owner.id))
    );
}

#[sqlx::test]
async fn an_order_past_its_time_can_still_be_paid(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    product(&pool, "acme-pro", 10).await;
    // Made two days ago, so it expired long since and still awaits payment.
    Order::new("OLD000000001")
        .awaiting("2 days")
        .insert(&pool)
        .await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/OLD000000001/pay",
        Some(&owner.cookie),
        Some(json!({ "payment_method": "usdt" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["order"]["payment_method"], "usdt");
    assert_eq!(available(&pool, "acme-pro").await, 9);
}

#[sqlx::test]
async fn the_stock_never_goes_below_zero_when_an_order_is_paid(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    // The shop lowered the count while the order was open.
    product(&pool, "acme-pro", 1).await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .quantity(5)
        .insert(&pool)
        .await;

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/WAIT00000001/pay",
        Some(&owner.cookie),
        Some(json!({ "payment_method": "bank_transfer" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(available(&pool, "acme-pro").await, 0);
}

#[sqlx::test]
async fn an_order_for_a_product_that_is_gone_can_still_be_paid(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    // The product was removed after the order was made; there is no row to take from.
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/WAIT00000001/pay",
        Some(&owner.cookie),
        Some(json!({ "payment_method": "cash" })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["order"]["status"], "paid");
}

#[sqlx::test]
async fn an_order_that_is_not_waiting_cannot_be_paid_or_cancelled_again(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    product(&pool, "acme-pro", 10).await;
    Order::new("PAID00000001")
        .paid("1 hour")
        .insert(&pool)
        .await;
    Order::new("GONE00000001").cancelled().insert(&pool).await;

    for reference in ["PAID00000001", "GONE00000001"] {
        let (status, body) = call(
            &state,
            "POST",
            &format!("/dashboard/telegram/orders/{reference}/pay"),
            cookie,
            Some(json!({ "payment_method": "cash" })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "pay {reference}");
        assert_eq!(body["message"], "That order is not waiting for payment.");

        let (status, _) = call(
            &state,
            "POST",
            &format!("/dashboard/telegram/orders/{reference}/cancel"),
            cookie,
            None,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "cancel {reference}"
        );
    }

    // Nothing was taken from stock by the refused attempts.
    assert_eq!(available(&pool, "acme-pro").await, 10);

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/NOSUCH000001/pay",
        cookie,
        Some(json!({ "payment_method": "cash" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/not-a-reference/cancel",
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn a_way_of_paying_must_be_one_the_shop_knows(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    for body in [json!({ "payment_method": "cheque" }), json!({})] {
        let (status, _) = call(
            &state,
            "POST",
            "/dashboard/telegram/orders/WAIT00000001/pay",
            Some(&owner.cookie),
            Some(body),
        )
        .await;

        assert!(status.is_client_error(), "{status}");
    }
    assert_eq!(row(&pool, "WAIT00000001").await.0, "awaiting_payment");
}

#[sqlx::test]
async fn two_people_paying_the_same_order_at_once_take_its_stock_once(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let other = account(&pool, Some(("cashier", true))).await;
    product(&pool, "acme-pro", 10).await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .quantity(4)
        .insert(&pool)
        .await;
    let pay = json!({ "payment_method": "cash" });

    let (first, second) = tokio::join!(
        call(
            &state,
            "POST",
            "/dashboard/telegram/orders/WAIT00000001/pay",
            Some(&owner.cookie),
            Some(pay.clone())
        ),
        call(
            &state,
            "POST",
            "/dashboard/telegram/orders/WAIT00000001/pay",
            Some(&other.cookie),
            Some(pay)
        ),
    );
    let mut answers = [first.0, second.0];
    answers.sort();

    assert_eq!(answers, [StatusCode::OK, StatusCode::UNPROCESSABLE_ENTITY]);
    assert_eq!(available(&pool, "acme-pro").await, 6);
}

#[sqlx::test]
async fn the_buyer_is_told_through_the_bot_that_their_order_is_paid(pool: PgPool) {
    let (bot, url) = FakeBot::start(StatusCode::NO_CONTENT, Value::Null).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_bot(pool.clone(), Some(&url));
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    let (_, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/WAIT00000001/pay",
        Some(&owner.cookie),
        Some(json!({ "payment_method": "usdt" })),
    )
    .await;

    assert_eq!(body["notified"], true);
    let received = bot.received();
    assert_eq!(received.len(), 1);
    let (path, token, sent) = &received[0];
    // The bot gets the order as the bot knows orders, with the shared secret.
    assert_eq!(path, "/internal/payment-notice");
    assert_eq!(token.as_deref(), Some("test-service-token"));
    assert_eq!(sent["reference"], "WAIT00000001");
    assert_eq!(sent["status"], "paid");
    assert_eq!(sent["chat_id"], 1_000);
    assert_eq!(sent["total_vnd"], 49_000);
}

#[sqlx::test]
async fn a_bot_that_is_down_does_not_undo_the_payment(pool: PgPool) {
    let owner = account(&pool, Some(("owner", true))).await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;

    // One that answers with an error, and one nothing listens at.
    let (_broken, broken_url) =
        FakeBot::start(StatusCode::INTERNAL_SERVER_ERROR, Value::Null).await;
    let unreachable = reqwest::Url::parse("http://127.0.0.1:1").unwrap();

    for (reference, url) in [("WAIT00000001", broken_url), ("WAIT00000002", unreachable)] {
        if reference == "WAIT00000002" {
            Order::new("WAIT00000002")
                .awaiting("1 hour")
                .insert(&pool)
                .await;
        }
        let state = state_with_bot(pool.clone(), Some(&url));

        let (status, body) = call(
            &state,
            "POST",
            &format!("/dashboard/telegram/orders/{reference}/pay"),
            Some(&owner.cookie),
            Some(json!({ "payment_method": "cash" })),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{reference}");
        assert_eq!(body["order"]["status"], "paid");
        assert_eq!(body["notified"], false);
    }
}

// -------------------------------------------------------------------- cancelling

#[sqlx::test]
async fn cancelling_records_who_and_leaves_the_stock_as_it_was(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    product(&pool, "acme-pro", 10).await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .quantity(2)
        .insert(&pool)
        .await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/orders/WAIT00000001/cancel",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["status"], "cancelled");
    assert_eq!(body["handled_by"], owner.username);
    assert_eq!(body["payment_method"], Value::Null);
    assert_eq!(available(&pool, "acme-pro").await, 10);
}

// ----------------------------------------------------------- how SePay settles

#[sqlx::test]
async fn an_order_sepay_settles_is_a_bank_transfer_with_nobody_in_the_shop_behind_it(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    product(&pool, "acme-pro", 10).await;
    Order::new("SEPAY0000001")
        .awaiting("10 minutes")
        .insert(&pool)
        .await;

    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/internal/telegram/payments/sepay")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(axum::body::Body::from(
            json!({
                "id": 9001,
                "gateway": "Techcombank",
                "transferAmount": 49_000,
                "transferType": "in",
                "content": "CAM TIEN SEPAY0000001"
            })
            .to_string(),
        ))
        .unwrap();
    let response = tower::ServiceExt::oneshot(crate::api::app(state.clone()), request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    assert_eq!(
        row(&pool, "SEPAY0000001").await,
        ("paid".to_owned(), Some("bank_transfer".to_owned()), None)
    );
    let (_, paid) = call(
        &state,
        "GET",
        "/dashboard/telegram/orders?status=paid",
        Some(&owner.cookie),
        None,
    )
    .await;
    assert_eq!(paid["orders"][0]["payment_method"], "bank_transfer");
    assert_eq!(paid["orders"][0]["handled_by"], Value::Null);
}

// ------------------------------------------------- a transfer after the order ran out

/// What SePay sends for a transfer of 49,000 with the order's reference in the
/// note. `made_minutes_ago` is the bank's own time, in Vietnamese local time as
/// SePay writes it; `None` leaves the field out.
async fn sepay_transfer(
    state: &crate::core::AppState,
    transaction_id: i64,
    reference: &str,
    made_minutes_ago: Option<i64>,
) -> Value {
    let mut body = json!({
        "id": transaction_id,
        "gateway": "Techcombank",
        "transferAmount": 49_000,
        "transferType": "in",
        "content": format!("CAM TIEN {reference}")
    });
    if let Some(minutes) = made_minutes_ago {
        let vietnam = chrono::FixedOffset::east_opt(7 * 3_600).unwrap();
        let made = chrono::Utc::now().with_timezone(&vietnam) - chrono::TimeDelta::minutes(minutes);
        body["transactionDate"] = json!(made.format("%Y-%m-%d %H:%M:%S").to_string());
    }

    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/internal/telegram/payments/sepay")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token")
        .body(axum::body::Body::from(body.to_string()))
        .unwrap();
    let response = tower::ServiceExt::oneshot(crate::api::app(state.clone()), request)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

/// The order a recorded transfer was matched to, if any.
async fn matched_order(pool: &PgPool, transaction_id: i64) -> Option<uuid::Uuid> {
    sqlx::query_scalar("SELECT order_id FROM telegram_payments WHERE sepay_transaction_id = $1")
        .bind(transaction_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn a_transfer_that_arrives_after_the_order_expired_is_kept_and_settles_nothing(pool: PgPool) {
    let state = state(pool.clone());
    product(&pool, "acme-pro", 10).await;
    // Made twenty minutes ago, so it ran out five minutes ago.
    Order::new("LATE00000001")
        .awaiting("20 minutes")
        .insert(&pool)
        .await;

    let result = sepay_transfer(&state, 9101, "LATE00000001", None).await;

    assert_eq!(result["order"], Value::Null);
    assert_eq!(
        row(&pool, "LATE00000001").await,
        ("awaiting_payment".to_owned(), None, None)
    );
    assert_eq!(available(&pool, "acme-pro").await, 10);
    // The money is on record for a person to deal with.
    assert_eq!(matched_order(&pool, 9101).await, None);
}

#[sqlx::test]
async fn a_transfer_the_bank_dates_after_the_order_expired_settles_nothing(pool: PgPool) {
    let state = state(pool.clone());
    product(&pool, "acme-pro", 10).await;
    Order::new("LATE00000002")
        .awaiting("20 minutes")
        .insert(&pool)
        .await;

    // Two minutes ago is three minutes after the order ran out.
    let result = sepay_transfer(&state, 9102, "LATE00000002", Some(2)).await;

    assert_eq!(result["order"], Value::Null);
    assert_eq!(
        row(&pool, "LATE00000002").await,
        ("awaiting_payment".to_owned(), None, None)
    );
    assert_eq!(available(&pool, "acme-pro").await, 10);
}

#[sqlx::test]
async fn a_transfer_made_in_time_still_settles_when_it_is_reported_late(pool: PgPool) {
    let state = state(pool.clone());
    product(&pool, "acme-pro", 10).await;
    Order::new("LATE00000003")
        .awaiting("20 minutes")
        .insert(&pool)
        .await;

    // The bank moved the money ten minutes ago, five before the order ran out,
    // and SePay only told us now.
    let result = sepay_transfer(&state, 9103, "LATE00000003", Some(10)).await;

    assert_eq!(result["order"]["reference"], "LATE00000003");
    assert_eq!(
        row(&pool, "LATE00000003").await,
        ("paid".to_owned(), Some("bank_transfer".to_owned()), None)
    );
    assert_eq!(available(&pool, "acme-pro").await, 9);
    assert!(matched_order(&pool, 9103).await.is_some());
}
