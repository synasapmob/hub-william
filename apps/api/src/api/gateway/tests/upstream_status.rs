//! What a client is told when Google answers a Gemini request, and when the
//! gateway has not called Google at all. The rule under test: a status the
//! client receives is Google's own, or names the one thing the gateway knows
//! (an account resting after a 429, an account being probed, an account that
//! needs its owner). Only a real 429, or accounts all still resting after one,
//! is a 429; nothing else is folded into it.
//!
//! Google is a local fake that answers each bearer token as told and counts
//! every call, so each case also says whether Google was reached.

use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json, Router,
    body::{Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::post,
};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{net::TcpListener, task::JoinHandle};
use uuid::Uuid;

use crate::{
    api::gateway::{
        providers::gemini::{GeminiOperation, gemini_proxy_request_for_user},
        selection::GatewaySelection,
    },
    core::{AppConfig, AppState},
};

#[derive(Clone)]
struct Reply {
    status: StatusCode,
    retry_after: Option<&'static str>,
    body: Value,
    delay: Duration,
}

impl Reply {
    fn refusing(status: StatusCode, message: &str) -> Self {
        Self {
            status,
            retry_after: None,
            body: json!({ "error": {
                "code": status.as_u16(),
                "message": message,
            } }),
            delay: Duration::ZERO,
        }
    }
}

#[derive(Clone, Default)]
struct FakeGoogle {
    /// The reply for a token and how many more calls it answers (all, when none).
    replies: Arc<Mutex<HashMap<String, (Reply, Option<usize>)>>>,
    calls: Arc<Mutex<Vec<String>>>,
}

impl FakeGoogle {
    fn reply(&self, token: &str, reply: Reply) {
        self.replies
            .lock()
            .unwrap()
            .insert(token.to_owned(), (reply, None));
    }

    /// Answer only the next `times` calls with `reply`; later calls are served.
    fn reply_times(&self, token: &str, reply: Reply, times: usize) {
        self.replies
            .lock()
            .unwrap()
            .insert(token.to_owned(), (reply, Some(times)));
    }

    /// The bearer tokens Google was called with since the last look.
    fn calls(&self) -> Vec<String> {
        std::mem::take(&mut *self.calls.lock().unwrap())
    }
}

async fn load_code_assist() -> Json<Value> {
    Json(json!({ "cloudaicompanionProject": "test-project" }))
}

async fn generate(State(fake): State<FakeGoogle>, headers: HeaderMap) -> Response {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned();
    fake.calls.lock().unwrap().push(token.clone());
    let reply = {
        let mut replies = fake.replies.lock().unwrap();
        let entry = replies.get_mut(&token);
        let reply = entry.as_ref().map(|(reply, _)| reply.clone());
        if let Some((_, Some(times))) = entry {
            *times -= 1;
            if *times == 0 {
                replies.remove(&token);
            }
        }
        reply
    };
    let Some(reply) = reply else {
        return Json(json!({ "response": { "candidates": [{
            "content": { "parts": [{ "text": format!("served by {token}") }] }
        }] } }))
        .into_response();
    };
    tokio::time::sleep(reply.delay).await;
    let mut response = (reply.status, Json(reply.body)).into_response();
    if let Some(retry_after) = reply.retry_after {
        response
            .headers_mut()
            .insert(header::RETRY_AFTER, HeaderValue::from_static(retry_after));
    }
    response
}

struct Harness {
    state: AppState,
    fake: FakeGoogle,
    server: JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

impl Harness {
    async fn start(pool: PgPool) -> Self {
        let fake = FakeGoogle::default();
        let router = Router::new()
            .route("/v1internal:loadCodeAssist", post(load_code_assist))
            .route("/v1internal:generateContent", post(generate))
            .with_state(fake.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let mut config = AppConfig::default();
        config.gemini_code_assist_url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        Self {
            state: AppState {
                config,
                http: reqwest::Client::new(),
                gateway_http: reqwest::Client::new(),
                pool,
            },
            fake,
            server,
        }
    }

    async fn user(&self) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(id)
            .bind(id.simple().to_string())
            .execute(&self.state.pool)
            .await
            .unwrap();
        id
    }

