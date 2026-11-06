//! The history: what was sold, in a range of the shop's days.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{account, call, owner_and_state, state, support::Order};

fn references(body: &Value) -> Vec<&str> {
    body["orders"]
        .as_array()
        .unwrap()
        .iter()
        .map(|order| order["reference"].as_str().unwrap())
        .collect()
}

/// Four sales either side of two midnights in shop time (UTC+7): 23:59 on the
/// 5th, 00:00 and 23:59 on the 6th, and 00:00 on the 7th.
async fn four_days_of_sales(pool: &PgPool) {
    Order::new("DAY5LAST0001")
        .paid("2026-11-05 16:59:00+00")
        .insert(pool)
        .await;
    Order::new("DAY6FIRST001")
        .paid("2026-11-05 17:00:00+00")
        .insert(pool)
        .await;
    Order::new("DAY6LAST0001")
        .paid("2026-11-06 16:59:00+00")
        .quantity(2)
        .insert(pool)
        .await;
    Order::new("DAY7FIRST001")
        .paid("2026-11-06 17:00:00+00")
        .insert(pool)
        .await;
}

#[sqlx::test]
async fn a_range_is_made_of_the_shops_days_not_utc_days(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    four_days_of_sales(&pool).await;

    let (status, sixth) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?from=2026-11-06&to=2026-11-06",
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    // 00:00 and 23:59 of the 6th, in shop time, newest first.
    assert_eq!(references(&sixth), ["DAY6LAST0001", "DAY6FIRST001"]);
    assert_eq!(sixth["total"], 2);
    // 49,000 and 2 x 49,000.
    assert_eq!(sixth["total_vnd"], 147_000);

    let (_, fifth) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?from=2026-11-05&to=2026-11-05",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&fifth), ["DAY5LAST0001"]);

    let (_, from_the_sixth) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?from=2026-11-06",
        cookie,
        None,
    )
    .await;
    assert_eq!(
        references(&from_the_sixth),
        ["DAY7FIRST001", "DAY6LAST0001", "DAY6FIRST001"]
    );

    let (_, until_the_fifth) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?to=2026-11-05",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&until_the_fifth), ["DAY5LAST0001"]);

    let (_, everything) = call(&state, "GET", "/dashboard/telegram/sales", cookie, None).await;
    assert_eq!(everything["total"], 4);
    assert_eq!(everything["total_vnd"], 49_000 * 5);
}

#[sqlx::test]
async fn only_paid_orders_are_history(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    Order::new("PAID00000001")
        .paid("1 hour")
        .insert(&pool)
        .await;
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;
    Order::new("GONE00000001").cancelled().insert(&pool).await;

    let (_, body) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(references(&body), ["PAID00000001"]);
    assert_eq!(body["total_vnd"], 49_000);
}

#[sqlx::test]
async fn history_can_be_narrowed_to_who_sold_it_or_to_what_the_bank_settled(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    let cookie = Some(owner.cookie.as_str());
    Order::new("HERS00000001")
        .paid("3 hours")
        .handled(cashier.id, "cash")
        .insert(&pool)
        .await;
    Order::new("HERS00000002")
        .paid("2 hours")
        .handled(cashier.id, "usdt")
        .insert(&pool)
        .await;
    Order::new("OURS0000001A")
        .paid("1 hour")
        .handled(owner.id, "cash")
        .insert(&pool)
        .await;
    Order::new("SEPAY0000001")
        .paid("30 minutes")
        .insert(&pool)
        .await;

    let (_, everyone) = call(&state, "GET", "/dashboard/telegram/sales", cookie, None).await;
    // The people who sold, whatever the filters: sorted, and not the bank.
    let mut expected = vec![cashier.username.clone(), owner.username.clone()];
    expected.sort();
    assert_eq!(everyone["sellers"], json!(expected));

    let (_, hers) = call(
        &state,
        "GET",
        &format!("/dashboard/telegram/sales?handled_by={}", cashier.username),
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&hers), ["HERS00000002", "HERS00000001"]);
    assert_eq!(hers["total_vnd"], 98_000);
    assert_eq!(
        hers["sellers"], everyone["sellers"],
        "the list does not follow the filters"
    );

    let (_, bank) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?handled_by=bot",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&bank), ["SEPAY0000001"]);

    // Case does not matter, and nobody is nobody.
    let (_, shouted) = call(
        &state,
        "GET",
        &format!(
            "/dashboard/telegram/sales?handled_by={}",
            cashier.username.to_uppercase()
        ),
        cookie,
        None,
    )
    .await;
    assert_eq!(shouted["total"], 2);
    let (_, nobody) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?handled_by=nobody",
        cookie,
        None,
    )
    .await;
    assert_eq!(nobody["total"], 0);
    assert_eq!(nobody["total_vnd"], 0);
}

#[sqlx::test]
async fn history_is_searchable_and_paged_with_totals_over_every_page(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    for (reference, ago, who) in [
        ("S1AAAAAAAAAA", "5 hours", 1),
        ("S2AAAAAAAAAA", "4 hours", 2),
        ("S3AAAAAAAAAA", "3 hours", 3),
    ] {
        let name = ["", "lan", "minh", "hoa"][who as usize];
        Order::new(reference)
            .paid(ago)
            .by(who, Some(name), name)
            .insert(&pool)
            .await;
    }

    let (_, page) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?page=1&page_size=2",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&page), ["S3AAAAAAAAAA", "S2AAAAAAAAAA"]);
    assert_eq!(page["total"], 3);
    assert_eq!(page["total_vnd"], 147_000);

    let (_, searched) = call(
        &state,
        "GET",
        "/dashboard/telegram/sales?q=MINH",
        cookie,
        None,
    )
    .await;
    assert_eq!(references(&searched), ["S2AAAAAAAAAA"]);
    assert_eq!(searched["total_vnd"], 49_000);
}

#[sqlx::test]
async fn a_range_that_ends_before_it_starts_or_a_page_that_is_wrong_is_refused(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    for query in [
        "from=2026-11-07&to=2026-11-06",
        "from=not-a-date",
        "page=0",
        "page_size=500",
    ] {
        let (status, _) = call(
            &state,
            "GET",
            &format!("/dashboard/telegram/sales?{query}"),
            Some(&owner.cookie),
            None,
        )
        .await;

        assert!(
            status == StatusCode::UNPROCESSABLE_ENTITY || status == StatusCode::BAD_REQUEST,
            "{query}: {status}"
        );
    }
}

#[sqlx::test]
async fn history_is_for_the_roles_that_may_see_it(pool: PgPool) {
    let state = state(pool.clone());

    for (role, expected) in [
        ("cashier", StatusCode::OK),
        ("manager", StatusCode::OK),
        ("stock-keeper", StatusCode::FORBIDDEN),
    ] {
        let member = account(&pool, Some((role, true))).await;
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/telegram/sales",
            Some(&member.cookie),
            None,
        )
        .await;

        assert_eq!(status, expected, "{role}");
    }
}
