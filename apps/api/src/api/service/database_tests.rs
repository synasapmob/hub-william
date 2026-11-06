//! The wallet moves money exactly: no negative balance, no money taken twice,
//! and a ledger that agrees with what the user holds.

use std::{collections::HashSet, time::Duration};

use axum::extract::State;
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    ChargedRequest, MIN_BALANCE_MICRO, Tokens, authorize_request, charge_request,
    money::MICRO_PER_DOLLAR, pricing, top_up_for_user, wallet,
};
use crate::{
    core::{ApiError, AppConfig, AppState},
    utils::provider_catalogue::AgentProvider,
};

const DOLLAR: i64 = MICRO_PER_DOLLAR;

fn state(pool: PgPool, test_top_up: bool) -> AppState {
    AppState {
        config: AppConfig {
            service_test_top_up: test_top_up,
            ..AppConfig::default()
        },
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

/// A usage event for a charge to point at.
async fn usage_event(pool: &PgPool, user_id: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO gateway_usage_events (id, user_id, provider, outcome)
         VALUES ($1, $2, 'chatgpt', 'completed')",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await
    .unwrap();
    id
}

async fn fund(pool: &PgPool, user_id: Uuid, micro: i64) {
    wallet::top_up(pool, user_id, micro).await.unwrap();
}

/// Empties the price list, so that every model costs the default price and the
/// sums in a test do not follow the list.
async fn price_everything_at_the_default(pool: &PgPool) {
    sqlx::query("DELETE FROM service_model_prices")
        .execute(pool)
        .await
        .unwrap();
}

/// One row of the price list, in dollars-worth of micro-dollars per million tokens.
async fn list_model(
    pool: &PgPool,
    provider: &str,
    model: &str,
    listed: bool,
    price: (i64, i64, i64),
) {
    sqlx::query(
        "INSERT INTO service_model_prices
         (provider, model, name, listed, position, input_micro_per_million,
          cached_micro_per_million, output_micro_per_million)
         VALUES ($1, $2, $2, $3, 1000, $4, $5, $6)
         ON CONFLICT (provider, model) DO UPDATE SET
             listed = $3, input_micro_per_million = $4, cached_micro_per_million = $5,
             output_micro_per_million = $6",
    )
    .bind(provider)
    .bind(model)
    .bind(listed)
    .bind(price.0)
    .bind(price.1)
    .bind(price.2)
    .execute(pool)
    .await
    .unwrap();
}

/// 100,000 input tokens of which 92,000 cached, and 3,000 output tokens: at the
/// default price 24,420 micro-dollars (see `price_everything_at_the_default`).
fn request(event: Uuid, user_id: Uuid, model: Option<&str>) -> ChargedRequest<'_> {
    ChargedRequest {
        usage_event_id: event,
        user_id,
        provider: AgentProvider::Chatgpt,
        model,
        tokens: Tokens {
            input: Some(100_000),
            cached: Some(92_000),
            output: Some(3_000),
        },
    }
}

async fn ledger(pool: &PgPool, user_id: Uuid) -> Vec<(String, i64, i64, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT kind, amount_micro, wallet_after_micro, usage_event_id
         FROM service_ledger WHERE user_id = $1 ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test]
async fn top_up_is_refused_until_payments_exist(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(pool.clone(), false);

    assert!(matches!(
        top_up_for_user(&state, me, 10 * DOLLAR).await,
        Err(ApiError::NotAvailable(_))
    ));
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert!(ledger(&pool, me).await.is_empty());
}

#[sqlx::test]
async fn a_top_up_adds_to_the_wallet_and_leaves_a_ledger_row(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(pool.clone(), true);

    top_up_for_user(&state, me, 30 * DOLLAR).await.unwrap();
    let wallet_after = top_up_for_user(&state, me, 20 * DOLLAR).await.unwrap();

    assert_eq!(wallet_after.wallet_micro, 50 * DOLLAR);
    assert_eq!(
        ledger(&pool, me).await,
        [
            ("top_up".to_owned(), 30 * DOLLAR, 30 * DOLLAR, None),
            ("top_up".to_owned(), 20 * DOLLAR, 50 * DOLLAR, None),
        ]
    );
}

#[sqlx::test]
async fn amounts_out_of_range_are_rejected(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(pool.clone(), true);

    for amount in [0, -DOLLAR, DOLLAR - 1, 1_001 * DOLLAR] {
        assert!(
            matches!(
                top_up_for_user(&state, me, amount).await,
                Err(ApiError::Validation(_))
            ),
            "top up {amount}"
        );
    }
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert!(ledger(&pool, me).await.is_empty());
}

#[sqlx::test]
async fn a_request_is_charged_what_it_cost_and_leaves_a_ledger_row(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    let me = user(&pool).await;
    fund(&pool, me, 10 * DOLLAR).await;
    let event = usage_event(&pool, me).await;

    let charged = charge_request(&pool, request(event, me, Some("gpt-6-sol")))
        .await
        .unwrap();

    assert_eq!(charged, 24_420);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 10 * DOLLAR - 24_420);
    assert_eq!(
        ledger(&pool, me).await,
        [
            ("top_up".to_owned(), 10 * DOLLAR, 10 * DOLLAR, None),
            (
                "usage".to_owned(),
                24_420,
                10 * DOLLAR - 24_420,
                Some(event)
            ),
        ]
    );
}