    /// A connected, active account whose Google login is `access_token`. A
    /// larger `age_minutes` is tried later.
    async fn account(&self, user_id: Uuid, access_token: &str, age_minutes: i32) -> Uuid {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agent_connections (id, user_id, provider, status)
             VALUES ($1, $2, 'gemini', 'connected')",
        )
        .bind(id)
        .bind(user_id)
        .execute(&self.state.pool)
        .await
        .unwrap();
        sqlx::query(
            "UPDATE agent_connections SET updated_at = NOW() - $2 * INTERVAL '1 minute'
             WHERE id = $1",
        )
        .bind(id)
        .bind(age_minutes)
        .execute(&self.state.pool)
        .await
        .unwrap();
        let token = json!({
            "access_token": access_token,
            "cloudaicompanion_project": "test-project"
        });
        let cipher =
            Aes256Gcm::new_from_slice(&self.state.config.credential_encryption_key).unwrap();
        let mut nonce = [0_u8; 12];
        rand::rngs::OsRng.fill_bytes(&mut nonce);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                serde_json::to_vec(&token).unwrap().as_ref(),
            )
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_connection_credentials
             (connection_id, credential_ciphertext, credential_nonce)
             VALUES ($1, $2, $3)",
        )
        .bind(id)
        .bind(ciphertext)
        .bind(nonce.to_vec())
        .execute(&self.state.pool)
        .await
        .unwrap();
        id
    }

    /// Put an account in a state the gateway remembers. `rest_seconds` is how
    /// far in the future its rest ends (negative: already over).
    async fn remember(
        &self,
        id: Uuid,
        status: &str,
        rest_seconds: Option<i64>,
        probe_claimed: bool,
    ) {
        sqlx::query(
            "UPDATE agent_connections
             SET availability_status = $2,
                 rate_limited_until = NOW() + $3::bigint * INTERVAL '1 second',
                 retry_claimed_at = CASE WHEN $4 THEN NOW() END,
                 failure_message = CASE WHEN $2 = 'reauth_required'
                     THEN 'Provider login is required. Reconnect this pool.' END
             WHERE id = $1",
        )
        .bind(id)
        .bind(status)
        .bind(rest_seconds)
        .bind(probe_claimed)
        .execute(&self.state.pool)
        .await
        .unwrap();
    }

    async fn availability(&self, id: Uuid) -> (String, Option<i64>) {
        let (status, rest): (String, Option<f64>) = sqlx::query_as(
            "SELECT availability_status,
                    EXTRACT(EPOCH FROM (rate_limited_until - NOW()))::float8
             FROM agent_connections WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&self.state.pool)
        .await
        .unwrap();
        (status, rest.map(|seconds| seconds.round() as i64))
    }

    async fn ask(&self, user_id: Uuid) -> Answer {
        ask(&self.state, user_id).await
    }
}

struct Answer {
    status: StatusCode,
    retry_after: Option<String>,
    body: Value,
}

impl Answer {
    /// The gateway's own error code, when the gateway made the answer.
    fn code(&self) -> Option<&str> {
        self.body["code"].as_str()
    }

    /// The message of Google's own error body, when the answer is Google's.
    fn google_message(&self) -> Option<&str> {
        self.body["error"]["message"].as_str()
    }
}

async fn ask(state: &AppState, user_id: Uuid) -> Answer {
    let result = gemini_proxy_request_for_user(
        state,
        GatewaySelection::from(user_id),
        "gemini-3.8-flash-high",
        GeminiOperation::Generate,
        Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
    )
    .await;
    let response = result.unwrap_or_else(IntoResponse::into_response);
    let status = response.status();
    let retry_after = response
        .headers()
        .get(header::RETRY_AFTER)
        .map(|value| value.to_str().unwrap().to_owned());
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    Answer {
        status,
        retry_after,
        body: serde_json::from_slice(&body).unwrap_or(Value::Null),
    }
}

