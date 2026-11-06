//! What the shop took, by day, by item and by seller.

use axum::http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;

use super::{account, call, owner_and_state, state, support::Order};

/// Today as the shop has it.
async fn today(pool: &PgPool) -> String {
    sqlx::query_scalar::<_, chrono::NaiveDate>(
        "SELECT (NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date",
    )
    .fetch_one(pool)
    .await
    .unwrap()
    .to_string()
}

fn day<'a>(body: &'a Value, date: &str) -> &'a Value {
    body["daily"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["date"] == date)
        .unwrap_or_else(|| panic!("{date} is not in the series"))
}

#[sqlx::test]
async fn every_day_of_both_periods_is_there_even_when_it_took_nothing(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;

    for (days, entries) in [(7, 14), (14, 28), (30, 60)] {
        let (status, body) = call(
            &state,
            "GET",
            &format!("/dashboard/telegram/revenue?days={days}"),
            Some(&owner.cookie),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{days}");
        assert_eq!(body["days"], days);
        let daily = body["daily"].as_array().unwrap();
        assert_eq!(daily.len(), entries, "{days}");
        // Oldest first, ending today, nothing taken.
        assert_eq!(daily.last().unwrap()["date"], today(&pool).await);
        assert!(
            daily
                .iter()
                .all(|entry| entry["orders"] == 0 && entry["total_vnd"] == 0)
        );
        let dates: Vec<&str> = daily
            .iter()
            .map(|entry| entry["date"].as_str().unwrap())
            .collect();
        let mut sorted = dates.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(dates, sorted, "{days} days are ordered and not repeated");
    }
}

#[sqlx::test]
async fn takings_land_on_the_day_they_were_paid(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    Order::new("TODAY0000001")
        .paid("0 seconds")
        .insert(&pool)
        .await;
    Order::new("TODAY0000002")
        .paid("0 seconds")
        .quantity(3)
        .insert(&pool)
        .await;
    Order::new("YESTERDAY001").paid("1 day").insert(&pool).await;
    // Past the period shown and into the one before it.
    Order::new("EARLIER00001")
        .paid("9 days")
        .insert(&pool)
        .await;
    // Neither waiting nor cancelled orders are takings.
    Order::new("WAIT00000001")
        .awaiting("1 hour")
        .insert(&pool)
        .await;
    Order::new("GONE00000001").cancelled().insert(&pool).await;

    let (_, body) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue?days=7",
        Some(&owner.cookie),
        None,
    )
    .await;

    let today_entry = day(&body, &today(&pool).await);
    assert_eq!(today_entry["orders"], 2);
    assert_eq!(today_entry["total_vnd"], 49_000 * 4);

    let yesterday: String =
        sqlx::query_scalar("SELECT ((NOW() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date - 1)::text")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(day(&body, &yesterday)["orders"], 1);

    let total: i64 = body["daily"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entry| entry["total_vnd"].as_i64().unwrap())
        .sum();
    assert_eq!(
        total,
        49_000 * 6,
        "the earlier sale is in the series, the unpaid ones are not"
    );
}

#[sqlx::test]
async fn best_sellers_and_sellers_cover_the_period_shown_only(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    // Inside a 7-day period.
    Order::new("A1AAAAAAAAAA")
        .paid("1 hour")
        .of("plus", "ChatGPT Plus", 189_000)
        .insert(&pool)
        .await;
    Order::new("A2AAAAAAAAAA")
        .paid("2 hours")
        .of("plus", "ChatGPT Plus", 189_000)
        .handled(cashier.id, "cash")
        .insert(&pool)
        .await;
    Order::new("A3AAAAAAAAAA")
        .paid("3 hours")
        .of("plus", "ChatGPT Plus", 189_000)
        .handled(cashier.id, "cash")
        .insert(&pool)
        .await;
    Order::new("B1AAAAAAAAAA")
        .paid("1 day")
        .of("pro", "Claude Pro", 459_000)
        .handled(owner.id, "usdt")
        .insert(&pool)
        .await;
    // Outside it: eight days ago.
    Order::new("C1AAAAAAAAAA")
        .paid("8 days")
        .of("old", "Old Thing", 1_000_000)
        .insert(&pool)
        .await;

    let (_, week) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue?days=7",
        Some(&owner.cookie),
        None,
    )
    .await;

    // By how many orders, so three of Plus come before one of Pro, however much Pro cost.
    let items: Vec<(&str, i64, i64)> = week["top_items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| {
            (
                item["title"].as_str().unwrap(),
                item["orders"].as_i64().unwrap(),
                item["total_vnd"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        items,
        [("ChatGPT Plus", 3, 567_000), ("Claude Pro", 1, 459_000)]
    );

    // By what they came to: Pro's owner, then the cashier, then the bank.
    let sellers: Vec<(Option<&str>, i64, i64)> = week["by_seller"]
        .as_array()
        .unwrap()
        .iter()
        .map(|seller| {
            (
                seller["seller"].as_str(),
                seller["orders"].as_i64().unwrap(),
                seller["total_vnd"].as_i64().unwrap(),
            )
        })
        .collect();
    assert_eq!(
        sellers,
        [
            (Some(owner.username.as_str()), 1, 459_000),
            (Some(cashier.username.as_str()), 2, 378_000),
            (None, 1, 189_000),
        ]
    );

    // Over 14 days the old sale counts too.
    let (_, fortnight) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue?days=14",
        Some(&owner.cookie),
        None,
    )
    .await;
    assert!(
        fortnight["top_items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["title"] == "Old Thing")
    );
}

#[sqlx::test]
async fn at_most_five_best_sellers_are_listed(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    for (reference, title) in [
        ("T1AAAAAAAAAA", "One"),
        ("T2AAAAAAAAAA", "Two"),
        ("T3AAAAAAAAAA", "Three"),
        ("T4AAAAAAAAAA", "Four"),
        ("T5AAAAAAAAAA", "Five"),
        ("T6AAAAAAAAAA", "Six"),
    ] {
        Order::new(reference)
            .paid("1 hour")
            .of(reference, title, 1_000)
            .insert(&pool)
            .await;
    }

    let (_, body) = call(
        &state,
        "GET",
        "/dashboard/telegram/revenue",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(body["days"], 7, "a week unless asked otherwise");
    assert_eq!(body["top_items"].as_array().unwrap().len(), 5);
}

#[sqlx::test]
async fn a_period_must_be_one_of_the_three_the_page_offers(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    for days in ["0", "5", "8", "31", "-7", "abc"] {
        let (status, _) = call(
            &state,
            "GET",
            &format!("/dashboard/telegram/revenue?days={days}"),
            Some(&owner.cookie),
            None,
        )
        .await;

        assert!(status.is_client_error(), "{days}: {status}");
    }
}

#[sqlx::test]
async fn revenue_is_for_the_roles_that_may_see_it(pool: PgPool) {
    let state = state(pool.clone());

    for (role, expected) in [
        ("manager", StatusCode::OK),
        ("cashier", StatusCode::FORBIDDEN),
        ("stock-keeper", StatusCode::FORBIDDEN),
    ] {
        let member = account(&pool, Some((role, true))).await;
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/telegram/revenue",
            Some(&member.cookie),
            None,
        )
        .await;

        assert_eq!(status, expected, "{role}");
    }
}
