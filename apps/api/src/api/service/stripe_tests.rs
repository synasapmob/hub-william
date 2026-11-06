//! Paying in by card: the Checkout Session the API opens, and the signed webhook
//! that is the only thing that credits the wallet. Stripe itself is a local
//! server that records what it is asked.

use std::sync::{Arc, Mutex};

use axum::{
    Router,
    body::Bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    routing::post,
};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    ServiceTopUp, money::MICRO_PER_DOLLAR, pricing, stripe::signature_header,
    stripe::stripe_webhook, top_up_for_user, wallet,
};
use crate::core::{ApiError, AppConfig, AppState};

const DOLLAR: i64 = MICRO_PER_DOLLAR;
const SECRET_KEY: &str = "sk_test_not_a_real_key";
const WEBHOOK_SECRET: &str = "whsec_not_a_real_secret";

/// The fields of a form that was posted, in order.
type Form = Vec<(String, String)>;

/// What the local Stripe was asked: the form, and the credentials it was sent.
#[derive(Clone, Default)]
struct Recorded {
    forms: Arc<Mutex<Vec<Form>>>,
    authorizations: Arc<Mutex<Vec<String>>>,
    idempotency_keys: Arc<Mutex<Vec<String>>>,
}

async fn fake_stripe(answer: StatusCode) -> (String, Recorded) {
    let recorded = Recorded::default();
    let app = Router::new()
        .route(
            "/v1/checkout/sessions",
            post(
                move |State(recorded): State<Recorded>, headers: HeaderMap, body: Bytes| async move {
                    let query = format!("http://stripe.test/?{}", String::from_utf8_lossy(&body));
                    let form: Form = reqwest::Url::parse(&query)
                        .unwrap()
                        .query_pairs()
                        .map(|(key, value)| (key.into_owned(), value.into_owned()))
                        .collect();
                    recorded.forms.lock().unwrap().push(form);
                    recorded.authorizations.lock().unwrap().push(
                        headers
                            .get("authorization")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned(),
                    );
                    recorded.idempotency_keys.lock().unwrap().push(
                        headers
                            .get("idempotency-key")
                            .and_then(|value| value.to_str().ok())
                            .unwrap_or_default()
                            .to_owned(),
                    );
                    if answer.is_success() {
                        (
                            answer,
                            json!({
                                "id": "cs_test_a1",
                                "url": "https://checkout.stripe.test/c/pay/cs_test_a1"
                            })
                            .to_string(),
                        )
                    } else {
                        (
                            answer,
                            json!({"error": {"message": "Invalid request."}}).to_string(),
                        )
                    }
                },
            ),
        )
        .with_state(recorded.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    (format!("http://{address}"), recorded)
}

fn state(pool: &PgPool, stripe_api_url: &str) -> AppState {
    AppState {
        config: AppConfig {
            stripe_secret_key: Some(SECRET_KEY.to_owned()),
            stripe_webhook_secret: Some(WEBHOOK_SECRET.to_owned()),
            stripe_api_url: stripe_api_url.to_owned(),
            frontend_origin: HeaderValue::from_static("https://hub.example.test/"),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: pool.clone(),
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

/// A customer who has been sent to Stripe to pay `amount_micro`: the pending
/// top-up and its id.
async fn pending_top_up(pool: &PgPool, user_id: Uuid, amount_micro: i64) -> Uuid {
    wallet::begin_top_up(pool, user_id, amount_micro)
        .await
        .unwrap()
}

/// A `checkout.session.completed` event for a payment, as Stripe sends it.
fn event(kind: &str, top_up_id: Uuid, user_id: Uuid, cents: i64) -> serde_json::Value {
    json!({
        "id": "evt_test_1",
        "type": kind,
        "data": { "object": {
            "id": "cs_test_a1",
            "object": "checkout.session",
            "payment_status": "paid",
            "amount_total": cents,
            "currency": "usd",
            "client_reference_id": user_id.to_string(),
            "metadata": { "top_up_id": top_up_id.to_string() }
        } }
    })
}

fn signed(secret: &str, body: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        "stripe-signature",
        signature_header(secret, body, chrono::Utc::now().timestamp())
            .parse()
            .unwrap(),
    );
    headers
}

/// Sends a webhook, signed as Stripe would, and says what the API answered.
async fn deliver(state: &AppState, body: &serde_json::Value) -> Result<StatusCode, ApiError> {
    let body = body.to_string();

    stripe_webhook(
        State(state.clone()),
        signed(WEBHOOK_SECRET, &body),
        Bytes::from(body),
    )
    .await
}

async fn status_of(pool: &PgPool, top_up_id: Uuid) -> String {
    sqlx::query_scalar("SELECT status FROM service_top_ups WHERE id = $1")
        .bind(top_up_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn ledger(pool: &PgPool, user_id: Uuid) -> Vec<(String, i64, i64, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT kind, amount_micro, wallet_after_micro, top_up_id
         FROM service_ledger WHERE user_id = $1 ORDER BY created_at, id",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn field<'a>(form: &'a [(String, String)], name: &str) -> Option<&'a str> {
    form.iter()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.as_str())
}

#[sqlx::test]
async fn a_top_up_opens_a_checkout_and_credits_nothing_yet(pool: PgPool) {
    let (stripe, recorded) = fake_stripe(StatusCode::OK).await;
    let me = user(&pool).await;

    let answer = top_up_for_user(&state(&pool, &stripe), me, 25 * DOLLAR)
        .await
        .unwrap();

    assert_eq!(
        answer.checkout_url.as_deref(),
        Some("https://checkout.stripe.test/c/pay/cs_test_a1")
    );
    assert_eq!(answer.wallet_micro, 0, "paid for later, by the webhook");
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert!(ledger(&pool, me).await.is_empty());

    let (id, status, amount, session): (Uuid, String, i64, Option<String>) = sqlx::query_as(
        "SELECT id, status, amount_micro, stripe_session_id FROM service_top_ups
         WHERE user_id = $1",
    )
    .bind(me)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (status.as_str(), amount, session.as_deref()),
        ("pending", 25 * DOLLAR, Some("cs_test_a1"))
    );

    let forms = recorded.forms.lock().unwrap();
    let form = &forms[0];
    assert_eq!(field(form, "mode"), Some("payment"));
    assert_eq!(
        field(form, "line_items[0][price_data][unit_amount]"),
        Some("2500"),
        "cents"
    );
    assert_eq!(
        field(form, "line_items[0][price_data][currency]"),
        Some("usd")
    );
    assert_eq!(field(form, "line_items[0][quantity]"), Some("1"));
    assert_eq!(
        field(form, "client_reference_id"),
        Some(me.to_string().as_str())
    );
    assert_eq!(
        field(form, "metadata[top_up_id]"),
        Some(id.to_string().as_str())
    );
    assert_eq!(
        field(form, "success_url"),
        Some("https://hub.example.test/service/pricing?topup=success")
    );
    assert_eq!(
        field(form, "cancel_url"),
        Some("https://hub.example.test/service/pricing?topup=cancelled")
    );
    // Basic auth with the secret key as the user name and no password.
    let expected = {
        use base64::{Engine, engine::general_purpose::STANDARD};
        format!("Basic {}", STANDARD.encode(format!("{SECRET_KEY}:")))
    };
    assert_eq!(recorded.authorizations.lock().unwrap()[0], expected);
    assert_eq!(
        recorded.idempotency_keys.lock().unwrap()[0],
        format!("service-top-up-{id}")
    );
}

#[sqlx::test]
async fn an_amount_that_is_not_whole_cents_or_out_of_range_opens_nothing(pool: PgPool) {
    let (stripe, recorded) = fake_stripe(StatusCode::OK).await;
    let me = user(&pool).await;

    for amount in [25 * DOLLAR + 1, DOLLAR - 10_000, 1_001 * DOLLAR, 0, -DOLLAR] {
        assert!(
            matches!(
                top_up_for_user(&state(&pool, &stripe), me, amount).await,
                Err(ApiError::Validation(_))
            ),
            "{amount}"
        );
    }

    assert!(recorded.forms.lock().unwrap().is_empty());
    let top_ups: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_top_ups")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(top_ups, 0);
}

#[sqlx::test]
async fn a_checkout_stripe_refuses_is_closed_and_reported(pool: PgPool) {
    let (stripe, _) = fake_stripe(StatusCode::BAD_REQUEST).await;
    let me = user(&pool).await;

    let answer = top_up_for_user(&state(&pool, &stripe), me, 10 * DOLLAR).await;

    assert!(matches!(answer, Err(ApiError::Provider(_))));
    let statuses: Vec<String> = sqlx::query_scalar("SELECT status FROM service_top_ups")
        .fetch_all(&pool)
        .await
        .unwrap();
    assert_eq!(statuses, ["expired"]);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn a_checkout_cannot_be_opened_when_stripe_cannot_be_reached(pool: PgPool) {
    let me = user(&pool).await;

    // Nothing listens here.
    let answer = top_up_for_user(&state(&pool, "http://127.0.0.1:1"), me, 10 * DOLLAR).await;

    assert!(matches!(answer, Err(ApiError::Provider(_))));
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn with_stripe_set_up_the_test_top_up_does_not_apply(pool: PgPool) {
    let (stripe, _) = fake_stripe(StatusCode::OK).await;
    let me = user(&pool).await;
    let mut state = state(&pool, &stripe);
    state.config.service_test_top_up = true;

    let answer: ServiceTopUp = top_up_for_user(&state, me, 10 * DOLLAR).await.unwrap();

    assert!(answer.checkout_url.is_some());
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn pricing_says_whether_a_top_up_is_paid_by_card(pool: PgPool) {
    let with = pricing(State(state(&pool, "http://127.0.0.1:1")))
        .await
        .unwrap()
        .0;
    let mut without = state(&pool, "http://127.0.0.1:1");
    without.config.stripe_secret_key = None;
    let without = pricing(State(without)).await.unwrap().0;

    assert!(with.card_top_up);
    assert!(!without.card_top_up);
}

#[sqlx::test]
async fn a_paid_session_credits_the_wallet_once_and_leaves_a_ledger_row(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");

    let answer = deliver(
        &state,
        &event("checkout.session.completed", top_up, me, 2_500),
    )
    .await;

    assert_eq!(answer.unwrap(), StatusCode::OK);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 25 * DOLLAR);
    assert_eq!(status_of(&pool, top_up).await, "paid");
    assert_eq!(
        ledger(&pool, me).await,
        [("top_up".to_owned(), 25 * DOLLAR, 25 * DOLLAR, Some(top_up))]
    );
}

#[sqlx::test]
async fn the_same_payment_reported_again_is_credited_once(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");
    let paid = event("checkout.session.completed", top_up, me, 2_500);

    for _ in 0..3 {
        assert_eq!(deliver(&state, &paid).await.unwrap(), StatusCode::OK);
    }

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 25 * DOLLAR);
    assert_eq!(ledger(&pool, me).await.len(), 1);
}

#[sqlx::test]
async fn the_same_payment_reported_at_the_same_time_is_credited_once(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");
    let paid = event("checkout.session.completed", top_up, me, 2_500);

    let reports = (0..6).map(|_| {
        let state = state.clone();
        let paid = paid.clone();
        tokio::spawn(async move { deliver(&state, &paid).await })
    });
    for report in reports.collect::<Vec<_>>() {
        assert_eq!(report.await.unwrap().unwrap(), StatusCode::OK);
    }

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 25 * DOLLAR);
    assert_eq!(ledger(&pool, me).await.len(), 1);
}

#[sqlx::test]
async fn a_webhook_with_a_bad_signature_credits_nothing(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");
    let body = event("checkout.session.completed", top_up, me, 2_500).to_string();

    for headers in [
        signed("whsec_someone_else", &body),
        HeaderMap::new(),
        signed(WEBHOOK_SECRET, "{}"),
    ] {
        let answer = stripe_webhook(State(state.clone()), headers, Bytes::from(body.clone())).await;
        assert!(matches!(answer, Err(ApiError::Forbidden)));
    }

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert_eq!(status_of(&pool, top_up).await, "pending");
}

#[sqlx::test]
async fn a_webhook_for_an_old_signature_credits_nothing(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");
    let body = event("checkout.session.completed", top_up, me, 2_500).to_string();
    let mut headers = HeaderMap::new();
    headers.insert(
        "stripe-signature",
        signature_header(
            WEBHOOK_SECRET,
            &body,
            chrono::Utc::now().timestamp() - 3_600,
        )
        .parse()
        .unwrap(),
    );

    let answer = stripe_webhook(State(state), headers, Bytes::from(body)).await;

    assert!(matches!(answer, Err(ApiError::Forbidden)));
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn a_payment_for_another_amount_or_customer_or_currency_credits_nothing(pool: PgPool) {
    let me = user(&pool).await;
    let someone_else = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");

    // Less than was asked for, more than was asked for, and another customer.
    for body in [
        event("checkout.session.completed", top_up, me, 100),
        event("checkout.session.completed", top_up, me, 250_000),
        event("checkout.session.completed", top_up, someone_else, 2_500),
    ] {
        assert_eq!(deliver(&state, &body).await.unwrap(), StatusCode::OK);
    }
    let mut euros = event("checkout.session.completed", top_up, me, 2_500);
    euros["data"]["object"]["currency"] = json!("eur");
    assert_eq!(deliver(&state, &euros).await.unwrap(), StatusCode::OK);

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    assert_eq!(wallet::read(&pool, someone_else).await.unwrap(), 0);
    assert_eq!(status_of(&pool, top_up).await, "pending");
    assert!(ledger(&pool, me).await.is_empty());
}

#[sqlx::test]
async fn a_session_that_is_not_paid_yet_credits_when_it_is(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 25 * DOLLAR).await;
    let state = state(&pool, "http://127.0.0.1:1");

    // A method that settles later: completed, but unpaid.
    let mut unpaid = event("checkout.session.completed", top_up, me, 2_500);
    unpaid["data"]["object"]["payment_status"] = json!("unpaid");
    deliver(&state, &unpaid).await.unwrap();
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);

    deliver(
        &state,
        &event(
            "checkout.session.async_payment_succeeded",
            top_up,
            me,
            2_500,
        ),
    )
    .await
    .unwrap();

    assert_eq!(wallet::read(&pool, me).await.unwrap(), 25 * DOLLAR);
}

#[sqlx::test]
async fn a_payment_for_a_top_up_that_does_not_exist_credits_nothing(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(&pool, "http://127.0.0.1:1");

    let answer = deliver(
        &state,
        &event("checkout.session.completed", Uuid::new_v4(), me, 2_500),
    )
    .await;

    assert_eq!(answer.unwrap(), StatusCode::OK, "nothing to repeat");
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
    let mut without_metadata = event("checkout.session.completed", Uuid::new_v4(), me, 2_500);
    without_metadata["data"]["object"]["metadata"] = json!({});
    assert_eq!(
        deliver(&state, &without_metadata).await.unwrap(),
        StatusCode::OK
    );
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn an_expired_session_closes_its_top_up_and_a_paid_one_stays_paid(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(&pool, "http://127.0.0.1:1");
    let abandoned = pending_top_up(&pool, me, 10 * DOLLAR).await;
    let paid = pending_top_up(&pool, me, 20 * DOLLAR).await;

    deliver(
        &state,
        &event("checkout.session.completed", paid, me, 2_000),
    )
    .await
    .unwrap();
    for top_up in [abandoned, paid] {
        deliver(&state, &event("checkout.session.expired", top_up, me, 0))
            .await
            .unwrap();
    }

    assert_eq!(status_of(&pool, abandoned).await, "expired");
    assert_eq!(status_of(&pool, paid).await, "paid");
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 20 * DOLLAR);
}

#[sqlx::test]
async fn an_event_this_api_does_not_read_is_acknowledged_and_ignored(pool: PgPool) {
    let me = user(&pool).await;
    let state = state(&pool, "http://127.0.0.1:1");

    for body in [
        json!({"type": "charge.succeeded", "data": {"object": {"id": "ch_1", "amount": 2500}}}),
        json!({"type": "payment_intent.created", "data": {"object": {"id": "pi_1"}}}),
        json!({"unexpected": "shape"}),
    ] {
        assert_eq!(deliver(&state, &body).await.unwrap(), StatusCode::OK);
    }
    // Signed, but not JSON at all.
    let body = "not json";
    let answer = stripe_webhook(
        State(state.clone()),
        signed(WEBHOOK_SECRET, body),
        Bytes::from(body),
    )
    .await;

    assert_eq!(answer.unwrap(), StatusCode::OK);
    assert_eq!(wallet::read(&pool, me).await.unwrap(), 0);
}

#[sqlx::test]
async fn the_webhook_is_not_there_without_stripe_set_up(pool: PgPool) {
    let mut state = state(&pool, "http://127.0.0.1:1");
    state.config.stripe_webhook_secret = None;
    let body = "{}";

    let answer = stripe_webhook(
        State(state),
        signed(WEBHOOK_SECRET, body),
        Bytes::from(body),
    )
    .await;

    assert!(matches!(answer, Err(ApiError::NotAvailable(_))));
}

#[sqlx::test]
async fn deleting_a_user_removes_their_top_ups(pool: PgPool) {
    let me = user(&pool).await;
    let top_up = pending_top_up(&pool, me, 10 * DOLLAR).await;
    deliver(
        &state(&pool, "http://127.0.0.1:1"),
        &event("checkout.session.completed", top_up, me, 1_000),
    )
    .await
    .unwrap();

    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(me)
        .execute(&pool)
        .await
        .unwrap();

    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM service_top_ups")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}
