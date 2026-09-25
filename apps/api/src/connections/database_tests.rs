use std::collections::HashMap;

use axum::{
    Form, Json, Router,
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::net::TcpListener;
use uuid::Uuid;

use super::{
    ConnectionRow, ProviderCredentialRefreshStatus, decrypt_json, encrypt_json, finish_connection,
    refresh_all_provider_credentials,
};
use crate::{AppConfig, AppState};

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

async fn connection(state: &AppState, owner: Uuid, provider: &str) -> ConnectionRow {
    sqlx::query_as(
        "INSERT INTO agent_connections (id, user_id, provider, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id, provider, status,
         account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(Uuid::new_v4())
    .bind(owner)
    .bind(provider)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

async fn store_credential(state: &AppState, id: Uuid, token: Value) {
    let (ciphertext, nonce) =
        encrypt_json(&state.config.credential_encryption_key, &token).unwrap();
    sqlx::query(
        "INSERT INTO agent_connection_credentials
         (connection_id, credential_ciphertext, credential_nonce) VALUES ($1, $2, $3)",
    )
    .bind(id)
    .bind(ciphertext)
    .bind(nonce)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query("UPDATE agent_connections SET status='connected' WHERE id=$1")
        .bind(id)
        .execute(&state.pool)
        .await
        .unwrap();
}

fn token(provider: &str, subject: &str, access: &str) -> Value {
    let mut claims = json!({ "sub": subject, "email": format!("person+{subject}@example.test") });
    if provider == "chatgpt" {
        claims["https://api.openai.com/auth"] = json!({"chatgpt_account_id": "same-account"});
    }
    let mut token = json!({
        "access_token": access,
        "refresh_token": "test-refresh",
        "id_token": format!("header.{}.signature", URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap()))
    });
    if provider == "chatgpt" {
        token["hub_account_identity"] = json!("id:same-account");
    }
    token
}

#[sqlx::test]
async fn reconnect_reuses_legacy_account_and_transfers_owner_without_losing_members(pool: PgPool) {
    let state = state(pool);
    let original_owner = user(&state.pool).await;
    let next_owner = user(&state.pool).await;
    let member = user(&state.pool).await;
    for provider in ["grok", "chatgpt"] {
        let existing = connection(&state, original_owner, provider).await;
        store_credential(
            &state,
            existing.id,
            token(provider, "old-sub", "old-access"),
        )
        .await;
        for requester in [member, next_owner] {
            sqlx::query(
                "INSERT INTO agent_pool_join_requests
                 (id, connection_id, requester_user_id, telegram, reason, status)
                 VALUES ($1, $2, $3, '@test', 'test membership', 'accepted')",
            )
            .bind(Uuid::new_v4())
            .bind(existing.id)
            .bind(requester)
            .execute(&state.pool)
            .await
            .unwrap();
        }
        let attempt = connection(&state, next_owner, provider).await;
        let attempt_id = attempt.id;
        let completed =
            finish_connection(&state, attempt, token(provider, "old-sub", "new-access"))
                .await
                .unwrap();
        assert_eq!(completed.id, existing.id);
        let (owner, created_at): (Uuid, chrono::DateTime<chrono::Utc>) =
            sqlx::query_as("SELECT user_id, created_at FROM agent_connections WHERE id=$1")
                .bind(existing.id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(owner, next_owner);
        assert_eq!(created_at, existing.created_at);
        let requests: Vec<Uuid> = sqlx::query_scalar(
            "SELECT requester_user_id FROM agent_pool_join_requests WHERE connection_id=$1",
        )
        .bind(existing.id)
        .fetch_all(&state.pool)
        .await
        .unwrap();
        assert_eq!(requests, vec![member]);
        let remaining: i64 =
            sqlx::query_scalar("SELECT count(*) FROM agent_connections WHERE id=$1")
                .bind(attempt_id)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(remaining, 0);
        let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT credential_ciphertext, credential_nonce FROM agent_connection_credentials WHERE connection_id=$1",
        ).bind(existing.id).fetch_one(&state.pool).await.unwrap();
        let stored: Value =
            decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce).unwrap();
        assert_eq!(stored["access_token"], "new-access");
        assert!(stored["hub_account_identity"].is_string());
    }
}

#[sqlx::test]
async fn chatgpt_logins_sharing_a_workspace_remain_separate_and_reauthorize_independently(
    pool: PgPool,
) {
    let state = state(pool);
    let first_owner = user(&state.pool).await;
    let second_owner = user(&state.pool).await;
    let first = connection(&state, first_owner, "chatgpt").await;
    let first_id = first.id;
    store_credential(
        &state,
        first_id,
        token("chatgpt", "maple-user", "maple-access"),
    )
    .await;
    let second = connection(&state, second_owner, "chatgpt").await;
    let second_id = second.id;
    let completed = finish_connection(
        &state,
        second,
        token("chatgpt", "juliet-user", "juliet-access"),
    )
    .await
    .unwrap();
    assert_eq!(completed.id, second_id);
    let pools: Vec<(Uuid, Uuid)> =
        sqlx::query_as("SELECT id, user_id FROM agent_connections WHERE status='connected'")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(pools.len(), 2);
    assert!(pools.contains(&(first_id, first_owner)));
    assert!(pools.contains(&(second_id, second_owner)));

    // A legacy cached workspace ID must not reject the same user's reconnect.
    let first = super::owned_connection_by_id(&state, first_id)
        .await
        .unwrap();
    let reauthorized = finish_connection(
        &state,
        first,
        token("chatgpt", "maple-user", "maple-rotated"),
    )
    .await
    .unwrap();
    assert_eq!(reauthorized.id, first_id);
    let first = super::owned_connection_by_id(&state, first_id)
        .await
        .unwrap();
    assert!(
        finish_connection(
            &state,
            first,
            token("chatgpt", "juliet-user", "wrong-login")
        )
        .await
        .is_err()
    );
    for (id, expected_access, expected_identity) in [
        (first_id, "maple-rotated", "chatgpt:sub:maple-user"),
        (second_id, "juliet-access", "chatgpt:sub:juliet-user"),
    ] {
        let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = sqlx::query_as("SELECT credential_ciphertext, credential_nonce FROM agent_connection_credentials WHERE connection_id=$1")
            .bind(id).fetch_one(&state.pool).await.unwrap();
        let stored: Value =
            decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce).unwrap();
        assert_eq!(stored["access_token"], expected_access);
        assert_eq!(stored["hub_account_identity"], expected_identity);
    }
}

