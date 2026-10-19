//! The key-authenticated ChatGPT and Claude model lists against a real
//! database. The upstream is a local fake that answers only for the connected
//! account's own token and lists fewer models than the current catalogue, so a
//! model the subscription lacks must not reach key clients.

use std::{
    sync::{Arc, Mutex},
    time::Instant,
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json, Router,
    body::to_bytes,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::Response,
    routing::get,
};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::{net::TcpListener, task::JoinHandle};
use uuid::Uuid;

use super::{
    CLAUDE_DOCS_CACHE, OPENAI_DOCS_CACHE, claude_models, default_claude_model_catalogue,
    default_openai_model_catalogue, hash_gateway_key, openai_models,
};
use crate::core::{AppConfig, AppState};

const GATEWAY_KEY: &str = "hw_live_subscriber_models_test_key_0123456789";

#[derive(Clone)]
struct FakeUpstream {
    /// Bearer tokens that reached a model list, in arrival order.
    tokens: Arc<Mutex<Vec<String>>>,
    claude_status: Arc<Mutex<StatusCode>>,
}

fn bearer(headers: &HeaderMap) -> String {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned()
}

async fn chatgpt_models(
    State(fake): State<FakeUpstream>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let token = bearer(&headers);
    fake.tokens.lock().unwrap().push(token.clone());
    if token != "Bearer chatgpt-token" {
        return (StatusCode::UNAUTHORIZED, Json(json!({})));
    }
    // The catalogue also carries gpt-6-astra, gpt-6-luna and gpt-5.6-terra;
    // this subscription has neither them nor a hidden or retired entry.
    (
        StatusCode::OK,
        Json(json!({ "models": [
            { "slug": "gpt-6-sol", "visibility": "list" },
            { "slug": "gpt-5.6-luna", "visibility": "list" },
            { "slug": "gpt-6-luna", "visibility": "hide" },
            { "slug": "retired-model", "visibility": "list" }
        ] })),
    )
}

async fn claude_models_upstream(
    State(fake): State<FakeUpstream>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let token = bearer(&headers);
    fake.tokens.lock().unwrap().push(token.clone());
    let status = *fake.claude_status.lock().unwrap();
    if token != "Bearer claude-token" || status != StatusCode::OK {
        return (status, Json(json!({ "error": { "message": "no access" } })));
    }
    (
        StatusCode::OK,
        Json(json!({ "data": [
            { "id": "claude-sonnet-5", "display_name": "Claude Sonnet 5" },
            { "id": "claude-retired-3" }
        ] })),
    )
}

struct Harness {
    state: AppState,
    fake: FakeUpstream,
    server: JoinHandle<()>,
}

impl Drop for Harness {
    fn drop(&mut self) {
        self.server.abort();
    }
}

async fn add_connection(state: &AppState, user_id: Uuid, provider: &str, access_token: &str) {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status)
         VALUES ($1, $2, $3, 'connected')",
    )
    .bind(id)
    .bind(user_id)
    .bind(provider)
    .execute(&state.pool)
    .await
    .unwrap();
    let token = json!({ "access_token": access_token, "account_id": "account-1" });
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
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
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn start(pool: PgPool) -> Harness {
    // The docs catalogue is cached process-wide; seed it so no test reaches the
    // network and every run sees the same current catalogue.
    for (cache, catalogue) in [
        (&OPENAI_DOCS_CACHE, default_openai_model_catalogue()),
        (&CLAUDE_DOCS_CACHE, default_claude_model_catalogue()),
    ] {
        let cache = cache.get_or_init(|| std::sync::RwLock::new((Instant::now(), Value::Null)));
        *cache.write().unwrap() = (Instant::now(), catalogue);
    }
    let fake = FakeUpstream {
        tokens: Arc::new(Mutex::new(Vec::new())),
        claude_status: Arc::new(Mutex::new(StatusCode::OK)),
    };
    let router = Router::new()
        .route("/codex/models", get(chatgpt_models))
        .route("/v1/models", get(claude_models_upstream))
        .with_state(fake.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    let config = AppConfig {
        chatgpt_codex_models_url: format!("{url}/codex/models"),
        claude_models_url: format!("{url}/v1/models?limit=1000"),
        ..AppConfig::default()
    };
    let state = AppState {
        config,
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    };
    let user_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(user_id)
        .bind(user_id.simple().to_string())
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four) VALUES ($1, $2, $3, $4)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(hash_gateway_key(GATEWAY_KEY))
    .bind("6789")
    .execute(&state.pool)
    .await
    .unwrap();
    add_connection(&state, user_id, "chatgpt", "chatgpt-token").await;
    add_connection(&state, user_id, "claude", "claude-token").await;
    Harness {
        state,
        fake,
        server,
    }
}

fn key_headers() -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {GATEWAY_KEY}")).unwrap(),
    );
    headers
}

async fn ids(response: Response) -> Vec<String> {
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    payload["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap().to_owned())
        .collect()
}

#[sqlx::test]
async fn chatgpt_key_lists_only_models_the_subscription_has(pool: PgPool) {
    let harness = start(pool).await;
    let response = openai_models(State(harness.state.clone()), key_headers())
        .await
        .unwrap();
    assert_eq!(ids(response).await, ["gpt-6-sol", "gpt-5.6-luna"]);
    assert_eq!(
        *harness.fake.tokens.lock().unwrap(),
        ["Bearer chatgpt-token"],
        "the list came from the subscriber's own account"
    );
}

#[sqlx::test]
async fn claude_key_lists_only_models_the_subscription_has(pool: PgPool) {
    let harness = start(pool).await;
    let response = claude_models(State(harness.state.clone()), key_headers())
        .await
        .unwrap();
    assert_eq!(ids(response).await, ["claude-sonnet-5"]);
    assert_eq!(
        *harness.fake.tokens.lock().unwrap(),
        ["Bearer claude-token"]
    );
}

#[sqlx::test]
async fn account_without_access_gets_an_error_not_the_catalogue(pool: PgPool) {
    let harness = start(pool).await;
    *harness.fake.claude_status.lock().unwrap() = StatusCode::FORBIDDEN;
    let response = claude_models(State(harness.state.clone()), key_headers())
        .await
        .unwrap();
    assert_ne!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    let text = String::from_utf8_lossy(&body);
    assert!(
        !text.contains("claude-sonnet-5") && !text.contains("claude-opus"),
        "no catalogue fallback: {text}"
    );
}
