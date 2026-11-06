//! The usage page reads `gateway_usage_events` back for the signed-in user only.

use chrono::{Duration, Utc};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    api::gateway::{UsageScope, usage_report::usage_for_user},
    core::{ApiError, AppConfig, AppState},
};

fn state(pool: PgPool) -> AppState {
    AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

async fn user(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(id.simple().to_string())
        .execute(pool)
        .await
        .unwrap();
    id
}

async fn key(pool: &PgPool, user_id: Uuid, last_four: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four) VALUES ($1, $2, $3, $4)",
    )
    .bind(id)
    .bind(user_id)
    .bind(id.as_bytes().to_vec())
    .bind(last_four)
    .execute(pool)
    .await
    .unwrap();
    id
}

struct Event<'a> {
    user_id: Uuid,
    key_id: Option<Uuid>,
    model: &'a str,
    tokens: Option<(i64, i64)>,
    outcome: &'a str,
    days_ago: i64,
}

async fn event(pool: &PgPool, event: Event<'_>) {
    sqlx::query(
        "INSERT INTO gateway_usage_events
         (id, user_id, gateway_key_id, provider, model,
          input_tokens, output_tokens, outcome, created_at)
         VALUES ($1, $2, $3, 'chatgpt', $4, $5, $6, $7, $8)",
    )
    .bind(Uuid::new_v4())
    .bind(event.user_id)
    .bind(event.key_id)
    .bind(event.model)
    .bind(event.tokens.map(|tokens| tokens.0))
    .bind(event.tokens.map(|tokens| tokens.1))
    .bind(event.outcome)
    .bind(Utc::now() - Duration::days(event.days_ago) - Duration::minutes(1))
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn usage_covers_only_the_users_own_requests_inside_the_period(pool: PgPool) {
    let me = user(&pool).await;
    let someone_else = user(&pool).await;
    let first_key = key(&pool, me, "aaaa").await;
    let second_key = key(&pool, me, "bbbb").await;
    let other_key = key(&pool, someone_else, "cccc").await;
    let mine = |key_id, model, tokens, outcome, days_ago| Event {
        user_id: me,
        key_id,
        model,
        tokens,
        outcome,
        days_ago,
    };
    for entry in [
        mine(Some(first_key), "gpt-a", Some((100, 20)), "completed", 0),
        mine(Some(first_key), "gpt-a", Some((50, 10)), "completed", 2),
        mine(Some(first_key), "gpt-a", Some((7, 0)), "incomplete", 2),
        mine(Some(second_key), "gpt-b", None, "incomplete", 1),
        // The Playground has no key.
        mine(None, "gpt-a", Some((5, 5)), "completed", 1),
        // Before the 7-day period.
        mine(Some(first_key), "gpt-a", Some((900, 900)), "completed", 20),
    ] {
        event(&pool, entry).await;
    }
    event(
        &pool,
        Event {
            user_id: someone_else,
            key_id: Some(other_key),
            model: "gpt-a",
            tokens: Some((1_000_000, 1_000_000)),
            outcome: "completed",
            days_ago: 0,
        },
    )
    .await;

    let usage = usage_for_user(&state(pool), me, Some(7), UsageScope::Workspace)
        .await
        .unwrap();

    assert_eq!(usage.period_days, 7);
    assert_eq!(usage.requests, 5);
    assert_eq!(usage.completed_requests, 3);
    // Four requests report both counts, among them the abandoned one: whatever it
    // used before it stopped is still used.
    assert_eq!(usage.token_known_requests, 4);
    assert_eq!(usage.known_input_tokens, 100 + 50 + 7 + 5);
    assert_eq!(usage.known_output_tokens, 20 + 10 + 5);

    assert_eq!(
        usage.daily_usage.len(),
        7,
        "every day of the period, empty or not"
    );
    let busy: Vec<(i64, i64)> = usage
        .daily_usage
        .iter()
        .map(|day| (day.requests, day.known_total_tokens))
        .collect();
    // Oldest day first: days 6..3 ago are empty, then 2 ago, 1 ago, today.
    assert_eq!(
        busy,
        vec![(0, 0), (0, 0), (0, 0), (0, 0), (2, 67), (2, 10), (1, 120)]
    );

    let rows: Vec<(Option<&str>, &str, i64)> = usage
        .breakdown
        .iter()
        .map(|row| {
            (
                row.key_last_four.as_deref(),
                row.model.as_deref().unwrap(),
                row.requests,
            )
        })
        .collect();
    assert_eq!(
        rows,
        vec![
            (Some("aaaa"), "gpt-a", 3),
            (None, "gpt-a", 1),
            (Some("bbbb"), "gpt-b", 1),
        ]
    );
}

#[sqlx::test]
async fn usage_defaults_to_thirty_days_and_rejects_a_period_out_of_range(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(pool);

    let usage = usage_for_user(&state, me, None, UsageScope::Workspace)
        .await
        .unwrap();
    assert_eq!(usage.period_days, 30);
    assert_eq!(usage.daily_usage.len(), 30);
    assert_eq!((usage.requests, usage.breakdown.len()), (0, 0));

    for days in [0, -1, 366] {
        assert!(
            matches!(
                usage_for_user(&state, me, Some(days), UsageScope::Workspace).await,
                Err(ApiError::Validation(_))
            ),
            "{days} days must be rejected"
        );
    }
    assert!(
        usage_for_user(&state, me, Some(365), UsageScope::Workspace)
            .await
            .is_ok()
    );
}