#[sqlx::test]
async fn google_answers_other_than_429_reach_the_client_unchanged(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;

    for (status, message) in [
        (
            StatusCode::BAD_REQUEST,
            "Request contains an invalid argument.",
        ),
        (StatusCode::FORBIDDEN, "Project lacks model permission."),
        (StatusCode::NOT_FOUND, "Model not found."),
    ] {
        harness.fake.reply("only", Reply::refusing(status, message));
        let answer = harness.ask(user).await;
        assert_eq!(answer.status, status, "client got {}", answer.status);
        assert_eq!(answer.google_message(), Some(message));
        assert_eq!(harness.fake.calls(), ["only"], "one call, no failover");
        // None of these says anything about the account's capacity.
        assert_eq!(harness.availability(account).await.0, "active");
    }
}

#[sqlx::test]
async fn a_rejected_login_is_a_reconnect_error_and_never_a_429(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;

    harness.fake.reply(
        "only",
        Reply::refusing(
            StatusCode::UNAUTHORIZED,
            "Invalid authentication credentials.",
        ),
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::BAD_GATEWAY);
    assert_eq!(answer.code(), Some("provider_unavailable"));
    assert_eq!(harness.availability(account).await.0, "reauth_required");

    // Google's account-verification challenge is also a reconnect, not a limit.
    sqlx::query("UPDATE agent_connections SET availability_status = 'active' WHERE id = $1")
        .bind(account)
        .execute(&harness.state.pool)
        .await
        .unwrap();
    harness.fake.calls();
    harness.fake.reply(
        "only",
        Reply::refusing(StatusCode::FORBIDDEN, "Verify your account to continue."),
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::BAD_GATEWAY);
    assert_eq!(answer.code(), Some("provider_unavailable"));
    assert_eq!(harness.availability(account).await.0, "reauth_required");
}

#[sqlx::test]
async fn a_google_429_is_relayed_with_its_body_and_rests_the_account_as_long_as_google_asked(
    pool: PgPool,
) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;

    harness.fake.reply(
        "only",
        Reply {
            status: StatusCode::TOO_MANY_REQUESTS,
            retry_after: Some("7"),
            body: json!({ "error": {
                "code": 429,
                "status": "RESOURCE_EXHAUSTED",
                "message": "Quota exceeded for this model.",
                "details": [{
                    "@type": "type.googleapis.com/google.rpc.RetryInfo",
                    "retryDelay": "20s"
                }]
            } }),
            delay: Duration::ZERO,
        },
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        answer.google_message(),
        Some("Quota exceeded for this model.")
    );
    assert_eq!(
        answer.retry_after.as_deref(),
        Some("7"),
        "Google's own header"
    );
    assert_eq!(answer.code(), None, "not the gateway's error");
    assert_eq!(harness.fake.calls(), ["only"]);
    // The longest ask (20 s) sets the rest, and a provider that asks for that
    // long is believed: no retry went out.
    let (status, rest) = harness.availability(account).await;
    assert_eq!(status, "rate_limited");
    assert!((18..=20).contains(&rest.unwrap()), "rests {rest:?} s");
}

#[sqlx::test]
async fn a_429_that_names_no_delay_is_retried_twice_then_rests_the_account_a_minute(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;
    harness.fake.reply(
        "only",
        Reply::refusing(StatusCode::TOO_MANY_REQUESTS, "Resource exhausted."),
    );

    let answer = harness.ask(user).await;
    // The first send and two retries, all to the same account.
    assert_eq!(harness.fake.calls(), ["only", "only", "only"]);
    // The client still gets Google's own body, with the wait the gateway adds
    // because Google named none.
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(answer.google_message(), Some("Resource exhausted."));
    assert_eq!(answer.code(), None);
    let retry_after: i64 = answer.retry_after.unwrap().parse().unwrap();
    assert!(
        (58..=60).contains(&retry_after),
        "Retry-After {retry_after}"
    );
    let (status, rest) = harness.availability(account).await;
    assert_eq!(status, "rate_limited");
    assert!((58..=60).contains(&rest.unwrap()), "rests {rest:?} s");
}

