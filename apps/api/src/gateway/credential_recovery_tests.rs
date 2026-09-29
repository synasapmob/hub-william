//! Gateway credential recovery and account failover against a real database.
//!
//! Every provider endpoint is a local fake. Gemini covers the native Code
//! Assist gateway loop: its OAuth token endpoint (`gemini_token_url`) and Code
//! Assist API (`gemini_code_assist_url`) are both configurable, and refreshing
//! a rejected Gemini token makes no other network call
//! (`resolved_connection_metadata` only calls out for Claude, and the
//! verification probe only runs for manual refreshes and scheduled recovery).
//! DeepSeek covers the generic gateway loop shared by the other providers: its
//! requests and its key validation both go to `deepseek_api_url`. The userinfo
//! URL is pointed at the fake as well so no path here can reach a provider.

use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Form, Json, Router,
    body::{Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, StatusCode, header},
    response::Response,
    routing::{get, post},
};
use chrono::Utc;
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{net::TcpListener, task::JoinHandle};
use uuid::Uuid;

use super::{
    GatewaySelection, GeminiOperation, RejectedCredential, SERVED_CONNECTION_HEADER,
    gemini_proxy_request_for_user, handle_rejected_credential, mark_reauth_required,
    response_for_selection,
};
use crate::{AgentProvider, AppConfig, AppState, error::ApiError};

const LOGIN_REQUIRED: &str = "Provider login is required. Reconnect this pool.";
const REFRESH_REJECTED: &str = "Provider authorization expired. Refresh this pool to reconnect.";

/// Fake Google OAuth token endpoint, Code Assist API and DeepSeek API.
#[derive(Clone)]
struct FakeProvider {
    /// Generation status for a bearer token; unlisted tokens are served.
    upstream_statuses: Arc<Mutex<HashMap<String, StatusCode>>>,
    /// Remaining one-off 401s for a bearer token before `upstream_statuses`
    /// applies.
    one_off_rejections: Arc<Mutex<HashMap<String, usize>>>,
    /// Bearer tokens that reached a generation endpoint, in arrival order.
    generation_tokens: Arc<Mutex<Vec<String>>>,
    /// Form bodies the OAuth token endpoint received.
    token_requests: Arc<Mutex<Vec<HashMap<String, String>>>>,
    token_response: Arc<Mutex<(StatusCode, Value)>>,
    /// DeepSeek `/models` status for an API key; unlisted keys are valid.
    key_statuses: Arc<Mutex<HashMap<String, StatusCode>>>,
    /// API keys DeepSeek `/models` was asked to validate.
    key_checks: Arc<Mutex<Vec<String>>>,
    /// Hold every 401 until this many have arrived, so concurrent requests
    /// all hold the old token before any of them can start a refresh.
    hold_rejections_until: Arc<AtomicUsize>,
    rejections_seen: Arc<AtomicUsize>,
}

impl FakeProvider {
    fn new() -> Self {
        Self {
            upstream_statuses: Arc::default(),
            one_off_rejections: Arc::default(),
            generation_tokens: Arc::default(),
            token_requests: Arc::default(),
            token_response: Arc::new(Mutex::new((
                StatusCode::INTERNAL_SERVER_ERROR,
                json!({ "error": "no token response configured" }),
            ))),
            key_statuses: Arc::default(),
            key_checks: Arc::default(),
            hold_rejections_until: Arc::default(),
            rejections_seen: Arc::default(),
        }
    }

    fn answer(&self, access_token: &str, status: StatusCode) {
        self.upstream_statuses
            .lock()
            .unwrap()
            .insert(access_token.to_owned(), status);
    }

    fn reject_once(&self, access_token: &str) {
        self.one_off_rejections
            .lock()
            .unwrap()
            .insert(access_token.to_owned(), 1);
    }

    fn issue(&self, status: StatusCode, body: Value) {
        *self.token_response.lock().unwrap() = (status, body);
    }

