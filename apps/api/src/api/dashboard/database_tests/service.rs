//! Hub William's tickets and price list, as the dashboard and its customers use them.

use std::sync::{Arc, Mutex};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use axum::{
    Json, Router,
    body::Body,
    http::{HeaderMap, Request, StatusCode},
    routing::get,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    api::app,
    core::{AppConfig, AppState},
};

use super::{Account, account, call, owner_and_state};

/// What the fake provider is asked through: the API keys it saw, in order.
type Seen = Arc<Mutex<Vec<String>>>;

/// A provider that lists its models for a key that starts with `good-` and refuses any
/// other, at the address both DeepSeek's and Groq's gateway calls go to.
async fn fake_provider() -> (String, Seen) {
    let seen = Seen::default();
    let recorder = seen.clone();
    let app = Router::new().route(
        "/models",
        get(move |headers: HeaderMap| {
            let recorder = recorder.clone();

            async move {
                let token = headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                    .and_then(|value| value.strip_prefix("Bearer "))
                    .unwrap_or_default()
                    .to_owned();
                let allowed = token.starts_with("good-");

                recorder.lock().unwrap().push(token);

                if allowed {
                    (
                        StatusCode::OK,
                        Json(json!({ "data": [{ "id": "deepseek-flash" }] })),
                    )
                } else {
                    (
                        StatusCode::UNAUTHORIZED,
                        Json(json!({ "error": { "message": "refused" } })),
                    )
                }
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());

    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    (url, seen)
}

/// The shop's owner and a state whose DeepSeek and Groq are the fake provider.
async fn shop(pool: PgPool) -> (AppState, Account, Seen) {
    let (mut state, owner) = owner_and_state(pool).await;
    let (provider, seen) = fake_provider().await;

    state.config.deepseek_api_url = provider.clone();
    state.config.groq_api_url = provider;

    (state, owner, seen)
}

/// Stores `token` as the API key of `connection`, as connecting it would.
async fn store_token(pool: &PgPool, connection: Uuid, token: &str) {
    let cipher =
        Aes256Gcm::new_from_slice(&AppConfig::default().credential_encryption_key).unwrap();
    let nonce: [u8; 12] = Uuid::new_v4().as_bytes()[..12].try_into().unwrap();
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            json!({ "access_token": token }).to_string().as_bytes(),
        )
        .unwrap();

    sqlx::query(
        "INSERT INTO agent_connection_credentials
            (connection_id, credential_ciphertext, credential_nonce, access_token_expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')
         ON CONFLICT (connection_id) DO UPDATE
         SET credential_ciphertext = $2, credential_nonce = $3",
    )
    .bind(connection)
    .bind(ciphertext)
    .bind(nonce.to_vec())
    .execute(pool)
    .await
    .unwrap();
}

/// A connection of `owner` that the fake provider answers, connected unless told
/// otherwise, whose API key is `token`.
async fn connection_with(
    pool: &PgPool,
    owner: &Account,
    provider: &str,
    status: &str,
    token: &str,
) -> Uuid {
    let id = Uuid::new_v4();

    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label, plan)
         VALUES ($1, $2, $3, $4, 'Shop account', 'Plus')",
    )
    .bind(id)
    .bind(owner.id)
    .bind(provider)
    .bind(status)
    .execute(pool)
    .await
    .unwrap();
    store_token(pool, id, token).await;

    id
}

async fn connection(pool: &PgPool, owner: &Account, provider: &str, status: &str) -> Uuid {
    connection_with(pool, owner, provider, status, "good-seller").await
}

/// Puts `money` micro-dollars in `buyer`'s wallet.
async fn fund(pool: &PgPool, buyer: &Account, money: i64) {
    sqlx::query(
        "INSERT INTO service_wallets (user_id, wallet_micro) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET wallet_micro = $2",
    )
    .bind(buyer.id)
    .bind(money)
    .execute(pool)
    .await
    .unwrap();
}

async fn wallet(pool: &PgPool, buyer: &Account) -> i64 {
    sqlx::query_scalar("SELECT wallet_micro FROM service_wallets WHERE user_id = $1")
        .bind(buyer.id)
        .fetch_optional(pool)
        .await
        .unwrap()
        .unwrap_or(0)
}

const PRICE: i64 = 4_000_000;

fn terms(connection: Uuid) -> Value {
    json!({
        "connection_id": connection,
        "days": 7,
        "name": "Shop account · 7 ngày",
        "price_micro": PRICE,
    })
}

/// Verifies and puts `connection` on sale, as the dashboard does.
async fn sell(state: &AppState, by: &Account, connection: Uuid) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/dashboard/service/listings",
        Some(&by.cookie),
        Some(terms(connection)),
    )
    .await
}

async fn listed(state: &AppState, by: &Account) -> Vec<Value> {
    let (status, body) = call(
        state,
        "GET",
        "/dashboard/service/listings",
        Some(&by.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    body["listings"].as_array().unwrap().clone()
}

async fn for_sale(state: &AppState) -> Vec<Value> {
    let (status, body) = call(state, "GET", "/service/listings", None, None).await;

    assert_eq!(status, StatusCode::OK);
    body["providers"].as_array().unwrap().clone()
}

async fn buy(state: &AppState, buyer: &Account, listing: &str) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        &format!("/service/listings/{listing}/purchase"),
        Some(&buyer.cookie),
        None,
    )
    .await
}