#[sqlx::test]
async fn forced_batch_refresh_isolates_rejected_credentials_and_keeps_pool_ids(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/oauth2/token",
            post(|Form(form): Form<HashMap<String, String>>| async move {
                if form.get("refresh_token").map(String::as_str) == Some("rejected") {
                    (StatusCode::BAD_REQUEST, Json(json!({"error": "invalid_grant"})))
                } else if form.get("refresh_token").map(String::as_str) == Some("bad-client") {
                    (StatusCode::UNAUTHORIZED, Json(json!({"error": "invalid_client"})))
                } else {
                    (StatusCode::OK, Json(json!({"access_token": "rotated-access", "refresh_token": "rotated-refresh", "expires_in": 3600})))
                }
            }),
        )
        .route(
            "/oauth/token",
            post(|| async {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(json!({ "error": {
                        "type": "invalid_request_error",
                        "code": "refresh_token_invalidated"
                    } })),
                )
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.grok_issuer = issuer.clone();
    state.config.codex_issuer = issuer;
    let owner = user(&state.pool).await;
    let rejected = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        rejected.id,
        json!({"access_token": "old", "refresh_token": "rejected"}),
    )
    .await;
    let accepted = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        accepted.id,
        json!({"access_token": "old", "refresh_token": "valid"}),
    )
    .await;
    let client_error = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        client_error.id,
        json!({"access_token": "old", "refresh_token": "bad-client"}),
    )
    .await;
    let invalidated_chatgpt = connection(&state, owner, "chatgpt").await;
    store_credential(
        &state,
        invalidated_chatgpt.id,
        json!({"access_token": "old", "refresh_token": "revoked-chatgpt"}),
    )
    .await;
    sqlx::query("UPDATE agent_connections SET availability_status='reauth_required' WHERE id=$1")
        .bind(accepted.id)
        .execute(&state.pool)
        .await
        .unwrap();

    let results = refresh_all_provider_credentials(&state).await.unwrap();
    assert_eq!(results.len(), 4);
    assert!(
        results
            .iter()
            .any(|result| result.connection_id == rejected.id
                && matches!(
                    result.status,
                    ProviderCredentialRefreshStatus::ReauthorizationRequired
                ))
    );
    assert!(
        results
            .iter()
            .any(|result| result.connection_id == accepted.id
                && matches!(result.status, ProviderCredentialRefreshStatus::Refreshed))
    );
    assert!(
        results
            .iter()
            .any(|result| result.connection_id == client_error.id
                && matches!(result.status, ProviderCredentialRefreshStatus::Failed))
    );
    assert!(
        results
            .iter()
            .any(|result| result.connection_id == invalidated_chatgpt.id
                && matches!(
                    result.status,
                    ProviderCredentialRefreshStatus::ReauthorizationRequired
                ))
    );
    for (id, expected_availability) in [
        (rejected.id, "reauth_required"),
        (accepted.id, "active"),
        (client_error.id, "active"),
        (invalidated_chatgpt.id, "reauth_required"),
    ] {
        let row: (String, String, bool) = sqlx::query_as(
            "SELECT c.status, c.availability_status, d.refresh_attempted_at IS NOT NULL
             FROM agent_connections c JOIN agent_connection_credentials d ON d.connection_id=c.id WHERE c.id=$1",
        ).bind(id).fetch_one(&state.pool).await.unwrap();
        assert_eq!(
            row,
            (
                "connected".to_owned(),
                expected_availability.to_owned(),
                true
            )
        );
    }
    let authorization_count: i64 =
        sqlx::query_scalar("SELECT count(*) FROM agent_connection_authorizations")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(authorization_count, 0);
    server.abort();
}