#[sqlx::test]
async fn a_429_that_clears_on_a_retry_is_served_and_the_account_never_rests(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;

    for failures in [1, 2] {
        harness.fake.reply_times(
            "only",
            Reply::refusing(StatusCode::TOO_MANY_REQUESTS, "Resource exhausted."),
            failures,
        );
        let answer = harness.ask(user).await;
        assert_eq!(answer.status, StatusCode::OK, "after {failures} 429s");
        assert_eq!(harness.fake.calls().len(), failures + 1);
        assert_eq!(harness.availability(account).await.0, "active");
    }
}

#[sqlx::test]
async fn a_probe_is_a_single_call_and_a_failed_one_rests_the_account_again(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;
    harness.fake.reply(
        "only",
        Reply::refusing(StatusCode::TOO_MANY_REQUESTS, "Resource exhausted."),
    );
    // The rest has just ended, so this request is the probe.
    harness
        .remember(account, "rate_limited", Some(-1), false)
        .await;

    let answer = harness.ask(user).await;
    assert_eq!(harness.fake.calls(), ["only"], "a probe is not retried");
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    let (status, rest) = harness.availability(account).await;
    assert_eq!(status, "rate_limited");
    assert!((58..=60).contains(&rest.unwrap()), "rests {rest:?} s");
}

#[sqlx::test]
async fn retrying_one_account_never_starves_the_others_of_their_turn(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    for (age, token) in ["first", "second", "third"].into_iter().enumerate() {
        harness.account(user, token, age as i32).await;
        harness.fake.reply(
            token,
            Reply::refusing(StatusCode::TOO_MANY_REQUESTS, &format!("{token} is out")),
        );
    }

    let answer = harness.ask(user).await;
    // Four sends in all: the first account retries once, and the budget keeps a
    // send for each of the other two.
    assert_eq!(harness.fake.calls(), ["first", "first", "second", "third"]);
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(answer.google_message(), Some("third is out"));
}

#[sqlx::test]
async fn accounts_all_resting_after_a_429_are_a_gateway_429_that_says_when_and_calls_nothing(
    pool: PgPool,
) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let soon = harness.account(user, "soon", 0).await;
    let later = harness.account(user, "later", 1).await;
    harness
        .remember(soon, "rate_limited", Some(90), false)
        .await;
    harness
        .remember(later, "rate_limited", Some(600), false)
        .await;

    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(answer.code(), Some("all_pools_rate_limited"));
    // The wait is until the first account is due, not the last.
    let wait: i64 = answer.retry_after.unwrap().parse().unwrap();
    assert!((89..=90).contains(&wait), "Retry-After {wait}");
    assert!(harness.fake.calls().is_empty(), "Google must not be called");
}

#[sqlx::test]
async fn an_account_another_request_is_probing_is_a_503_never_a_429(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;
    harness.remember(account, "half_open", None, true).await;

    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(answer.code(), Some("pool_recovering"));
    assert_eq!(answer.retry_after.as_deref(), Some("2"));
    assert!(harness.fake.calls().is_empty(), "Google must not be called");
}

#[sqlx::test]
async fn requests_that_arrive_while_a_recovered_account_is_probed_wait_instead_of_getting_a_429(
    pool: PgPool,
) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;
    // Google is healthy again but slow to answer the probe.
    harness.fake.reply(
        "only",
        Reply {
            status: StatusCode::OK,
            retry_after: None,
            body: json!({ "response": { "candidates": [{
                "content": { "parts": [{ "text": "recovered" }] }
            }] } }),
            delay: Duration::from_millis(800),
        },
    );
    // The rest after an earlier 429 has just ended.
    harness
        .remember(account, "rate_limited", Some(-1), false)
        .await;

    let (a, b, c, d) = tokio::join!(
        harness.ask(user),
        harness.ask(user),
        harness.ask(user),
        harness.ask(user)
    );
    let answers = [a, b, c, d];
    let served = answers
        .iter()
        .filter(|a| a.status == StatusCode::OK)
        .count();
    let recovering = answers
        .iter()
        .filter(|a| {
            a.status == StatusCode::SERVICE_UNAVAILABLE && a.code() == Some("pool_recovering")
        })
        .count();
    assert_eq!(served, 1, "exactly the probe is served");
    assert_eq!(
        recovering, 3,
        "the rest are told to retry, not rate limited"
    );
    assert!(
        answers
            .iter()
            .all(|a| a.status != StatusCode::TOO_MANY_REQUESTS)
    );
    assert_eq!(harness.fake.calls().len(), 1, "one probe reached Google");

    // Once the probe is served the account is open again.
    assert_eq!(harness.availability(account).await.0, "active");
    assert_eq!(harness.ask(user).await.status, StatusCode::OK);
}