#[sqlx::test]
async fn a_request_with_no_token_counts_costs_nothing(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let event = usage_event(&pool, me).await;
    let mut unknown = request(event, me, Some("gpt-6-sol"));
    unknown.tokens = Tokens::default();

    assert_eq!(charge_request(&pool, unknown).await.unwrap(), 0);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), DOLLAR);
    assert_eq!(ledger(&pool, me).await.len(), 1, "only the top-up");
}

#[sqlx::test]
async fn an_event_is_charged_once(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let event = usage_event(&pool, me).await;

    let first = charge_request(&pool, request(event, me, Some("gpt-6-sol")))
        .await
        .unwrap();
    let again = charge_request(&pool, request(event, me, Some("gpt-6-sol")))
        .await
        .unwrap();

    assert_eq!((first, again), (24_420, 0));
    assert_eq!(wallet::read(&pool, me).await.unwrap(), DOLLAR - 24_420);
    assert_eq!(
        ledger(&pool, me).await.len(),
        2,
        "the top-up and one charge"
    );
}

#[sqlx::test]
async fn a_charge_never_takes_more_than_is_left(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    let me = user(&pool).await;
    // Less than one request costs.
    fund(&pool, me, 10_000).await;
    let event = usage_event(&pool, me).await;

    let charged = charge_request(&pool, request(event, me, Some("gpt-6-sol")))
        .await
        .unwrap();

    assert_eq!(charged, 10_000, "what was left, not the 24,420 it cost");
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert_eq!(
        ledger(&pool, me).await.last().cloned(),
        Some(("usage".to_owned(), 10_000, 0, Some(event)))
    );

    let next = usage_event(&pool, me).await;
    assert_eq!(
        charge_request(&pool, request(next, me, Some("gpt-6-sol")))
            .await
            .unwrap(),
        0,
        "an empty wallet has nothing to take"
    );
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn a_model_with_its_own_price_is_charged_that_price(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    sqlx::query(
        "INSERT INTO service_model_prices
         (provider, model, input_micro_per_million, cached_micro_per_million, output_micro_per_million)
         VALUES ('chatgpt', 'gpt-6-sol', 1000000, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;

    // 8,000 new input tokens at $1 per million; cached and output are free.
    let own = usage_event(&pool, me).await;
    assert_eq!(
        charge_request(&pool, request(own, me, Some("gpt-6-sol")))
            .await
            .unwrap(),
        8_000
    );
    // Another model of the same agent still costs the default.
    let other = usage_event(&pool, me).await;
    assert_eq!(
        charge_request(&pool, request(other, me, Some("gpt-6-luna")))
            .await
            .unwrap(),
        24_420
    );
}

#[sqlx::test]
async fn an_agent_with_its_own_price_charges_its_models_that_price(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    sqlx::query(
        "INSERT INTO service_prices
         (provider, input_micro_per_million, cached_micro_per_million, output_micro_per_million)
         VALUES ('chatgpt', 2000000, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let event = usage_event(&pool, me).await;

    // 8,000 new input tokens at $2 per million.
    assert_eq!(
        charge_request(&pool, request(event, me, Some("gpt-6-luna")))
            .await
            .unwrap(),
        16_000
    );
}

#[sqlx::test]
async fn an_effort_variant_is_charged_the_price_of_its_model(pool: PgPool) {
    price_everything_at_the_default(&pool).await;
    sqlx::query(
        "INSERT INTO service_model_prices
         (provider, model, input_micro_per_million, cached_micro_per_million, output_micro_per_million)
         VALUES ('gemini', 'gemini-4-argon', 1000000, 0, 0)",
    )
    .execute(&pool)
    .await
    .unwrap();
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let event = usage_event(&pool, me).await;
    let mut gemini = request(event, me, Some("models/gemini-4-argon-high"));
    gemini.provider = AgentProvider::Gemini;

    assert_eq!(charge_request(&pool, gemini).await.unwrap(), 8_000);
}

#[sqlx::test]
async fn two_charges_that_overlap_cannot_take_more_than_the_wallet_holds(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let first = usage_event(&pool, me).await;
    let second = usage_event(&pool, me).await;

    // Hold the wallet's row, so that both charges are in flight at the same time.
    let mut holder = pool.begin().await.unwrap();
    sqlx::query("SELECT wallet_micro FROM service_wallets WHERE user_id = $1 FOR UPDATE")
        .bind(me)
        .fetch_one(&mut *holder)
        .await
        .unwrap();
    let charges = [first, second].map(|event| {
        let pool = pool.clone();
        tokio::spawn(async move { wallet::charge(&pool, me, event, 700_000).await.unwrap() })
    });
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            let waiting: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM pg_stat_activity
                 WHERE datname = current_database() AND wait_event_type = 'Lock'",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting >= 2 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("both charges should be waiting for the wallet");
    holder.commit().await.unwrap();

    let mut taken = 0;
    for charge in charges {
        taken += charge.await.unwrap();
    }

    // One takes 700,000, the other what was left of the dollar.
    assert_eq!(taken, DOLLAR);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    let charged_in_ledger: i64 = ledger(&pool, me)
        .await
        .iter()
        .filter(|row| row.0 == "usage")
        .map(|row| row.1)
        .sum();
    assert_eq!(charged_in_ledger, DOLLAR);
}

#[sqlx::test]
async fn a_request_that_is_not_a_service_keys_is_let_through_whatever_it_names(pool: PgPool) {
    for model in [Some("not-a-model"), None] {
        authorize_request(&pool, None, AgentProvider::Chatgpt, model)
            .await
            .unwrap();
    }
}

#[sqlx::test]
async fn a_service_request_must_name_a_model_on_the_price_list(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;

    for model in [None, Some("not-a-model"), Some("")] {
        assert!(
            matches!(
                authorize_request(&pool, Some(me), AgentProvider::Chatgpt, model).await,
                Err(ApiError::Validation(_))
            ),
            "{model:?}"
        );
    }
    // A real model, but of another agent.
    assert!(matches!(
        authorize_request(&pool, Some(me), AgentProvider::Claude, Some("gpt-6-sol")).await,
        Err(ApiError::Validation(_))
    ));
    authorize_request(&pool, Some(me), AgentProvider::Chatgpt, Some("gpt-6-sol"))
        .await
        .unwrap();
    authorize_request(
        &pool,
        Some(me),
        AgentProvider::Gemini,
        Some("models/gemini-4-argon-high"),
    )
    .await
    .unwrap();
}

#[sqlx::test]
async fn a_service_request_needs_the_minimum_balance(pool: PgPool) {
    let me = user(&pool).await;
    let ask = || authorize_request(&pool, Some(me), AgentProvider::Chatgpt, Some("gpt-6-sol"));

    assert!(matches!(ask().await, Err(ApiError::InsufficientBalance)));

    fund(&pool, me, MIN_BALANCE_MICRO - 1).await;
    assert!(matches!(ask().await, Err(ApiError::InsufficientBalance)));

    fund(&pool, me, 1).await;
    ask().await.unwrap();
}

/// The price of a model in a pricing answer, as input, cached and output.
fn price_in(
    pricing: &super::ServicePricing,
    provider: &str,
    model: &str,
) -> Option<(i64, i64, i64)> {
    pricing
        .providers
        .iter()
        .find(|entry| entry.provider.to_string() == provider)?
        .models
        .iter()
        .find(|candidate| candidate.id == model)
        .map(|candidate| {
            (
                candidate.price.input_micro_per_million,
                candidate.price.cached_micro_per_million,
                candidate.price.output_micro_per_million,
            )
        })
}

#[sqlx::test]
async fn pricing_lists_every_agent_with_the_models_of_the_price_list(pool: PgPool) {
    let pricing = pricing(State(state(pool, true))).await.unwrap().0;

    assert_eq!(pricing.currency, "USD");
    assert!(pricing.test_top_up);
    assert_eq!(pricing.min_balance_micro, MIN_BALANCE_MICRO);
    assert_eq!(
        pricing
            .providers
            .iter()
            .map(|provider| provider.provider.to_string())
            .collect::<Vec<_>>(),
        ["chatgpt", "gemini", "claude", "deepseek", "grok", "groq"]
    );
    for provider in &pricing.providers {
        assert!(
            !provider.models.is_empty(),
            "{} has models",
            provider.provider
        );
    }
    assert_eq!(pricing.providers[0].label, "ChatGPT");
    assert_eq!(
        pricing.providers[0]
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        [
            "gpt-6-astra",
            "gpt-6-sol",
            "gpt-6-luna",
            "gpt-5.6-sol",
            "gpt-5.6-terra",
            "gpt-5.6-luna"
        ],
        "in the order of the price list"
    );
    assert_eq!(pricing.providers[0].models[0].name, "GPT-6 Astra");
}

#[sqlx::test]
async fn the_price_list_starts_with_the_official_price_of_each_model(pool: PgPool) {
    let pricing = pricing(State(state(pool, true))).await.unwrap().0;
    let dollars = |input: f64, cached: f64, output: f64| {
        let micro = |dollars: f64| (dollars * 1_000_000.0).round() as i64;
        (micro(input), micro(cached), micro(output))
    };

    for (provider, model, price) in [
        ("chatgpt", "gpt-6-astra", dollars(10.0, 1.0, 50.0)),
        ("chatgpt", "gpt-6-sol", dollars(2.0, 0.20, 10.0)),
        ("chatgpt", "gpt-6-luna", dollars(0.10, 0.01, 0.50)),
        ("claude", "claude-fable-5-1", dollars(10.0, 0.25, 50.0)),
        ("claude", "claude-opus-5-5", dollars(4.0, 0.20, 20.0)),
        ("gemini", "gemini-4-argon", dollars(2.0, 0.10, 10.0)),
        ("gemini", "gemini-3.1-pro", dollars(2.0, 0.20, 12.0)),
        ("deepseek", "deepseek-flash", dollars(0.30, 0.006, 1.20)),
        ("deepseek", "deepseek-v4-pro", dollars(1.32, 0.044, 3.96)),
        ("grok", "grok-4.7", dollars(2.0, 0.50, 6.0)),
        ("groq", "openai/gpt-oss-120b", dollars(0.15, 0.15, 0.60)),
    ] {
        assert_eq!(price_in(&pricing, provider, model), Some(price), "{model}");
    }
}

#[sqlx::test]
async fn a_model_with_no_settled_price_is_in_the_list_but_not_on_sale(pool: PgPool) {
    let pricing = pricing(State(state(pool.clone(), true))).await.unwrap().0;
    let unlisted: Vec<String> = sqlx::query_scalar(
        "SELECT provider || '/' || model FROM service_model_prices
         WHERE NOT listed ORDER BY provider, model",
    )
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        unlisted,
        [
            "gemini/claude-opus-4-6-thinking",
            "gemini/claude-sonnet-4-6",
            "gemini/gemini-3.7-flash",
            "gemini/gpt-oss-120b"
        ]
    );
    for model in ["gemini-3.7-flash", "claude-sonnet-4-6", "gpt-oss-120b"] {
        assert_eq!(price_in(&pricing, "gemini", model), None, "{model}");
    }
}

#[sqlx::test]
async fn pricing_follows_the_rows_of_the_price_list(pool: PgPool) {
    // What the dashboard will do: add a model, unlist one and change a price.
    list_model(&pool, "chatgpt", "gpt-7-new", true, (1, 2, 3)).await;
    list_model(&pool, "chatgpt", "gpt-6-luna", false, (1, 2, 3)).await;
    list_model(&pool, "chatgpt", "gpt-6-sol", true, (10, 20, 30)).await;

    let pricing = pricing(State(state(pool, true))).await.unwrap().0;

    assert_eq!(price_in(&pricing, "chatgpt", "gpt-7-new"), Some((1, 2, 3)));
    assert_eq!(price_in(&pricing, "chatgpt", "gpt-6-luna"), None);
    assert_eq!(
        price_in(&pricing, "chatgpt", "gpt-6-sol"),
        Some((10, 20, 30))
    );
    assert_eq!(
        pricing.providers[0]
            .models
            .last()
            .map(|model| model.id.as_str()),
        Some("gpt-7-new"),
        "a new row comes after the seeded ones"
    );
}

#[sqlx::test]
async fn a_row_with_no_name_is_shown_by_its_id(pool: PgPool) {
    sqlx::query(
        "INSERT INTO service_model_prices
         (provider, model, input_micro_per_million, cached_micro_per_million,
          output_micro_per_million)
         VALUES ('grok', 'grok-9', 1, 1, 1)",
    )
    .execute(&pool)
    .await
    .unwrap();

    let pricing = pricing(State(state(pool, true))).await.unwrap().0;
    let grok = pricing
        .providers
        .iter()
        .find(|provider| provider.provider == AgentProvider::Grok)
        .unwrap();

    assert_eq!(
        grok.models
            .iter()
            .find(|model| model.id == "grok-9")
            .map(|model| model.name.as_str()),
        Some("grok-9")
    );
}

#[sqlx::test]
async fn the_effort_variants_of_a_model_are_sold_as_the_model(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let pricing = pricing(State(state(pool.clone(), true))).await.unwrap().0;
    let gemini = pricing
        .providers
        .iter()
        .find(|provider| provider.provider == AgentProvider::Gemini)
        .unwrap();

    assert!(
        gemini
            .models
            .iter()
            .all(|model| !["-high", "-medium", "-low"]
                .iter()
                .any(|effort| model.id.ends_with(effort))),
        "no variant is listed on its own"
    );
    let ids: HashSet<&str> = gemini
        .models
        .iter()
        .map(|model| model.id.as_str())
        .collect();
    assert_eq!(ids.len(), gemini.models.len(), "no model is listed twice");
    for variant in [
        "gemini-4-argon-high",
        "gemini-4-argon-low",
        "models/gemini-4-argon-medium",
    ] {
        authorize_request(&pool, Some(me), AgentProvider::Gemini, Some(variant))
            .await
            .unwrap_or_else(|error| panic!("{variant} refused: {error:?}"));
    }
}

#[sqlx::test]
async fn a_model_that_is_not_listed_is_refused_but_a_request_already_served_is_still_charged(
    pool: PgPool,
) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    list_model(&pool, "chatgpt", "gpt-6-sol", true, (1_000_000, 0, 0)).await;
    authorize_request(&pool, Some(me), AgentProvider::Chatgpt, Some("gpt-6-sol"))
        .await
        .unwrap();

    // The row is taken off sale while a request is on its way.
    list_model(&pool, "chatgpt", "gpt-6-sol", false, (1_000_000, 0, 0)).await;

    assert!(matches!(
        authorize_request(&pool, Some(me), AgentProvider::Chatgpt, Some("gpt-6-sol")).await,
        Err(ApiError::Validation(_))
    ));
    let event = usage_event(&pool, me).await;
    assert_eq!(
        charge_request(&pool, request(event, me, Some("gpt-6-sol")))
            .await
            .unwrap(),
        8_000,
        "charged at the price of its row, not the default"
    );
}

#[sqlx::test]
async fn a_new_row_makes_a_model_a_service_key_may_use(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let ask = || authorize_request(&pool, Some(me), AgentProvider::Grok, Some("grok-9"));

    assert!(matches!(ask().await, Err(ApiError::Validation(_))));

    list_model(&pool, "grok", "grok-9", true, (1, 1, 1)).await;
    ask().await.unwrap();
    // The same id under another agent is another model.
    assert!(matches!(
        authorize_request(&pool, Some(me), AgentProvider::Groq, Some("grok-9")).await,
        Err(ApiError::Validation(_))
    ));
}

#[sqlx::test]
async fn every_listed_model_is_one_a_service_key_may_use(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, DOLLAR).await;
    let listed = pricing(State(state(pool.clone(), true))).await.unwrap().0;

    for provider in &listed.providers {
        for model in &provider.models {
            authorize_request(&pool, Some(me), provider.provider, Some(&model.id))
                .await
                .unwrap_or_else(|error| {
                    panic!("{} {} refused: {error:?}", provider.provider, model.id)
                });
        }
    }
}

#[sqlx::test]
async fn deleting_a_user_removes_their_wallet_and_ledger(pool: PgPool) {
    let me = user(&pool).await;
    fund(&pool, me, 5 * DOLLAR).await;

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(me)
        .execute(&pool)
        .await
        .unwrap();

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert!(ledger(&pool, me).await.is_empty());
}

#[sqlx::test]
async fn pricing_says_which_agents_the_stock_can_serve_now(pool: PgPool) {
    let platform = user(&pool).await;
    let stock = |provider: &'static str, status: &'static str, in_stock: bool| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO agent_connections
                 (id, user_id, provider, status, service_stock, availability_status)
                 VALUES ($1, $2, $3, 'connected', $4, $5)",
            )
            .bind(Uuid::new_v4())
            .bind(platform)
            .bind(provider)
            .bind(in_stock)
            .bind(status)
            .execute(&pool)
            .await
            .unwrap();
        }
    };
    // ChatGPT: in the stock and active. Claude: in the stock but waiting for its
    // owner to reconnect it. Gemini: connected, but not in the stock. Groq: in the
    // stock and only rate limited, which passes.
    stock("chatgpt", "active", true).await;
    stock("claude", "reauth_required", true).await;
    stock("gemini", "active", false).await;
    stock("groq", "rate_limited", true).await;

    let pricing = pricing(State(state(pool, true))).await.unwrap().0;
    let available: Vec<String> = pricing
        .providers
        .iter()
        .filter(|provider| provider.available)
        .map(|provider| provider.provider.to_string())
        .collect();

    assert_eq!(available, ["chatgpt", "groq"]);
}