#[sqlx::test]
async fn forced_batch_validates_deepseek_and_distinguishes_rejection_from_outage(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/models",
        get(|headers: HeaderMap| async move {
            match headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
            {
                Some("Bearer rejected") => StatusCode::UNAUTHORIZED,
                Some("Bearer forbidden") => StatusCode::FORBIDDEN,
                Some("Bearer unavailable") => StatusCode::SERVICE_UNAVAILABLE,
                Some("Bearer valid") => StatusCode::OK,
                _ => panic!("Unexpected test API key"),
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.deepseek_api_url = api_url;
    let owner = user(&state.pool).await;
    let mut identifiers = HashMap::new();
    for key in ["rejected", "forbidden", "unavailable", "valid"] {
        let row = connection(&state, owner, "deepseek").await;
        store_credential(&state, row.id, json!({"access_token": key})).await;
        identifiers.insert(key, row.id);
    }
    let results = refresh_all_provider_credentials(&state).await.unwrap();
    assert_eq!(results.len(), 4);
    for (key, expected_status, expected_availability) in [
        ("rejected", "reauthorization_required", "reauth_required"),
        ("forbidden", "reauthorization_required", "reauth_required"),
        ("unavailable", "failed", "active"),
        ("valid", "refreshed", "active"),
    ] {
        let result = results
            .iter()
            .find(|result| result.connection_id == identifiers[key])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&result.status).unwrap(),
            expected_status
        );
        let availability: String =
            sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id=$1")
                .bind(identifiers[key])
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(availability, expected_availability);
    }
    server.abort();
}