/// A request a customer sends the gateway with a ticket's key: the model list.
async fn use_key(state: &AppState, provider: &str, key: &str) -> StatusCode {
    let uri = match provider {
        "groq" => "/gateway/groq/v1/models",
        _ => "/gateway/deepseek/models",
    };

    app(state.clone())
        .oneshot(
            Request::builder()
                .method("GET")
                .uri(uri)
                .header("authorization", format!("Bearer {key}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
        .status()
}

/// A ticket on sale and bought: the listing's id and the key the customer got.
async fn bought(
    state: &AppState,
    seller: &Account,
    buyer: &Account,
    connection: Uuid,
) -> (String, String) {
    let (status, created) = sell(state, seller, connection).await;
    assert_eq!(status, StatusCode::CREATED, "{created}");
    let id = created["id"].as_str().unwrap().to_owned();
    let (status, purchase) = buy(state, buyer, &id).await;
    assert_eq!(status, StatusCode::CREATED, "{purchase}");

    (id, purchase["key"].as_str().unwrap().to_owned())
}

// ------------------------------------------------------------------ verifying

#[sqlx::test]
async fn an_account_of_the_member_that_the_provider_answers_for_is_verified(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;

    let (status, verified) = call(
        &state,
        "POST",
        "/dashboard/service/verify",
        Some(&owner.cookie),
        Some(json!({ "connection_id": id })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{verified}");
    assert_eq!(verified["provider"], "deepseek");
    assert_eq!(verified["account_label"], "Shop account");
    assert_eq!(verified["plan"], "Plus");
    // DeepSeek does not say what an account has left.
    assert_eq!(verified["quota"], json!([]));
    assert!(verified["captured_at"].is_string());
    assert_eq!(*seen.lock().unwrap(), ["good-seller"]);
}

#[sqlx::test]
async fn an_account_the_provider_refuses_is_not_verified(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection_with(&pool, &owner, "deepseek", "connected", "bad-seller").await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/service/verify",
        Some(&owner.cookie),
        Some(json!({ "connection_id": id })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(body["code"], "provider_unavailable");
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("did not answer a test request"),
        "{body}"
    );
}

#[sqlx::test]
async fn an_account_that_is_not_the_members_own_or_not_connected_is_not_verified(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let theirs = connection(&pool, &keeper, "deepseek", "connected").await;
    let pending = connection(&pool, &owner, "deepseek", "pending").await;

    for (what, id) in [
        ("another member's account", theirs),
        ("an account not connected yet", pending),
        ("an account that does not exist", Uuid::new_v4()),
    ] {
        let (status, body) = call(
            &state,
            "POST",
            "/dashboard/service/verify",
            Some(&owner.cookie),
            Some(json!({ "connection_id": id })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{what}");
        assert_eq!(body["code"], "validation_error", "{what}");
    }
}

#[sqlx::test]
async fn an_answer_from_another_account_of_the_member_does_not_verify_this_one(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    // This account is refused, but the member has another for the same agent that
    // answers, and the gateway would fail over to it for the member's own use.
    let refused = connection_with(&pool, &owner, "deepseek", "connected", "bad-seller").await;
    connection(&pool, &owner, "deepseek", "connected").await;

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/service/verify",
        Some(&owner.cookie),
        Some(json!({ "connection_id": refused })),
    )
    .await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
}

// --------------------------------------------------------------- putting on sale

#[sqlx::test]
async fn a_verified_account_goes_on_sale_with_its_terms(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;

    let (status, created) = sell(&state, &owner, id).await;

    assert_eq!(status, StatusCode::CREATED, "{created}");
    assert_eq!(created["provider"], "deepseek");
    assert_eq!(created["name"], "Shop account · 7 ngày");
    assert_eq!(created["days"], 7);
    assert_eq!(created["price_micro"], PRICE);
    assert_eq!(created["status"], "for_sale");
    assert_eq!(created["listed"], true);
    assert_eq!(created["seller"], owner.username);
    assert_eq!(created["account_label"], "Shop account");
    assert_eq!(created["plan"], "Plus");
    assert!(created["quota_captured_at"].is_string());
    assert_eq!(listed(&state, &owner).await.len(), 1);
}

#[sqlx::test]
async fn an_account_is_tried_again_as_it_is_put_on_sale_and_a_refused_one_is_not(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection_with(&pool, &owner, "deepseek", "connected", "bad-seller").await;

    let (status, body) = sell(&state, &owner, id).await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert!(listed(&state, &owner).await.is_empty());
}

#[sqlx::test]
async fn an_account_is_on_sale_once_at_a_time(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    assert_eq!(sell(&state, &owner, id).await.0, StatusCode::CREATED);
    let asked = seen.lock().unwrap().len();

    let (status, body) = sell(&state, &owner, id).await;

    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["code"], "already_exists");
    // And the provider was not asked again for what is there already.
    assert_eq!(seen.lock().unwrap().len(), asked);
    assert_eq!(listed(&state, &owner).await.len(), 1);
}

#[sqlx::test]
async fn terms_that_are_not_valid_put_nothing_on_sale(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;

    for (what, name, days, price) in [
        ("no name", "  ", 7, PRICE),
        ("a name of 81 characters", &"x".repeat(81), 7, PRICE),
        ("no days", "Plan", 0, PRICE),
        ("366 days", "Plan", 366, PRICE),
        ("a price of nothing", "Plan", 7, 0),
        ("a price under a cent", "Plan", 7, 5_000),
        ("a price that is not whole cents", "Plan", 7, 4_005_000),
        ("a price above $10,000", "Plan", 7, 10_010_000_000),
    ] {
        let (status, body) = call(
            &state,
            "POST",
            "/dashboard/service/listings",
            Some(&owner.cookie),
            Some(json!({
                "connection_id": id, "days": days, "name": name, "price_micro": price
            })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{what}: {body}");
        assert_eq!(body["code"], "validation_error", "{what}");
    }
    assert!(listed(&state, &owner).await.is_empty());
}

#[sqlx::test]
async fn the_edges_of_the_terms_are_allowed(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;

    for (name, days, price) in [
        ("Shortest", 1, 10_000_i64),
        ("Longest", 365, 10_000_000_000_i64),
    ] {
        let id = connection(&pool, &owner, "deepseek", "connected").await;
        let (status, body) = call(
            &state,
            "POST",
            "/dashboard/service/listings",
            Some(&owner.cookie),
            Some(json!({
                "connection_id": id, "days": days, "name": name, "price_micro": price
            })),
        )
        .await;

        assert_eq!(status, StatusCode::CREATED, "{name}: {body}");
    }
}

#[sqlx::test]
async fn an_account_sold_to_a_customer_cannot_be_put_on_sale_again_until_their_key_ends(
    pool: PgPool,
) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    bought(&state, &owner, &buyer, id).await;

    let (status, body) = sell(&state, &owner, id).await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    sqlx::query(
        "UPDATE gateway_keys SET expires_at = NOW() - INTERVAL '1 minute' WHERE user_id = $1",
    )
    .bind(buyer.id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(sell(&state, &owner, id).await.0, StatusCode::CREATED);
}

#[sqlx::test]
async fn the_status_says_why_a_ticket_is_not_for_sale(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let hidden = connection(&pool, &owner, "deepseek", "connected").await;
    let lapsed = connection(&pool, &owner, "groq", "connected").await;
    let gone = connection(&pool, &owner, "deepseek", "connected").await;
    let hidden_listing = sell(&state, &owner, hidden).await.1;
    let lapsed_listing = sell(&state, &owner, lapsed).await.1;
    let gone_listing = sell(&state, &owner, gone).await.1;

    sqlx::query("UPDATE service_listings SET listed = FALSE WHERE id = $1::uuid")
        .bind(hidden_listing["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_connections SET availability_status = 'reauth_required' WHERE id = $1",
    )
    .bind(lapsed)
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query("DELETE FROM agent_connections WHERE id = $1")
        .bind(gone)
        .execute(&pool)
        .await
        .unwrap();

    let all = listed(&state, &owner).await;
    let status_of = |listing: &Value| {
        all.iter().find(|row| row["id"] == listing["id"]).unwrap()["status"].clone()
    };

    assert_eq!(status_of(&hidden_listing), "hidden");
    assert_eq!(status_of(&lapsed_listing), "needs_reconnect");
    assert_eq!(status_of(&gone_listing), "disconnected");
    // None of them is for sale to a customer, but the staff still see them.
    assert!(for_sale(&state).await.is_empty());
}

// ------------------------------------------------------------------- editing

#[sqlx::test]
async fn a_ticket_that_is_not_sold_can_be_edited_and_switched_off(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let uri = format!(
        "/dashboard/service/listings/{}",
        created["id"].as_str().unwrap()
    );

    let (status, updated) = call(
        &state,
        "PUT",
        &uri,
        Some(&owner.cookie),
        Some(json!({
            "days": 30, "listed": false, "name": "Renamed", "price_micro": 9_990_000
        })),
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{updated}");
    assert_eq!(updated["name"], "Renamed");
    assert_eq!(updated["days"], 30);
    assert_eq!(updated["price_micro"], 9_990_000);
    assert_eq!(updated["listed"], false);
    assert_eq!(updated["status"], "hidden");
    assert!(for_sale(&state).await.is_empty());

    let (status, _) = call(
        &state,
        "PUT",
        &uri,
        Some(&owner.cookie),
        Some(json!({ "days": 0, "listed": true, "name": "Bad", "price_micro": PRICE })),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn a_ticket_is_taken_off_sale_and_the_account_is_left_as_it_was(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let uri = format!(
        "/dashboard/service/listings/{}",
        created["id"].as_str().unwrap()
    );

    let (status, _) = call(&state, "DELETE", &uri, Some(&owner.cookie), None).await;

    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(listed(&state, &owner).await.is_empty());
    assert_eq!(
        call(&state, "DELETE", &uri, Some(&owner.cookie), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    let kept: String = sqlx::query_scalar("SELECT status FROM agent_connections WHERE id = $1")
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, "connected");
    // And it can be put on sale again.
    assert_eq!(sell(&state, &owner, id).await.0, StatusCode::CREATED);
}

#[sqlx::test]
async fn a_ticket_that_is_sold_is_no_longer_in_the_stock_to_edit_or_delete(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (listing, _) = bought(&state, &owner, &buyer, id).await;
    let uri = format!("/dashboard/service/listings/{listing}");

    assert!(listed(&state, &owner).await.is_empty());
    assert_eq!(
        call(
            &state,
            "PUT",
            &uri,
            Some(&owner.cookie),
            Some(json!({ "days": 1, "listed": true, "name": "X", "price_micro": PRICE })),
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        call(&state, "DELETE", &uri, Some(&owner.cookie), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // And what was sold is as it was sold: the refusal changed nothing.
    let kept: (String, i32, i64) =
        sqlx::query_as("SELECT name, days, price_micro FROM service_listings WHERE id = $1::uuid")
            .bind(&listing)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kept, ("Shop account · 7 ngày".to_owned(), 7, PRICE));
}

// ------------------------------------------------------------------ the shop window

#[sqlx::test]
async fn only_tickets_for_sale_are_shown_and_an_agent_with_none_has_no_card(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let first = connection(&pool, &owner, "groq", "connected").await;
    let second = connection(&pool, &owner, "deepseek", "connected").await;
    let third = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, first_listing) = sell(&state, &owner, first).await;
    sell(&state, &owner, second).await;
    let (_, hidden) = sell(&state, &owner, third).await;
    call(
        &state,
        "PUT",
        &format!(
            "/dashboard/service/listings/{}",
            hidden["id"].as_str().unwrap()
        ),
        Some(&owner.cookie),
        Some(json!({ "days": 7, "listed": false, "name": "Hidden", "price_micro": PRICE })),
    )
    .await;

    let window = for_sale(&state).await;

    // In the order of the Pricing page: DeepSeek before Groq; nothing for the rest.
    let agents: Vec<&str> = window
        .iter()
        .map(|p| p["provider"].as_str().unwrap())
        .collect();
    assert_eq!(agents, ["deepseek", "groq"]);
    assert_eq!(window[0]["label"], "DeepSeek");
    assert_eq!(window[0]["listings"].as_array().unwrap().len(), 1);
    let ticket = &window[1]["listings"][0];
    assert_eq!(ticket["id"], first_listing["id"]);
    assert_eq!(ticket["name"], "Shop account · 7 ngày");
    assert_eq!(ticket["days"], 7);
    assert_eq!(ticket["price_micro"], PRICE);
    // What the shop window says is the ticket, and nothing about who sells it or how.
    let text = window.iter().map(Value::to_string).collect::<String>();
    for private in [owner.username.as_str(), "connection", "seller", "key"] {
        assert!(!text.contains(private), "{private}: {text}");
    }
}

#[sqlx::test]
async fn nothing_for_sale_shows_no_card_at_all(pool: PgPool) {
    let (state, _, _) = shop(pool).await;

    assert!(for_sale(&state).await.is_empty());
}

#[sqlx::test]
async fn what_an_account_had_left_is_shown_as_it_was_read(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    sqlx::query("UPDATE service_listings SET quota = $2::jsonb WHERE id = $1::uuid")
        .bind(created["id"].as_str().unwrap())
        .bind(
            json!([
                { "label": "5-hour limit", "value": "80% left", "detail": "resets in 2h" },
                { "label": "Weekly limit", "value": "50% left", "detail": null }
            ])
            .to_string(),
        )
        .execute(&pool)
        .await
        .unwrap();

    let window = for_sale(&state).await;

    assert_eq!(
        window[0]["listings"][0]["quota"],
        json!([
            { "label": "5-hour limit", "value": "80% left", "detail": "resets in 2h" },
            { "label": "Weekly limit", "value": "50% left", "detail": null }
        ])
    );
    assert_eq!(
        listed(&state, &owner).await[0]["quota"][0]["value"],
        "80% left"
    );
}

// --------------------------------------------------------------------- buying

#[sqlx::test]
async fn a_customer_buys_a_ticket_with_the_wallet_and_gets_a_key_once(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let listing = created["id"].as_str().unwrap();

    let (status, ticket) = buy(&state, &buyer, listing).await;

    assert_eq!(status, StatusCode::CREATED, "{ticket}");
    let key = ticket["key"].as_str().unwrap();
    assert!(key.starts_with("hw_tkt_"), "{key}");
    assert_eq!(ticket["last_four"], key[key.len() - 4..]);
    assert_eq!(ticket["name"], "Shop account · 7 ngày");
    assert_eq!(ticket["provider"], "deepseek");
    assert_eq!(ticket["days"], 7);
    assert_eq!(ticket["price_micro"], PRICE);
    let ends =
        chrono::DateTime::parse_from_rfc3339(ticket["expires_at"].as_str().unwrap()).unwrap();
    let days = (ends.with_timezone(&chrono::Utc) - chrono::Utc::now()).num_hours();
    assert!((166..=168).contains(&days), "{days} hours");
    // The wallet paid once, with a ledger row for it.
    assert_eq!(wallet(&pool, &buyer).await, 10_000_000 - PRICE);
    let ledger: (String, i64, i64) = sqlx::query_as(
        "SELECT kind, amount_micro, wallet_after_micro FROM service_ledger WHERE user_id = $1",
    )
    .bind(buyer.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(ledger, ("purchase".to_owned(), PRICE, 10_000_000 - PRICE));
    // It left the shop window and the inventory, and is in the history.
    assert!(for_sale(&state).await.is_empty());
    assert!(listed(&state, &owner).await.is_empty());
    // Only its hash is kept.
    let kept: Vec<u8> = sqlx::query_scalar("SELECT key_hash FROM gateway_keys WHERE user_id = $1")
        .bind(buyer.id)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_ne!(kept, key.as_bytes());
    assert_eq!(kept.len(), 32);
}

#[sqlx::test]
async fn a_ticket_is_sold_to_one_customer_only(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let first = account(&pool, None).await;
    let second = account(&pool, None).await;
    fund(&pool, &first, 10_000_000).await;
    fund(&pool, &second, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (listing, _) = bought(&state, &owner, &first, id).await;

    let (status, _) = buy(&state, &second, &listing).await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        wallet(&pool, &second).await,
        10_000_000,
        "nothing was charged"
    );
}

#[sqlx::test]
async fn two_customers_pressing_buy_together_leave_one_with_the_ticket(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let first = account(&pool, None).await;
    let second = account(&pool, None).await;
    fund(&pool, &first, 10_000_000).await;
    fund(&pool, &second, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let listing = created["id"].as_str().unwrap();

    let ((one, _), (two, _)) =
        tokio::join!(buy(&state, &first, listing), buy(&state, &second, listing));

    let mut statuses = [one, two];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::CREATED, StatusCode::NOT_FOUND]);
    let kept: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_keys WHERE kind = 'ticket'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(kept, 1);
    let charged: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM service_ledger WHERE kind = 'purchase'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(charged, 1);
}

#[sqlx::test]
async fn a_wallet_that_cannot_cover_the_price_buys_nothing(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, PRICE - 10_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;

    let (status, body) = buy(&state, &buyer, created["id"].as_str().unwrap()).await;

    assert_eq!(status, StatusCode::PAYMENT_REQUIRED, "{body}");
    assert_eq!(body["code"], "insufficient_balance");
    assert_eq!(wallet(&pool, &buyer).await, PRICE - 10_000);
    assert_eq!(for_sale(&state).await.len(), 1, "it is still for sale");
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_keys WHERE kind = 'ticket'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(keys, 0);
}

#[sqlx::test]
async fn a_customer_with_no_wallet_at_all_is_refused_the_same_way(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;

    let (status, _) = buy(&state, &buyer, created["id"].as_str().unwrap()).await;

    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
}

#[sqlx::test]
async fn a_customer_must_be_signed_in_and_cannot_buy_their_own_ticket(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    fund(&pool, &owner, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let listing = created["id"].as_str().unwrap();

    let (status, _) = call(
        &state,
        "POST",
        &format!("/service/listings/{listing}/purchase"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, body) = buy(&state, &owner, listing).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
    assert_eq!(wallet(&pool, &owner).await, 10_000_000);
}

#[sqlx::test]
async fn a_ticket_that_is_not_for_sale_cannot_be_bought(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let listing = created["id"].as_str().unwrap();

    assert_eq!(
        buy(&state, &buyer, &Uuid::new_v4().to_string()).await.0,
        StatusCode::NOT_FOUND
    );

    sqlx::query("UPDATE service_listings SET listed = FALSE WHERE id = $1::uuid")
        .bind(listing)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        buy(&state, &buyer, listing).await.0,
        StatusCode::NOT_FOUND,
        "switched off"
    );

    sqlx::query("UPDATE service_listings SET listed = TRUE WHERE id = $1::uuid")
        .bind(listing)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_connections SET availability_status = 'reauth_required' WHERE id = $1",
    )
    .bind(id)
    .execute(&pool)
    .await
    .unwrap();
    assert_eq!(
        buy(&state, &buyer, listing).await.0,
        StatusCode::NOT_FOUND,
        "to be connected again"
    );
    assert_eq!(wallet(&pool, &buyer).await, 10_000_000);
}

#[sqlx::test]
async fn an_account_that_stopped_answering_since_it_was_put_on_sale_is_not_charged_for(
    pool: PgPool,
) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    // The provider turns it away from now on.
    store_token(&pool, id, "bad-seller").await;

    let (status, body) = buy(&state, &buyer, created["id"].as_str().unwrap()).await;

    assert_eq!(status, StatusCode::BAD_GATEWAY, "{body}");
    assert_eq!(
        wallet(&pool, &buyer).await,
        10_000_000,
        "nothing was charged"
    );
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_keys WHERE kind = 'ticket'")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(keys, 0);
}

// --------------------------------------------------------------- using the key

#[sqlx::test]
async fn the_key_of_a_ticket_runs_on_its_account_and_costs_nothing_by_the_token(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection_with(&pool, &owner, "deepseek", "connected", "good-pinned").await;
    let (_, key) = bought(&state, &owner, &buyer, id).await;
    seen.lock().unwrap().clear();

    assert_eq!(use_key(&state, "deepseek", &key).await, StatusCode::OK);

    assert_eq!(*seen.lock().unwrap(), ["good-pinned"]);
    assert_eq!(wallet(&pool, &buyer).await, 10_000_000 - PRICE);
}

#[sqlx::test]
async fn the_key_of_a_ticket_is_served_by_that_account_and_no_other(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    // The account that is sold is refused from now on; the seller has another for the
    // same agent and the buyer has one of their own, and both would answer.
    let pinned = connection_with(&pool, &owner, "deepseek", "connected", "good-pinned").await;
    connection_with(&pool, &owner, "deepseek", "connected", "good-sellers-other").await;
    connection_with(&pool, &buyer, "deepseek", "connected", "good-buyers-own").await;
    let (_, key) = bought(&state, &owner, &buyer, pinned).await;
    store_token(&pool, pinned, "bad-pinned").await;
    seen.lock().unwrap().clear();

    let status = use_key(&state, "deepseek", &key).await;

    assert!(!status.is_success(), "{status}");
    // The gateway asks the same account again after a refusal, but never another one.
    let asked = seen.lock().unwrap().clone();
    assert!(!asked.is_empty());
    assert!(
        asked.iter().all(|token| token == "bad-pinned"),
        "no other account was tried: {asked:?}"
    );
}

#[sqlx::test]
async fn the_key_of_a_ticket_does_not_serve_another_agent(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    connection(&pool, &owner, "groq", "connected").await;
    let (_, key) = bought(&state, &owner, &buyer, id).await;
    seen.lock().unwrap().clear();

    let status = use_key(&state, "groq", &key).await;

    assert!(!status.is_success(), "{status}");
    assert!(seen.lock().unwrap().is_empty());
}

#[sqlx::test]
async fn the_key_of_a_ticket_stops_when_its_days_are_up(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, key) = bought(&state, &owner, &buyer, id).await;
    assert_eq!(use_key(&state, "deepseek", &key).await, StatusCode::OK);

    sqlx::query(
        "UPDATE gateway_keys SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1",
    )
    .bind(buyer.id)
    .execute(&pool)
    .await
    .unwrap();

    assert_eq!(
        use_key(&state, "deepseek", &key).await,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn a_key_of_another_kind_is_served_as_before_and_is_not_confined_to_a_listing(pool: PgPool) {
    let (state, owner, seen) = shop(pool.clone()).await;
    connection_with(&pool, &owner, "deepseek", "connected", "good-own").await;
    let key = crate::api::gateway::create_key_of_kind(
        &pool,
        owner.id,
        crate::api::gateway::KeyKind::Workspace,
        None,
    )
    .await
    .unwrap()
    .key;

    assert_eq!(use_key(&state, "deepseek", &key).await, StatusCode::OK);
    assert_eq!(*seen.lock().unwrap(), ["good-own"]);
}

// ------------------------------------------------------------- bought tickets

#[sqlx::test]
async fn a_customer_sees_the_tickets_they_bought_without_the_key(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    let other = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, key) = bought(&state, &owner, &buyer, id).await;

    let (status, mine) = call(&state, "GET", "/service/tickets", Some(&buyer.cookie), None).await;
    let (_, theirs) = call(&state, "GET", "/service/tickets", Some(&other.cookie), None).await;

    assert_eq!(status, StatusCode::OK);
    let tickets = mine["tickets"].as_array().unwrap();
    assert_eq!(tickets.len(), 1);
    assert_eq!(tickets[0]["name"], "Shop account · 7 ngày");
    assert_eq!(tickets[0]["status"], "active");
    assert_eq!(tickets[0]["price_micro"], PRICE);
    assert_eq!(tickets[0]["last_four"], key[key.len() - 4..]);
    assert!(!mine.to_string().contains(&key));
    assert!(theirs["tickets"].as_array().unwrap().is_empty());
    assert_eq!(
        call(&state, "GET", "/service/tickets", None, None).await.0,
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test]
async fn a_lost_key_is_replaced_by_a_new_one_for_the_same_ticket_and_the_old_one_stops(
    pool: PgPool,
) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    let stranger = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, key) = bought(&state, &owner, &buyer, id).await;
    let (_, mine) = call(&state, "GET", "/service/tickets", Some(&buyer.cookie), None).await;
    let key_id = mine["tickets"][0]["key_id"].as_str().unwrap();
    let uri = format!("/service/tickets/{key_id}/reissue");

    let (status, _) = call(&state, "POST", &uri, Some(&stranger.cookie), None).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "not theirs");
    assert_eq!(use_key(&state, "deepseek", &key).await, StatusCode::OK);

    let (status, again) = call(&state, "POST", &uri, Some(&buyer.cookie), None).await;

    assert_eq!(status, StatusCode::OK, "{again}");
    let new_key = again["key"].as_str().unwrap();
    assert_ne!(new_key, key);
    assert_eq!(
        use_key(&state, "deepseek", &key).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(use_key(&state, "deepseek", new_key).await, StatusCode::OK);
    // The same end, and still one ticket; nothing more was charged.
    assert_eq!(again["expires_at"], mine["tickets"][0]["expires_at"]);
    let (_, after) = call(&state, "GET", "/service/tickets", Some(&buyer.cookie), None).await;
    assert_eq!(after["tickets"].as_array().unwrap().len(), 1);
    assert_eq!(wallet(&pool, &buyer).await, 10_000_000 - PRICE);
    // The replaced key cannot be replaced again.
    assert_eq!(
        call(&state, "POST", &uri, Some(&buyer.cookie), None)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test]
async fn a_key_that_has_ended_is_not_replaced(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    bought(&state, &owner, &buyer, id).await;
    let (_, mine) = call(&state, "GET", "/service/tickets", Some(&buyer.cookie), None).await;
    let key_id = mine["tickets"][0]["key_id"].as_str().unwrap();
    sqlx::query(
        "UPDATE gateway_keys SET expires_at = NOW() - INTERVAL '1 second' WHERE user_id = $1",
    )
    .bind(buyer.id)
    .execute(&pool)
    .await
    .unwrap();

    let (status, _) = call(
        &state,
        "POST",
        &format!("/service/tickets/{key_id}/reissue"),
        Some(&buyer.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let (_, after) = call(&state, "GET", "/service/tickets", Some(&buyer.cookie), None).await;
    assert_eq!(after["tickets"][0]["status"], "expired");
}

// ------------------------------------------------------------------- the history

#[sqlx::test]
async fn a_sold_ticket_is_in_the_history_with_who_bought_it_and_what_they_paid(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 10_000_000).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (listing, key) = bought(&state, &owner, &buyer, id).await;
    // The price is what was paid, whatever it is changed to afterwards.
    sqlx::query("UPDATE service_listings SET price_micro = 99990000 WHERE id = $1::uuid")
        .bind(&listing)
        .execute(&pool)
        .await
        .unwrap();

    let (status, history) = call(
        &state,
        "GET",
        "/dashboard/service/sales",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK, "{history}");
    let sales = history["sales"].as_array().unwrap();
    assert_eq!(sales.len(), 1);
    assert_eq!(sales[0]["id"], listing);
    assert_eq!(sales[0]["buyer"], buyer.username);
    assert_eq!(sales[0]["seller"], owner.username);
    assert_eq!(sales[0]["name"], "Shop account · 7 ngày");
    assert_eq!(sales[0]["provider"], "deepseek");
    assert_eq!(sales[0]["days"], 7);
    assert_eq!(sales[0]["price_micro"], PRICE);
    assert_eq!(sales[0]["key_last_four"], key[key.len() - 4..]);
    assert!(sales[0]["sold_at"].is_string());
    assert!(sales[0]["expires_at"].is_string());
    assert!(!history.to_string().contains(&key));
}

#[sqlx::test]
async fn the_history_is_newest_first_and_leaves_out_what_is_not_sold(pool: PgPool) {
    let (state, owner, _) = shop(pool.clone()).await;
    let buyer = account(&pool, None).await;
    fund(&pool, &buyer, 100_000_000).await;
    let first = connection(&pool, &owner, "deepseek", "connected").await;
    let second = connection(&pool, &owner, "groq", "connected").await;
    let unsold = connection(&pool, &owner, "deepseek", "connected").await;
    let (older, _) = bought(&state, &owner, &buyer, first).await;
    let (newer, _) = bought(&state, &owner, &buyer, second).await;
    sell(&state, &owner, unsold).await;

    let (_, history) = call(
        &state,
        "GET",
        "/dashboard/service/sales",
        Some(&owner.cookie),
        None,
    )
    .await;

    let ids: Vec<&str> = history["sales"]
        .as_array()
        .unwrap()
        .iter()
        .map(|sale| sale["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, [newer.as_str(), older.as_str()]);
}

// ----------------------------------------------------------------- who may do what

#[sqlx::test]
async fn only_a_role_that_manages_stock_manages_tickets_and_only_one_that_sees_history_sees_sales(
    pool: PgPool,
) {
    let (state, owner, _) = shop(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    let id = connection(&pool, &owner, "deepseek", "connected").await;
    let (_, created) = sell(&state, &owner, id).await;
    let uri = format!(
        "/dashboard/service/listings/{}",
        created["id"].as_str().unwrap()
    );

    for (method, path, body) in [
        ("GET", "/dashboard/service/listings", None),
        ("POST", "/dashboard/service/listings", Some(terms(id))),
        (
            "POST",
            "/dashboard/service/verify",
            Some(json!({ "connection_id": id })),
        ),
        (
            "PUT",
            uri.as_str(),
            Some(json!({ "days": 1, "listed": true, "name": "X", "price_micro": PRICE })),
        ),
        ("DELETE", uri.as_str(), None),
    ] {
        let (status, _) = call(&state, method, path, None, body.clone()).await;
        assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {path}");
        let (status, _) = call(&state, method, path, Some(&cashier.cookie), body).await;
        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {path}");
    }

    assert_eq!(
        call(
            &state,
            "GET",
            "/dashboard/service/listings",
            Some(&keeper.cookie),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    // The history is the cashier's, and the stock keeper's is the stock only.
    assert_eq!(
        call(
            &state,
            "GET",
            "/dashboard/service/sales",
            Some(&cashier.cookie),
            None
        )
        .await
        .0,
        StatusCode::OK
    );
    assert_eq!(
        call(
            &state,
            "GET",
            "/dashboard/service/sales",
            Some(&keeper.cookie),
            None
        )
        .await
        .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(&state, "GET", "/dashboard/service/sales", None, None)
            .await
            .0,
        StatusCode::UNAUTHORIZED
    );
}

// -------------------------------------------------------------------- models

fn model(provider: &str, id: &str) -> Value {
    json!({
        "cached_micro_per_million": 100_000,
        "input_micro_per_million": 1_000_000,
        "listed": true,
        "model": id,
        "name": "A model",
        "output_micro_per_million": 5_000_000,
        "provider": provider
    })
}

#[sqlx::test]
async fn the_list_has_every_priced_model_by_agent_and_position(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    let (status, body) = call(
        &state,
        "GET",
        "/dashboard/service/models",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let models = body["models"].as_array().unwrap();
    assert!(models.len() >= 20, "the price list that is shipped");
    // The Pricing page's order of agents: ChatGPT, Gemini, Claude, DeepSeek, Grok, Groq.
    let mut agents: Vec<&str> = models
        .iter()
        .map(|m| m["provider"].as_str().unwrap())
        .collect();
    agents.dedup();
    assert_eq!(
        agents,
        ["chatgpt", "gemini", "claude", "deepseek", "grok", "groq"]
    );
    // Within an agent, by position.
    let chatgpt: Vec<i64> = models
        .iter()
        .filter(|m| m["provider"] == "chatgpt")
        .map(|m| m["position"].as_i64().unwrap())
        .collect();
    assert!(chatgpt.windows(2).all(|pair| pair[0] <= pair[1]));
    // An unlisted model is listed here too, since this is where it comes back.
    assert!(models.iter().any(|m| m["listed"] == false));
}

#[sqlx::test]
async fn a_new_model_goes_last_among_its_agents_and_is_for_sale(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let last: i32 = sqlx::query_scalar(
        "SELECT MAX(position) FROM service_model_prices WHERE provider = 'claude'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let (status, saved) = call(
        &state,
        "PUT",
        "/dashboard/service/models",
        Some(&owner.cookie),
        Some(model("claude", "claude-new-1")),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["model"], "claude-new-1");
    assert_eq!(saved["position"], last + 1);
    assert_eq!(saved["input_micro_per_million"], 1_000_000);
    // The public Pricing page, which customers read, now carries it.
    let (_, pricing) = call(&state, "GET", "/service/pricing", None, None).await;
    let carried = pricing["providers"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|provider| provider["models"].as_array().unwrap())
        .any(|listed| listed["id"] == "claude-new-1");
    assert!(carried);
}

#[sqlx::test]
async fn a_model_that_has_a_row_is_repriced_in_place_and_keeps_its_place(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let (id, position): (String, i32) = sqlx::query_as(
        "SELECT model, position FROM service_model_prices WHERE provider = 'chatgpt' AND listed ORDER BY position LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_model_prices")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, saved) = call(
        &state,
        "PUT",
        "/dashboard/service/models",
        Some(&owner.cookie),
        Some(json!({
            "cached_micro_per_million": 7,
            "input_micro_per_million": 70,
            "listed": true,
            "model": id,
            "name": "Renamed",
            "output_micro_per_million": 700,
            "provider": "chatgpt"
        })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["name"], "Renamed");
    assert_eq!(saved["input_micro_per_million"], 70);
    assert_eq!(saved["position"], position);
    let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_model_prices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count_before, count_after, "a row is changed, not added");
}

#[sqlx::test]
async fn an_unlisted_model_leaves_the_pricing_page_but_keeps_its_row(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let id: String = sqlx::query_scalar(
        "SELECT model FROM service_model_prices WHERE provider = 'grok' AND listed LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();

    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/service/models",
        Some(&owner.cookie),
        Some(json!({
            "cached_micro_per_million": 500_000,
            "input_micro_per_million": 2_000_000,
            "listed": false,
            "model": id,
            "name": "Grok",
            "output_micro_per_million": 6_000_000,
            "provider": "grok"
        })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let (_, pricing) = call(&state, "GET", "/service/pricing", None, None).await;
    let still_for_sale = pricing["providers"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|provider| provider["models"].as_array().unwrap())
        .any(|listed| listed["id"] == id.as_str());
    assert!(!still_for_sale);
    // A request that was on its way is still charged at its row.
    let kept: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM service_model_prices WHERE model = $1")
            .bind(&id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(kept, 1);
}

#[sqlx::test]
async fn a_model_that_is_not_valid_changes_nothing(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let count_before: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_model_prices")
        .fetch_one(&pool)
        .await
        .unwrap();
    let mut cases = Vec::new();

    cases.push(("an unknown agent", model("openai", "gpt-x")));
    cases.push(("no id", model("chatgpt", "  ")));
    cases.push(("an id with a space", model("chatgpt", "gpt x")));
    cases.push(("a long id", model("chatgpt", &"m".repeat(129))));
    cases.push(("no name", {
        let mut value = model("chatgpt", "gpt-x");
        value["name"] = json!("   ");
        value
    }));
    cases.push(("a long name", {
        let mut value = model("chatgpt", "gpt-x");
        value["name"] = json!("n".repeat(81));
        value
    }));
    for field in [
        "input_micro_per_million",
        "cached_micro_per_million",
        "output_micro_per_million",
    ] {
        cases.push(("a negative price", {
            let mut value = model("chatgpt", "gpt-x");
            value[field] = json!(-1);
            value
        }));
        cases.push(("a price over $1,000", {
            let mut value = model("chatgpt", "gpt-x");
            value[field] = json!(1_000_000_001_i64);
            value
        }));
    }

    for (what, body) in cases {
        let (status, _) = call(
            &state,
            "PUT",
            "/dashboard/service/models",
            Some(&owner.cookie),
            Some(body),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{what}");
    }

    let count_after: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_model_prices")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count_before, count_after);
}

#[sqlx::test]
async fn the_edges_of_a_price_are_allowed(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    for micro in [0_i64, 1_000_000_000] {
        let mut body = model("groq", "edge-model");
        body["input_micro_per_million"] = json!(micro);
        body["cached_micro_per_million"] = json!(micro);
        body["output_micro_per_million"] = json!(micro);

        let (status, saved) = call(
            &state,
            "PUT",
            "/dashboard/service/models",
            Some(&owner.cookie),
            Some(body),
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{micro}");
        assert_eq!(saved["output_micro_per_million"], micro);
    }
}

#[sqlx::test]
async fn only_a_role_that_manages_stock_sees_or_changes_the_prices(pool: PgPool) {
    let (state, _) = owner_and_state(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let cashier = account(&pool, Some(("cashier", true))).await;

    let (status, _) = call(&state, "GET", "/dashboard/service/models", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/service/models",
        None,
        Some(model("groq", "m")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    for cookie in [&cashier.cookie] {
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/service/models",
            Some(cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &state,
            "PUT",
            "/dashboard/service/models",
            Some(cookie),
            Some(model("groq", "m")),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/service/models",
        Some(&keeper.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}