    fn validate_key(&self, api_key: &str, status: StatusCode) {
        self.key_statuses
            .lock()
            .unwrap()
            .insert(api_key.to_owned(), status);
    }

    fn take_generation_tokens(&self) -> Vec<String> {
        std::mem::take(&mut *self.generation_tokens.lock().unwrap())
    }

    fn token_requests(&self) -> Vec<HashMap<String, String>> {
        self.token_requests.lock().unwrap().clone()
    }

    fn key_checks(&self) -> Vec<String> {
        self.key_checks.lock().unwrap().clone()
    }
}

fn bearer_token(headers: &HeaderMap) -> String {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned()
}

async fn load_code_assist() -> Json<Value> {
    Json(json!({ "cloudaicompanionProject": "test-project" }))
}

async fn deepseek_models(
    State(fake): State<FakeProvider>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let api_key = bearer_token(&headers);
    fake.key_checks.lock().unwrap().push(api_key.clone());
    let status = fake
        .key_statuses
        .lock()
        .unwrap()
        .get(&api_key)
        .copied()
        .unwrap_or(StatusCode::OK);
    (
        status,
        Json(json!({ "object": "list", "data": [{ "id": "deepseek-chat" }] })),
    )
}

async fn generate(
    State(fake): State<FakeProvider>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let access_token = bearer_token(&headers);
    fake.generation_tokens
        .lock()
        .unwrap()
        .push(access_token.clone());
    let one_off_rejection = match fake
        .one_off_rejections
        .lock()
        .unwrap()
        .get_mut(&access_token)
    {
        Some(remaining) if *remaining > 0 => {
            *remaining -= 1;
            true
        }
        _ => false,
    };
    let status = if one_off_rejection {
        StatusCode::UNAUTHORIZED
    } else {
        fake.upstream_statuses
            .lock()
            .unwrap()
            .get(&access_token)
            .copied()
            .unwrap_or(StatusCode::OK)
    };
    if status == StatusCode::UNAUTHORIZED {
        fake.rejections_seen.fetch_add(1, Ordering::SeqCst);
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        while fake.rejections_seen.load(Ordering::SeqCst)
            < fake.hold_rejections_until.load(Ordering::SeqCst)
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }
    if status.is_success() {
        (
            status,
            Json(json!({ "response": { "candidates": [{
                "content": { "parts": [{ "text": format!("served by {access_token}") }] }
            }] } })),
        )
    } else {
        (
            status,
            Json(json!({ "error": {
                "code": status.as_u16(),
                "message": format!("refused {access_token}")
            } })),
        )
    }
}

async fn token(
    State(fake): State<FakeProvider>,
    Form(form): Form<HashMap<String, String>>,
) -> (StatusCode, Json<Value>) {
    fake.token_requests.lock().unwrap().push(form);
    // Keep the credential row lock held for a moment so concurrent recoveries
    // really queue behind this refresh.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (status, body) = fake.token_response.lock().unwrap().clone();
    (status, Json(body))
}

struct Harness {
    state: AppState,
    fake: FakeProvider,
    server: JoinHandle<()>,
}

