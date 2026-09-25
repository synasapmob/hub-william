use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    routing::{get, post},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::net::TcpListener;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{AppConfig, AppState, app};

async fn user(pool: &PgPool) -> (Uuid, String) {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(id.simple().to_string())
        .execute(pool)
        .await
        .unwrap();
    let token = Uuid::new_v4().to_string();
    sqlx::query("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')")
        .bind(Uuid::new_v4()).bind(id).bind(format!("{:x}", Sha256::digest(token.as_bytes()))).execute(pool).await.unwrap();
    (id, format!("hub_session={token}"))
}

fn request(connection_id: Uuid, cookie: &str, origin: &str) -> Request<Body> {
    Request::builder().method("POST").uri("/playground/chat")
        .header("cookie", cookie).header("origin", origin).header("content-type", "application/json")
        .header("x-browser-secret", "never-forward-this")
        .body(Body::from(json!({"connection_id":connection_id,"provider":"deepseek", "model":"deepseek-flash", "messages":[{"role":"user", "content":"Hello"},{"role":"assistant", "content":"Hi"},{"role":"user", "content":"Continue"}]}).to_string())).unwrap()
}

async fn fixture(pool: PgPool) -> (AppState, tokio::task::JoinHandle<()>) {
    let upstream = Router::new()
        .route("/models", get(|| async { Json(json!({"data":[{"id":"deepseek-flash", "name":"Test model"}]})) }))
        .route("/responses", post(|headers: HeaderMap, Json(body): Json<Value>| async move {
            assert_eq!(headers.get("authorization").unwrap(), "Bearer test-provider-token");
            assert!(!headers.contains_key("cookie"));
            assert!(!headers.contains_key("origin"));
            assert!(!headers.contains_key("x-browser-secret"));
            assert_eq!(body["input"][1]["content"], "Hi");
            assert_eq!(body["input"][2]["role"], "user");
            ([("content-type", "text/event-stream")], "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello from upstream\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
        }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = AppConfig {
        deepseek_api_url: format!("http://{}", listener.local_addr().unwrap()),
        ..AppConfig::default()
    };
    let task = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });
    (
        AppState {
            config,
            pool,
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
        },
        task,
    )
}

async fn connection(state: &AppState, owner: Uuid) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_connections (id, user_id, provider, status) VALUES ($1, $2, 'deepseek', 'connected')")
        .bind(id).bind(owner).execute(&state.pool).await.unwrap();
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
    let nonce = [4_u8; 12];
    let payload = json!({"access_token":"test-provider-token"}).to_string();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), payload.as_bytes())
        .unwrap();
    sqlx::query("INSERT INTO agent_connection_credentials (connection_id, credential_ciphertext, credential_nonce, access_token_expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')")
        .bind(id).bind(ciphertext).bind(nonce.to_vec()).execute(&state.pool).await.unwrap();
    id
}

#[sqlx::test]
async fn session_authorization_streaming_and_membership_revocation(pool: PgPool) {
    let (state, upstream) = fixture(pool).await;
    let (owner, owner_cookie) = user(&state.pool).await;
    let (member, member_cookie) = user(&state.pool).await;
    let (_, outsider_cookie) = user(&state.pool).await;
    let second_connection = connection(&state, owner).await;
    let connection = connection(&state, owner).await;
    let router = app(state.clone());
    assert_eq!(
        router
            .clone()
            .oneshot(request(connection, "", "http://localhost:5173"))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request(
                connection,
                &owner_cookie,
                "https://attacker.example"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        router
            .clone()
            .oneshot(request(
                connection,
                &outsider_cookie,
                "http://localhost:5173"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    // Another connected account must not grant access to the selected account.
    let (other_owner, _) = user(&state.pool).await;
    sqlx::query("UPDATE agent_connections SET user_id=$1 WHERE id=$2")
        .bind(other_owner)
        .bind(second_connection)
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(request(
                second_connection,
                &owner_cookie,
                "http://localhost:5173"
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let wrong_provider = Request::builder()
        .uri(format!("/playground/claude/accounts/{connection}/models"))
        .header("cookie", &owner_cookie)
        .body(Body::empty())
        .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(wrong_provider)
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    // Reject unauthenticated uploads before polling an arbitrary request body.
    let never_read = futures_util::stream::poll_fn(
        |_| -> std::task::Poll<Option<Result<Bytes, std::io::Error>>> {
            panic!("unauthenticated body was polled")
        },
    );
    let upload = Request::builder()
        .method("POST")
        .uri("/playground/chat")
        .header("content-type", "application/json")
        .header("origin", "http://localhost:5173")
        .body(Body::from_stream(never_read))
        .unwrap();
    assert_eq!(
        router.clone().oneshot(upload).await.unwrap().status(),
        StatusCode::UNAUTHORIZED
    );
    sqlx::query("INSERT INTO agent_pool_join_requests (id, connection_id, requester_user_id, reason, telegram, status) VALUES ($1,$2,$3,'test access','@tester','accepted')")
        .bind(Uuid::new_v4()).bind(connection).bind(member).execute(&state.pool).await.unwrap();
    for cookie in [&owner_cookie, &member_cookie] {
        let response = router
            .clone()
            .oneshot(request(connection, cookie, "http://localhost:5173"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()["content-type"], "text/event-stream");
        let body = to_bytes(response.into_body(), 65536).await.unwrap();
        let stream = String::from_utf8(body.to_vec()).unwrap();
        assert!(stream.contains("Hello from upstream"));
        assert!(stream.contains("response.completed"));
        assert!(!stream.contains("test-provider-token"));
    }
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/playground/deepseek/accounts/{connection}/models"))
                .header("cookie", &member_cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let models: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 65536).await.unwrap()).unwrap();
    assert_eq!(
        models,
        json!([{"id":"deepseek-flash", "name":"Test model"}])
    );
    sqlx::query("UPDATE agent_pool_join_requests SET status='rejected' WHERE requester_user_id=$1")
        .bind(member)
        .execute(&state.pool)
        .await
        .unwrap();
    assert_eq!(
        router
            .clone()
            .oneshot(request(connection, &member_cookie, "http://localhost:5173"))
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let keys: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_keys")
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(keys, 0, "Browser chat must not create gateway keys");
    upstream.abort();
}