#[sqlx::test]
async fn an_account_that_needs_its_owner_is_a_502_never_a_429(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let account = harness.account(user, "only", 0).await;
    harness
        .remember(account, "reauth_required", None, false)
        .await;

    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::BAD_GATEWAY);
    assert_eq!(answer.code(), Some("provider_unavailable"));
    assert!(harness.fake.calls().is_empty());
}

#[sqlx::test]
async fn what_google_said_in_this_request_outranks_what_the_gateway_remembers(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let tried = harness.account(user, "tried", 0).await;
    let resting = harness.account(user, "resting", 1).await;
    harness
        .remember(resting, "rate_limited", Some(900), false)
        .await;

    // A real 403 is not hidden behind another account's rest.
    harness.fake.reply(
        "tried",
        Reply::refusing(StatusCode::FORBIDDEN, "Project lacks model permission."),
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::FORBIDDEN);
    assert_eq!(
        answer.google_message(),
        Some("Project lacks model permission.")
    );
    assert_eq!(harness.fake.calls(), ["tried"]);

    // Nor is a real 401: the account is marked and the client is told to reconnect.
    harness.fake.reply(
        "tried",
        Reply::refusing(
            StatusCode::UNAUTHORIZED,
            "Invalid authentication credentials.",
        ),
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::BAD_GATEWAY);
    assert_eq!(harness.availability(tried).await.0, "reauth_required");

    // A real 429 reaches the client as Google's, whatever the other account needs.
    harness.remember(tried, "active", None, false).await;
    harness
        .remember(resting, "reauth_required", None, false)
        .await;
    harness.fake.calls();
    harness.fake.reply(
        "tried",
        Reply::refusing(StatusCode::TOO_MANY_REQUESTS, "Quota exceeded."),
    );
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(answer.google_message(), Some("Quota exceeded."));
    assert_eq!(harness.fake.calls(), ["tried", "tried", "tried"]);
    let retry_after: i64 = answer.retry_after.unwrap().parse().unwrap();
    assert!(
        (58..=60).contains(&retry_after),
        "Retry-After {retry_after}"
    );

    // Of the accounts it did not call, the one that is back soonest decides:
    // a probe in a moment beats a rest of minutes.
    harness.remember(tried, "half_open", None, true).await;
    harness
        .remember(resting, "rate_limited", Some(900), false)
        .await;
    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(answer.code(), Some("pool_recovering"));
}

#[sqlx::test]
async fn an_account_that_answers_429_hands_over_to_the_next_which_serves(pool: PgPool) {
    let harness = Harness::start(pool).await;
    let user = harness.user().await;
    let limited = harness.account(user, "limited", 0).await;
    let healthy = harness.account(user, "healthy", 1).await;
    harness.fake.reply(
        "limited",
        Reply::refusing(StatusCode::TOO_MANY_REQUESTS, "Quota exceeded."),
    );

    let answer = harness.ask(user).await;
    assert_eq!(answer.status, StatusCode::OK);
    // The limited account gets its two retries before the next one serves.
    assert_eq!(
        harness.fake.calls(),
        ["limited", "limited", "limited", "healthy"]
    );
    assert_eq!(harness.availability(limited).await.0, "rate_limited");
    assert_eq!(harness.availability(healthy).await.0, "active");

    // The resting account is skipped while the healthy one keeps serving.
    assert_eq!(harness.ask(user).await.status, StatusCode::OK);
    assert_eq!(harness.fake.calls(), ["healthy"]);
}