impl Harness {
    async fn start(pool: PgPool) -> Self {
        let fake = FakeProvider::new();
        let router = Router::new()
            .route("/token", post(token))
            .route("/v1internal:loadCodeAssist", post(load_code_assist))
            .route("/v1internal:generateContent", post(generate))
            .route("/responses", post(generate))
            .route("/models", get(deepseek_models))
            .with_state(fake.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
        let config = AppConfig {
            gemini_code_assist_url: url.clone(),
            gemini_token_url: format!("{url}/token"),
            gemini_userinfo_url: format!("{url}/userinfo"),
            deepseek_api_url: url,
            ..AppConfig::default()
        };
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
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn user(state: &AppState) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(id.simple().to_string())
        .execute(&state.pool)
        .await
        .unwrap();
    id
}

/// A connected, active Gemini account. Key clients try the most recently
/// updated account first, so `age_minutes` fixes the failover order.
async fn gemini_account(
    state: &AppState,
    owner: Uuid,
    access_token: &str,
    age_minutes: i32,
) -> Uuid {
    let credential = json!({
        "access_token": access_token,
        "refresh_token": format!("refresh-for-{access_token}"),
        "cloudaicompanion_project": "test-project"
    });
    connected_account(state, owner, "gemini", &credential, age_minutes).await
}

/// A connected, active DeepSeek API-key account, stored like `connect_api_key`.
async fn deepseek_account(state: &AppState, owner: Uuid, api_key: &str, age_minutes: i32) -> Uuid {
    let credential = json!({
        "access_token": api_key,
        "api_key_last_four": &api_key[api_key.len() - 4..],
        "credential_kind": "api_key",
        "plan": "API"
    });
    connected_account(state, owner, "deepseek", &credential, age_minutes).await
}

async fn connected_account(
    state: &AppState,
    owner: Uuid,
    provider: &str,
    credential: &Value,
    age_minutes: i32,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, updated_at)
         VALUES ($1, $2, $3, 'connected', NOW() - make_interval(mins => $4))",
    )
    .bind(id)
    .bind(owner)
    .bind(provider)
    .bind(age_minutes)
    .execute(&state.pool)
    .await
    .unwrap();
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
    let mut nonce = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            serde_json::to_vec(&credential).unwrap().as_ref(),
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
    .execute(&state.pool)
    .await
    .unwrap();
    id
}

async fn stored_credential(state: &AppState, connection_id: Uuid) -> Value {
    let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT credential_ciphertext, credential_nonce
         FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
    let plaintext = cipher
        .decrypt(Nonce::from_slice(&nonce), ciphertext.as_ref())
        .unwrap();
    serde_json::from_slice(&plaintext).unwrap()
}

async fn availability(state: &AppState, connection_id: Uuid) -> (String, Option<String>) {
    sqlx::query_as(
        "SELECT availability_status, failure_message FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

fn active() -> (String, Option<String>) {
    ("active".to_owned(), None)
}

fn browser(user_id: Uuid, connection_id: Uuid) -> GatewaySelection {
    GatewaySelection {
        user_id,
        connection_id: Some(connection_id),
        organization_id: None,
    }
}

async fn generation(state: &AppState, selection: GatewaySelection) -> Result<Response, ApiError> {
    gemini_proxy_request_for_user(
        state,
        selection,
        "gemini-3.8-flash-high",
        GeminiOperation::Generate,
        Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
    )
    .await
}

fn served_connection(response: &Response) -> Option<String> {
    response
        .headers()
        .get(SERVED_CONNECTION_HEADER)
        .map(|value| value.to_str().unwrap().to_owned())
}

async fn reply_text(response: Response) -> String {
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    payload["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A request through the generic gateway loop shared by every provider
/// except Gemini.
async fn deepseek_request(
    state: &AppState,
    selection: GatewaySelection,
) -> Result<Response, ApiError> {
    response_for_selection(
        state,
        selection,
        AgentProvider::Deepseek,
        "deepseek-chat",
        Bytes::from_static(br#"{"model":"deepseek-chat","input":"hi"}"#),
    )
    .await
}

/// The generic loop forwards the upstream body unchanged.
async fn forwarded_body(response: Response) -> Value {
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    serde_json::from_slice(&body).unwrap()
}

#[sqlx::test]
async fn rejected_access_token_is_refreshed_once_and_the_same_account_serves_the_retry(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("primary-t1", StatusCode::UNAUTHORIZED);
    fake.issue(
        StatusCode::OK,
        json!({ "access_token": "primary-t2", "expires_in": 3600 }),
    );
    let owner = user(state).await;
    // A healthy fallback proves the retry stays on the refreshed account
    // instead of silently failing over.
    let backup = gemini_account(state, owner, "backup-token", 10).await;
    let primary = gemini_account(state, owner, "primary-t1", 0).await;

    let response = generation(state, browser(owner, primary)).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(primary.to_string()));
    assert_eq!(reply_text(response).await, "served by primary-t2");
    assert_eq!(fake.take_generation_tokens(), ["primary-t1", "primary-t2"]);
    let token_requests = fake.token_requests();
    assert_eq!(token_requests.len(), 1, "exactly one token-endpoint call");
    assert_eq!(token_requests[0]["grant_type"], "refresh_token");
    assert_eq!(token_requests[0]["refresh_token"], "refresh-for-primary-t1");
    let stored = stored_credential(state, primary).await;
    assert_eq!(stored["access_token"], "primary-t2");
    assert_eq!(stored["refresh_token"], "refresh-for-primary-t1");
    assert_eq!(stored["cloudaicompanion_project"], "test-project");
    assert_eq!(availability(state, primary).await, active());
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn concurrent_requests_rejected_on_one_shared_token_share_a_single_refresh(pool: PgPool) {
    const REQUESTS: usize = 8;
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("shared-t1", StatusCode::UNAUTHORIZED);
    fake.hold_rejections_until.store(REQUESTS, Ordering::SeqCst);
    fake.issue(
        StatusCode::OK,
        json!({ "access_token": "shared-t2", "expires_in": 3600 }),
    );
    let owner = user(state).await;
    let shared = gemini_account(state, owner, "shared-t1", 0).await;
    // The owner and the pool's accepted members all use the one account.
    let mut users = vec![owner];
    for _ in 1..REQUESTS {
        let member = user(state).await;
        sqlx::query(
            "INSERT INTO agent_pool_join_requests
             (id, connection_id, requester_user_id, telegram, reason, status)
             VALUES ($1, $2, $3, '@member', 'shared account', 'accepted')",
        )
        .bind(Uuid::new_v4())
        .bind(shared)
        .bind(member)
        .execute(&state.pool)
        .await
        .unwrap();
        users.push(member);
    }

    let requests: Vec<_> = users
        .into_iter()
        .map(|user_id| {
            let state = state.clone();
            tokio::spawn(async move { generation(&state, browser(user_id, shared)).await })
        })
        .collect();
    let responses = tokio::time::timeout(
        Duration::from_secs(60),
        futures_util::future::join_all(requests),
    )
    .await
    .expect("concurrent recoveries must not deadlock");

    for response in responses {
        let response = response.unwrap().unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(served_connection(&response), Some(shared.to_string()));
        assert_eq!(reply_text(response).await, "served by shared-t2");
    }
    let tokens = fake.take_generation_tokens();
    assert_eq!(
        tokens.iter().filter(|token| *token == "shared-t1").count(),
        REQUESTS,
        "every request was rejected on the old token first: {tokens:?}"
    );
    assert_eq!(
        tokens.iter().filter(|token| *token == "shared-t2").count(),
        REQUESTS,
        "every request retried with the one new token: {tokens:?}"
    );
    assert_eq!(
        fake.token_requests().len(),
        1,
        "concurrent rejections of one token rotate it exactly once"
    );
    assert_eq!(
        stored_credential(state, shared).await["access_token"],
        "shared-t2"
    );
    assert_eq!(availability(state, shared).await, active());
}

#[sqlx::test]
async fn rejection_of_an_already_rotated_token_retries_with_the_stored_token_without_refreshing(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.issue(
        StatusCode::OK,
        json!({ "access_token": "must-not-be-issued", "expires_in": 3600 }),
    );
    let owner = user(state).await;
    // Another request already rotated T1 to T2 while this one still held T1.
    let account = gemini_account(state, owner, "rotated-t2", 0).await;

    let outcome =
        handle_rejected_credential(state, account, AgentProvider::Gemini, "stale-t1", false)
            .await
            .unwrap();
    let RejectedCredential::Retry(credential) = outcome else {
        panic!("a rejection of a replaced token must retry with the stored token");
    };
    assert_eq!(credential["access_token"], "rotated-t2");
    assert!(
        fake.token_requests().is_empty(),
        "the already rotated token must not be refreshed again"
    );

    assert!(
        !mark_reauth_required(state, account, "stale-t1")
            .await
            .unwrap()
    );
    // A second rejection that still names the stale token moves on without
    // marking the account either.
    let outcome =
        handle_rejected_credential(state, account, AgentProvider::Gemini, "stale-t1", true)
            .await
            .unwrap();
    assert!(matches!(outcome, RejectedCredential::NextAccount(_)));
    assert!(fake.token_requests().is_empty());
    assert_eq!(availability(state, account).await, active());
    assert_eq!(
        stored_credential(state, account).await["access_token"],
        "rotated-t2"
    );
}

#[sqlx::test]
async fn account_whose_refreshed_token_is_also_rejected_needs_login_and_the_next_account_serves(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("primary-t1", StatusCode::UNAUTHORIZED);
    fake.answer("primary-t2", StatusCode::UNAUTHORIZED);
    fake.issue(
        StatusCode::OK,
        json!({ "access_token": "primary-t2", "expires_in": 3600 }),
    );
    let owner = user(state).await;
    let backup = gemini_account(state, owner, "backup-token", 10).await;
    let primary = gemini_account(state, owner, "primary-t1", 0).await;

    let response = generation(state, browser(owner, primary)).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(reply_text(response).await, "served by backup-token");
    assert_eq!(
        fake.take_generation_tokens(),
        ["primary-t1", "primary-t2", "backup-token"]
    );
    assert_eq!(fake.token_requests().len(), 1);
    assert_eq!(
        availability(state, primary).await,
        (
            "reauth_required".to_owned(),
            Some(LOGIN_REQUIRED.to_owned())
        )
    );
    assert_eq!(
        stored_credential(state, primary).await["access_token"],
        "primary-t2"
    );
    assert_eq!(availability(state, backup).await, active());

    // The account waiting for its owner is skipped by later requests.
    let response = generation(state, browser(owner, primary)).await.unwrap();
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(fake.take_generation_tokens(), ["backup-token"]);
    assert_eq!(fake.token_requests().len(), 1);
}

#[sqlx::test]
async fn transient_token_endpoint_failure_fails_over_without_marking_the_account(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("primary-t1", StatusCode::UNAUTHORIZED);
    fake.issue(
        StatusCode::SERVICE_UNAVAILABLE,
        json!({ "error": "backend_error" }),
    );
    let owner = user(state).await;
    let backup = gemini_account(state, owner, "backup-token", 10).await;
    let primary = gemini_account(state, owner, "primary-t1", 0).await;

    let response = generation(state, browser(owner, primary)).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(reply_text(response).await, "served by backup-token");
    assert_eq!(
        fake.take_generation_tokens(),
        ["primary-t1", "backup-token"]
    );
    assert_eq!(fake.token_requests().len(), 1);
    assert_eq!(availability(state, primary).await, active());
    assert_eq!(
        stored_credential(state, primary).await["access_token"],
        "primary-t1",
        "a failed refresh leaves the stored credential untouched"
    );
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn rejected_refresh_token_marks_the_account_expired_and_the_next_account_serves(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("primary-t1", StatusCode::UNAUTHORIZED);
    fake.issue(
        StatusCode::BAD_REQUEST,
        json!({ "error": "invalid_grant", "error_description": "Token has been expired or revoked." }),
    );
    let owner = user(state).await;
    let backup = gemini_account(state, owner, "backup-token", 10).await;
    let primary = gemini_account(state, owner, "primary-t1", 0).await;

    let response = generation(state, browser(owner, primary)).await.unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(reply_text(response).await, "served by backup-token");
    assert_eq!(
        fake.take_generation_tokens(),
        ["primary-t1", "backup-token"]
    );
    assert_eq!(fake.token_requests().len(), 1);
    assert_eq!(
        availability(state, primary).await,
        (
            "reauth_required".to_owned(),
            Some(REFRESH_REJECTED.to_owned())
        )
    );
    assert_eq!(availability(state, backup).await, active());

    // Neither the dead login nor its refresh token is tried again.
    let response = generation(state, browser(owner, primary)).await.unwrap();
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(fake.take_generation_tokens(), ["backup-token"]);
    assert_eq!(fake.token_requests().len(), 1);
}

#[sqlx::test]
async fn failover_budget_grows_with_the_pool_so_a_fifth_account_can_serve(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    let owner = user(state).await;
    let mut limited = Vec::new();
    for index in 1..=4 {
        let access_token = format!("limited-{index}");
        fake.answer(&access_token, StatusCode::TOO_MANY_REQUESTS);
        limited.push(gemini_account(state, owner, &access_token, index).await);
    }
    let healthy = gemini_account(state, owner, "healthy-5", 10).await;

    // A key client has no preferred account and walks the pool newest first.
    let started = Utc::now();
    let response = generation(state, GatewaySelection::from(owner))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        served_connection(&response),
        None,
        "only browser selections name the serving account"
    );
    assert_eq!(reply_text(response).await, "served by healthy-5");
    assert_eq!(
        fake.take_generation_tokens(),
        [
            "limited-1",
            "limited-2",
            "limited-3",
            "limited-4",
            "healthy-5"
        ]
    );
    for connection_id in limited {
        let (status, until): (String, Option<chrono::DateTime<Utc>>) = sqlx::query_as(
            "SELECT availability_status, rate_limited_until FROM agent_connections WHERE id = $1",
        )
        .bind(connection_id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(status, "rate_limited");
        assert!(until.unwrap() >= started + chrono::Duration::minutes(29));
    }
    assert_eq!(availability(state, healthy).await, active());
    assert!(fake.token_requests().is_empty());
}

/// An organization owned by `owner` with `member` accepted, plus
/// `shared_tokens.len()` Gemini accounts of the owner shared to it.
async fn organization_with_shares(
    state: &AppState,
    owner: Uuid,
    member: Uuid,
    shared_tokens: &[&str],
) -> (Uuid, Vec<Uuid>) {
    let org_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Team')")
        .bind(org_id)
        .execute(&state.pool)
        .await
        .unwrap();
    for (user_id, role) in [(owner, "owner"), (member, "member")] {
        sqlx::query(
            "INSERT INTO organization_memberships (id, org_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, $4, 'accepted', NOW())",
        )
        .bind(Uuid::new_v4())
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    let mut shares = Vec::new();
    for (index, access_token) in shared_tokens.iter().enumerate() {
        let connection_id = gemini_account(state, owner, access_token, index as i32).await;
        sqlx::query(
            "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             VALUES ($1, $2, $3)",
        )
        .bind(org_id)
        .bind(connection_id)
        .bind(owner)
        .execute(&state.pool)
        .await
        .unwrap();
        shares.push(connection_id);
    }
    (org_id, shares)
}

async fn reset_availability(state: &AppState) {
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'active', rate_limited_until = NULL, retry_claimed_at = NULL",
    )
    .execute(&state.pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn organization_selection_fails_over_only_to_that_organizations_shares(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    let owner = user(state).await;
    let member = user(state).await;
    let (org_id, shares) =
        organization_with_shares(state, owner, member, &["shared-a", "shared-b"]).await;
    let (shared_a, shared_b) = (shares[0], shares[1]);
    let personal = gemini_account(state, member, "member-personal", 30).await;
    let preferred = GatewaySelection {
        user_id: member,
        connection_id: Some(shared_a),
        organization_id: Some(org_id),
    };
    let key_client = GatewaySelection {
        user_id: member,
        connection_id: None,
        organization_id: Some(org_id),
    };

    // Failover inside the organization still works.
    fake.answer("shared-a", StatusCode::TOO_MANY_REQUESTS);
    let response = generation(state, preferred).await.unwrap();
    assert_eq!(served_connection(&response), Some(shared_b.to_string()));
    assert_eq!(fake.take_generation_tokens(), ["shared-a", "shared-b"]);

    // Once every share is unavailable the request fails, even though the
    // member's own healthy account could have answered.
    reset_availability(state).await;
    fake.answer("shared-b", StatusCode::TOO_MANY_REQUESTS);
    for selection in [preferred, key_client] {
        let result = generation(state, selection).await;
        assert!(
            matches!(result, Err(ApiError::RateLimited)),
            "unexpected result: {:?}",
            result.map(|response| response.status())
        );
        let mut tokens = fake.take_generation_tokens();
        tokens.sort();
        assert_eq!(tokens, ["shared-a", "shared-b"]);
        reset_availability(state).await;
    }

    // The member's personal account is outside this scope, even when named.
    let result = generation(
        state,
        GatewaySelection {
            user_id: member,
            connection_id: Some(personal),
            organization_id: Some(org_id),
        },
    )
    .await;
    assert!(matches!(result, Err(ApiError::Forbidden)));
    assert!(fake.take_generation_tokens().is_empty());
    assert_eq!(availability(state, personal).await, active());
}

#[sqlx::test]
async fn personal_selection_fails_over_only_to_own_and_joined_pool_accounts(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    let owner = user(state).await;
    let member = user(state).await;
    let pool_owner = user(state).await;
    let (_, shares) = organization_with_shares(state, owner, member, &["org-only"]).await;
    let org_only = shares[0];
    let personal = gemini_account(state, member, "member-personal", 0).await;
    let joined_pool = gemini_account(state, pool_owner, "joined-pool", 30).await;
    sqlx::query(
        "INSERT INTO agent_pool_join_requests
         (id, connection_id, requester_user_id, telegram, reason, status)
         VALUES ($1, $2, $3, '@member', 'pool access', 'accepted')",
    )
    .bind(Uuid::new_v4())
    .bind(joined_pool)
    .bind(member)
    .execute(&state.pool)
    .await
    .unwrap();

    // Failover inside the personal scope reaches the joined pool.
    fake.answer("member-personal", StatusCode::TOO_MANY_REQUESTS);
    let response = generation(state, browser(member, personal)).await.unwrap();
    assert_eq!(served_connection(&response), Some(joined_pool.to_string()));
    assert_eq!(
        fake.take_generation_tokens(),
        ["member-personal", "joined-pool"]
    );

    // Once every personal account is unavailable the request fails, even
    // though an organization share the member can use is healthy.
    reset_availability(state).await;
    fake.answer("joined-pool", StatusCode::TOO_MANY_REQUESTS);
    for selection in [browser(member, personal), GatewaySelection::from(member)] {
        let result = generation(state, selection).await;
        assert!(
            matches!(result, Err(ApiError::RateLimited)),
            "unexpected result: {:?}",
            result.map(|response| response.status())
        );
        assert_eq!(
            fake.take_generation_tokens(),
            ["member-personal", "joined-pool"]
        );
        reset_availability(state).await;
    }

    // An organization-only share is outside this scope, even when named.
    let result = generation(state, browser(member, org_only)).await;
    assert!(matches!(result, Err(ApiError::Forbidden)));
    assert!(fake.take_generation_tokens().is_empty());
    assert_eq!(availability(state, org_only).await, active());
}

#[sqlx::test]
async fn generic_gateway_retries_the_same_account_after_a_one_off_rejection(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.reject_once("ds-primary-key");
    let owner = user(state).await;
    let backup = deepseek_account(state, owner, "ds-backup-key", 10).await;
    let primary = deepseek_account(state, owner, "ds-primary-key", 0).await;

    let response = deepseek_request(state, browser(owner, primary))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(primary.to_string()));
    assert_eq!(
        forwarded_body(response).await["response"]["candidates"][0]["content"]["parts"][0]["text"],
        "served by ds-primary-key"
    );
    assert_eq!(
        fake.take_generation_tokens(),
        ["ds-primary-key", "ds-primary-key"]
    );
    assert_eq!(
        fake.key_checks(),
        ["ds-primary-key"],
        "the key is revalidated once before the retry"
    );
    assert_eq!(availability(state, primary).await, active());
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn generic_gateway_marks_a_key_rejected_again_after_revalidation_and_fails_over(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    // The key still lists models, but every request made with it is refused.
    fake.answer("ds-primary-key", StatusCode::UNAUTHORIZED);
    let owner = user(state).await;
    let backup = deepseek_account(state, owner, "ds-backup-key", 10).await;
    let primary = deepseek_account(state, owner, "ds-primary-key", 0).await;

    let response = deepseek_request(state, browser(owner, primary))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(
        fake.take_generation_tokens(),
        ["ds-primary-key", "ds-primary-key", "ds-backup-key"]
    );
    assert_eq!(fake.key_checks(), ["ds-primary-key"]);
    assert_eq!(
        availability(state, primary).await,
        (
            "reauth_required".to_owned(),
            Some(LOGIN_REQUIRED.to_owned())
        )
    );
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn generic_gateway_marks_a_key_the_provider_no_longer_accepts_and_fails_over(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("ds-primary-key", StatusCode::UNAUTHORIZED);
    fake.validate_key("ds-primary-key", StatusCode::UNAUTHORIZED);
    let owner = user(state).await;
    let backup = deepseek_account(state, owner, "ds-backup-key", 10).await;
    let primary = deepseek_account(state, owner, "ds-primary-key", 0).await;

    let response = deepseek_request(state, browser(owner, primary))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(
        fake.take_generation_tokens(),
        ["ds-primary-key", "ds-backup-key"]
    );
    assert_eq!(fake.key_checks(), ["ds-primary-key"]);
    assert_eq!(
        availability(state, primary).await,
        (
            "reauth_required".to_owned(),
            Some(REFRESH_REJECTED.to_owned())
        )
    );
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn generic_gateway_moves_past_a_403_and_returns_the_last_403_when_every_account_refuses(
    pool: PgPool,
) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    fake.answer("ds-primary-key", StatusCode::FORBIDDEN);
    let owner = user(state).await;
    let backup = deepseek_account(state, owner, "ds-backup-key", 10).await;
    let primary = deepseek_account(state, owner, "ds-primary-key", 0).await;

    let response = deepseek_request(state, browser(owner, primary))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(backup.to_string()));
    assert_eq!(
        fake.take_generation_tokens(),
        ["ds-primary-key", "ds-backup-key"]
    );

    fake.answer("ds-backup-key", StatusCode::FORBIDDEN);
    let response = deepseek_request(state, browser(owner, primary))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        forwarded_body(response).await["error"]["message"],
        "refused ds-backup-key",
        "the last account's refusal is returned"
    );
    assert_eq!(
        fake.take_generation_tokens(),
        ["ds-primary-key", "ds-backup-key"]
    );
    // A 403 is account-specific, not a reconnect signal.
    assert!(fake.key_checks().is_empty());
    assert_eq!(availability(state, primary).await, active());
    assert_eq!(availability(state, backup).await, active());
}

#[sqlx::test]
async fn generic_gateway_budget_grows_with_the_pool_so_a_fifth_account_can_serve(pool: PgPool) {
    let Harness { state, fake, .. } = &Harness::start(pool).await;
    let owner = user(state).await;
    let mut limited = Vec::new();
    for index in 1..=4 {
        let api_key = format!("ds-limited-{index}");
        fake.answer(&api_key, StatusCode::TOO_MANY_REQUESTS);
        limited.push(deepseek_account(state, owner, &api_key, index).await);
    }
    let healthy = deepseek_account(state, owner, "ds-healthy-5", 10).await;

    let response = deepseek_request(state, GatewaySelection::from(owner))
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        fake.take_generation_tokens(),
        [
            "ds-limited-1",
            "ds-limited-2",
            "ds-limited-3",
            "ds-limited-4",
            "ds-healthy-5"
        ]
    );
    for connection_id in limited {
        assert_eq!(availability(state, connection_id).await.0, "rate_limited");
    }
    assert_eq!(availability(state, healthy).await, active());
}
