use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};

use axum::{
    Form, Json, Router,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, Uri},
    routing::{get, post},
};
use axum_extra::extract::{CookieJar, cookie::Cookie};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tokio::{net::TcpListener, sync::Notify, task::JoinHandle};
use uuid::Uuid;

use super::{
    ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, AgentConnectionStatus, AgentProvider,
    AuthorizationSecret, ConnectionRow, CredentialLookup, CredentialRefreshMode,
    EXPIRED_AUTHORIZATION_PROMPT_MESSAGE, EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE,
    PROVIDER_LOGIN_REQUIRED_MESSAGE, ProviderCredentialRefreshStatus,
    ProviderCredentialRefreshSummary, RefreshConnectionOutcome, decrypt_json, encrypt_json,
    finish_connection, gateway_credential, get_connection, refresh_all_provider_credentials,
    refresh_connected_connection, refresh_connection, refresh_due_provider_credentials,
    refresh_nightly_provider_credentials, scheduled_refresh_after,
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
         VALUES ($1, $2, $3, 'pending') RETURNING id, provider, status, availability_status,
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
async fn forced_batch_marks_only_explicit_gemini_verification_challenges_red(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new()
        .route(
            "/token",
            post(|Form(form): Form<HashMap<String, String>>| async move {
                let access = match form.get("refresh_token").map(String::as_str) {
                    Some("fetch-challenge") => "fetch-challenge-access",
                    Some("count-challenge") => "count-challenge-access",
                    Some("generation-challenge") => "generation-challenge-access",
                    Some("verified") => "verified-access",
                    Some("generic-forbidden") => "generic-forbidden-access",
                    Some("generic-red") => "generic-red-access",
                    other => panic!("unexpected refresh token: {other:?}"),
                };
                Json(json!({
                    "access_token": access,
                    "refresh_token": "rotated-refresh",
                    "expires_in": 3600
                }))
            }),
        )
        .route(
            "/v1internal:fetchAvailableModels",
            post(|headers: HeaderMap| async move {
                match headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                {
                    Some("Bearer fetch-challenge-access") => (
                        StatusCode::FORBIDDEN,
                        Json(json!({"error": {"message": "Verify your account to continue."}})),
                    ),
                    Some("Bearer count-challenge-access")
                    | Some("Bearer generation-challenge-access")
                    | Some("Bearer verified-access") => (
                        StatusCode::OK,
                        Json(
                            json!({"models": {"gemini-3.8-flash-high": {"displayName": "Flash"}}}),
                        ),
                    ),
                    Some("Bearer generic-forbidden-access") | Some("Bearer generic-red-access") => {
                        (
                            StatusCode::FORBIDDEN,
                            Json(json!({"error": {"message": "Project lacks model permission"}})),
                        )
                    }
                    other => panic!("unexpected authorization: {other:?}"),
                }
            }),
        )
        .route(
            "/v1internal:countTokens",
            post(|headers: HeaderMap| async move {
                match headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                {
                    Some("Bearer count-challenge-access") => (
                        StatusCode::FORBIDDEN,
                        Json(json!({"error": {"message": "Verify your account to continue."}})),
                    ),
                    Some("Bearer generation-challenge-access") | Some("Bearer verified-access") => {
                        (StatusCode::OK, Json(json!({"tokenCount": 1})))
                    }
                    other => panic!("unexpected count authorization: {other:?}"),
                }
            }),
        )
        .route(
            "/v1internal:generateContent",
            post(|headers: HeaderMap| async move {
                match headers
                    .get("authorization")
                    .and_then(|value| value.to_str().ok())
                {
                    Some("Bearer generation-challenge-access") => (
                        StatusCode::FORBIDDEN,
                        Json(json!({"error": {"message": "Verify your account to continue."}})),
                    ),
                    Some("Bearer verified-access") => (
                        StatusCode::OK,
                        Json(json!({"response": {"candidates": []}})),
                    ),
                    other => panic!("unexpected generation authorization: {other:?}"),
                }
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.gemini_token_url = format!("{issuer}/token");
    state.config.gemini_code_assist_url = issuer;
    let owner = user(&state.pool).await;
    let mut ids = HashMap::new();
    for case in [
        "fetch-challenge",
        "count-challenge",
        "generation-challenge",
        "verified",
        "generic-forbidden",
        "generic-red",
    ] {
        let row = connection(&state, owner, "gemini").await;
        let mut credential = token("gemini", case, "old-access");
        credential["refresh_token"] = json!(case);
        credential["cloudaicompanion_project"] = json!("test-project");
        store_credential(&state, row.id, credential).await;
        if case == "generic-red" {
            sqlx::query(
                "UPDATE agent_connections SET availability_status = 'reauth_required' WHERE id = $1",
            )
            .bind(row.id)
            .execute(&state.pool)
            .await
            .unwrap();
        }
        ids.insert(case, row.id);
    }

    let results = refresh_all_provider_credentials(&state).await.unwrap();
    assert_eq!(results.len(), 6);
    for (case, expected_result, expected_availability) in [
        (
            "fetch-challenge",
            "reauthorization_required",
            "reauth_required",
        ),
        (
            "count-challenge",
            "reauthorization_required",
            "reauth_required",
        ),
        (
            "generation-challenge",
            "reauthorization_required",
            "reauth_required",
        ),
        ("verified", "refreshed", "active"),
        ("generic-forbidden", "refreshed", "active"),
        ("generic-red", "reauthorization_required", "reauth_required"),
    ] {
        let result = results
            .iter()
            .find(|result| result.connection_id == ids[case])
            .unwrap();
        assert_eq!(
            serde_json::to_value(&result.status).unwrap(),
            expected_result
        );
        let (availability, ciphertext, nonce): (String, Vec<u8>, Vec<u8>) = sqlx::query_as(
            "SELECT c.availability_status, d.credential_ciphertext, d.credential_nonce
             FROM agent_connections c JOIN agent_connection_credentials d
               ON d.connection_id = c.id WHERE c.id = $1",
        )
        .bind(ids[case])
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert_eq!(availability, expected_availability);
        let stored: Value =
            decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce).unwrap();
        assert_eq!(stored["refresh_token"], "rotated-refresh");
    }
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

#[sqlx::test]
async fn nightly_sweep_checks_all_connected_types_once_across_replicas(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let oauth_calls = Arc::new(AtomicUsize::new(0));
    let key_checks = Arc::new(AtomicUsize::new(0));
    let oauth_counter = oauth_calls.clone();
    let key_counter = key_checks.clone();
    let app = Router::new()
        .route(
            "/oauth2/token",
            post(move || {
                let counter = oauth_counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    Json(json!({
                        "access_token": "rotated-access",
                        "refresh_token": "rotated-refresh",
                        "expires_in": 3600
                    }))
                }
            }),
        )
        .route(
            "/models",
            get(move || {
                let counter = key_counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    StatusCode::OK
                }
            }),
        );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.grok_issuer = issuer.clone();
    state.config.deepseek_api_url = issuer;
    let owner = user(&state.pool).await;
    let oauth = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        oauth.id,
        json!({"access_token": "old", "refresh_token": "valid"}),
    )
    .await;
    let static_key = connection(&state, owner, "deepseek").await;
    store_credential(&state, static_key.id, json!({"access_token": "valid"})).await;
    let fresh = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        fresh.id,
        json!({"access_token": "current", "refresh_token": "valid"}),
    )
    .await;
    let reauthorization_required = connection(&state, owner, "grok").await;
    store_credential(
        &state,
        reauthorization_required.id,
        json!({"access_token": "old", "refresh_token": "revoked"}),
    )
    .await;

    let day_start = Utc::now() - Duration::hours(1);
    for id in [oauth.id, static_key.id, reauthorization_required.id] {
        sqlx::query(
            "UPDATE agent_connection_credentials
             SET updated_at = $2, refresh_attempted_at = NULL WHERE connection_id = $1",
        )
        .bind(id)
        .bind(day_start - Duration::minutes(1))
        .execute(&state.pool)
        .await
        .unwrap();
    }
    sqlx::query("UPDATE agent_connections SET availability_status = 'rate_limited' WHERE id = $1")
        .bind(oauth.id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE agent_connections SET availability_status = 'reauth_required' WHERE id = $1",
    )
    .bind(reauthorization_required.id)
    .execute(&state.pool)
    .await
    .unwrap();

    let (first, second) = tokio::join!(
        refresh_nightly_provider_credentials(&state, day_start),
        refresh_nightly_provider_credentials(&state, day_start)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.refreshed + second.refreshed, 2);
    assert_eq!(first.failed + second.failed, 0);
    assert_eq!(oauth_calls.load(Ordering::SeqCst), 1);
    assert_eq!(key_checks.load(Ordering::SeqCst), 1);

    let repeated = refresh_nightly_provider_credentials(&state, day_start)
        .await
        .unwrap();
    assert_eq!(repeated.refreshed, 0);
    for id in [oauth.id, static_key.id] {
        let attempted_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
            "SELECT refresh_attempted_at FROM agent_connection_credentials WHERE connection_id = $1",
        )
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert!(attempted_at.is_some_and(|attempted_at| attempted_at >= day_start));
    }
    let availability: String =
        sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
            .bind(oauth.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(availability, "rate_limited");
    for id in [fresh.id, reauthorization_required.id] {
        let attempted_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
            "SELECT refresh_attempted_at FROM agent_connection_credentials WHERE connection_id = $1",
        )
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .unwrap();
        assert!(attempted_at.is_none());
    }
    server.abort();
}

#[sqlx::test]
async fn nightly_provider_outage_records_attempt_before_unlocking(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let checks = Arc::new(AtomicUsize::new(0));
    let counter = checks.clone();
    let app = Router::new().route(
        "/models",
        get(move || {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                StatusCode::SERVICE_UNAVAILABLE
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.deepseek_api_url = api_url;
    let owner = user(&state.pool).await;
    let static_key = connection(&state, owner, "deepseek").await;
    store_credential(&state, static_key.id, json!({"access_token": "valid"})).await;
    let day_start = Utc::now() - Duration::hours(1);
    sqlx::query(
        "UPDATE agent_connection_credentials
         SET updated_at = $2, refresh_attempted_at = NULL WHERE connection_id = $1",
    )
    .bind(static_key.id)
    .bind(day_start - Duration::minutes(1))
    .execute(&state.pool)
    .await
    .unwrap();

    let (first, second) = tokio::join!(
        refresh_nightly_provider_credentials(&state, day_start),
        refresh_nightly_provider_credentials(&state, day_start)
    );
    let first = first.unwrap();
    let second = second.unwrap();
    assert_eq!(first.failed + second.failed, 1);
    assert_eq!(checks.load(Ordering::SeqCst), 1);
    let attempted_at: Option<chrono::DateTime<Utc>> = sqlx::query_scalar(
        "SELECT refresh_attempted_at FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(static_key.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(attempted_at.is_some_and(|attempted_at| attempted_at >= day_start));
    let availability: String =
        sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
            .bind(static_key.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(availability, "active");
    server.abort();
}

#[sqlx::test]
async fn rejected_refresh_marks_reauthorization_before_a_new_login(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let app = Router::new().route(
        "/oauth2/token",
        post(|| async {
            (
                StatusCode::BAD_REQUEST,
                Json(json!({"error": "invalid_grant"})),
            )
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let old = connection(&state, owner, "grok").await;
    let connection_id = old.id;
    store_credential(&state, old.id, token("grok", "same-account", "old")).await;
    let day_start = Utc::now() - Duration::hours(1);
    sqlx::query(
        "UPDATE agent_connection_credentials
         SET updated_at = $2, refresh_attempted_at = NULL WHERE connection_id = $1",
    )
    .bind(old.id)
    .bind(day_start - Duration::minutes(1))
    .execute(&state.pool)
    .await
    .unwrap();
    let connected: ConnectionRow = sqlx::query_as(
        "SELECT id, provider, status, availability_status, account_label, plan, failure_message,
                created_at, updated_at FROM agent_connections WHERE id = $1",
    )
    .bind(old.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();

    assert!(matches!(
        refresh_connected_connection(&state, connected, CredentialRefreshMode::Nightly(day_start))
            .await
            .unwrap(),
        RefreshConnectionOutcome::ReauthorizationRequired(_)
    ));
    let availability: String =
        sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
            .bind(old.id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(availability, "reauth_required");

    let fresh = token("grok", "same-account", "new");
    finish_connection(&state, old, fresh).await.unwrap();
    let (availability, failure_message): (String, Option<String>) = sqlx::query_as(
        "SELECT availability_status, failure_message FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(availability, "active");
    assert!(failure_message.is_none());
    server.abort();
}

// Background refresh cadence, recovery and cancellation safety.
//
// These tests use Grok accounts: the refresh endpoint is the configurable
// `grok_issuer`, and a Grok refresh resolves account metadata from the token
// alone, so no path exercised here can reach a real provider.

type ProviderCalls = Arc<Mutex<Vec<String>>>;
type AccountState = (String, String, Option<String>);
type CredentialSnapshot = (Vec<u8>, DateTime<Utc>, Option<DateTime<Utc>>);

/// A fake Grok issuer. Each token request records its refresh token; refresh
/// token `rejected` is answered with `invalid_grant` and any other `<token>`
/// rotates to `<token>-access` / `<token>-rotated`. A request to any other
/// path is recorded as unexpected and fails.
async fn fake_grok_issuer() -> (String, ProviderCalls, JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let calls = ProviderCalls::default();
    let token_calls = calls.clone();
    let unexpected_calls = calls.clone();
    let app = Router::new()
        .route(
            "/oauth2/token",
            post(move |Form(form): Form<HashMap<String, String>>| {
                let calls = token_calls.clone();
                async move {
                    let refresh_token = form.get("refresh_token").cloned().unwrap_or_default();
                    calls.lock().unwrap().push(refresh_token.clone());
                    if refresh_token == "rejected" {
                        return (
                            StatusCode::BAD_REQUEST,
                            Json(json!({"error": "invalid_grant"})),
                        );
                    }
                    (
                        StatusCode::OK,
                        Json(json!({
                            "access_token": format!("{refresh_token}-access"),
                            "refresh_token": format!("{refresh_token}-rotated"),
                            "expires_in": 3600
                        })),
                    )
                }
            }),
        )
        .fallback(move |uri: Uri| {
            let calls = unexpected_calls.clone();
            async move {
                calls.lock().unwrap().push(format!("unexpected {uri}"));
                StatusCode::INTERNAL_SERVER_ERROR
            }
        });
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (issuer, calls, server)
}

fn recorded(calls: &ProviderCalls) -> Vec<String> {
    let mut calls = calls.lock().unwrap().clone();
    calls.sort();
    calls
}

fn counts(summary: &ProviderCredentialRefreshSummary) -> [u64; 4] {
    [
        summary.refreshed,
        summary.recovered,
        summary.reauthorization_required,
        summary.failed,
    ]
}

fn account(status: &str, availability: &str, failure_message: Option<&str>) -> AccountState {
    (
        status.to_owned(),
        availability.to_owned(),
        failure_message.map(str::to_owned),
    )
}

async fn session_jar(pool: &PgPool, user_id: Uuid) -> CookieJar {
    let token = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(format!("{:x}", Sha256::digest(token.as_bytes())))
    .execute(pool)
    .await
    .unwrap();
    CookieJar::new().add(Cookie::new("hub_session", token))
}

/// A pending connection whose ID ends in `last_byte`, which fixes its
/// scheduled refresh offset.
async fn connection_ending_in(
    state: &AppState,
    owner: Uuid,
    provider: &str,
    last_byte: u8,
) -> ConnectionRow {
    let mut id = *Uuid::new_v4().as_bytes();
    id[15] = last_byte;
    sqlx::query_as(
        "INSERT INTO agent_connections (id, user_id, provider, status)
         VALUES ($1, $2, $3, 'pending') RETURNING id, provider, status, availability_status,
         account_label, plan, failure_message, created_at, updated_at",
    )
    .bind(Uuid::from_bytes(id))
    .bind(owner)
    .bind(provider)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

async fn store_refreshable_credential(state: &AppState, id: Uuid, refresh_token: &str) {
    store_credential(
        state,
        id,
        json!({
            "access_token": format!("{refresh_token}-old-access"),
            "refresh_token": refresh_token
        }),
    )
    .await;
}

/// Backdate a credential's last refresh activity, measured on the database
/// clock that the due sweep compares against.
async fn backdate_refresh(
    state: &AppState,
    id: Uuid,
    updated_ago: Duration,
    attempted_ago: Option<Duration>,
) {
    sqlx::query(
        "UPDATE agent_connection_credentials
         SET updated_at = NOW() - make_interval(secs => $2),
             refresh_attempted_at = NOW() - make_interval(secs => $3)
         WHERE connection_id = $1",
    )
    .bind(id)
    .bind(updated_ago.num_seconds() as f64)
    .bind(attempted_ago.map(|ago| ago.num_seconds() as f64))
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn expire_access_token_in(state: &AppState, id: Uuid, expires_in: Duration) {
    sqlx::query(
        "UPDATE agent_connection_credentials
         SET access_token_expires_at = NOW() + make_interval(secs => $2)
         WHERE connection_id = $1",
    )
    .bind(id)
    .bind(expires_in.num_seconds() as f64)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn mark_for_reconnect(state: &AppState, id: Uuid, failure_message: Option<&str>) {
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', failure_message = $2 WHERE id = $1",
    )
    .bind(id)
    .bind(failure_message)
    .execute(&state.pool)
    .await
    .unwrap();
}

/// A Grok device-code reconnect prompt, as `start_connection_reauthorization`
/// stores it.
async fn reconnect_prompt(state: &AppState, id: Uuid, expires_at: DateTime<Utc>) {
    let secret = AuthorizationSecret::Grok {
        device_code: "old-device-code".to_owned(),
        user_code: "OLD-CODE".to_owned(),
        verification_uri_complete: "https://accounts.x.ai/device?user_code=OLD-CODE".to_owned(),
    };
    let (ciphertext, nonce) =
        encrypt_json(&state.config.credential_encryption_key, &secret).unwrap();
    sqlx::query(
        "INSERT INTO agent_connection_authorizations
         (connection_id, flow, secret_ciphertext, secret_nonce, expires_at)
         VALUES ($1, 'device_code', $2, $3, $4)",
    )
    .bind(id)
    .bind(ciphertext)
    .bind(nonce)
    .bind(expires_at)
    .execute(&state.pool)
    .await
    .unwrap();
}

async fn has_reconnect_prompt(state: &AppState, id: Uuid) -> bool {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM agent_connection_authorizations WHERE connection_id = $1)",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

async fn account_state(state: &AppState, id: Uuid) -> AccountState {
    sqlx::query_as(
        "SELECT status, availability_status, failure_message FROM agent_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

async fn stored_token(state: &AppState, id: Uuid) -> Value {
    let (ciphertext, nonce): (Vec<u8>, Vec<u8>) = sqlx::query_as(
        "SELECT credential_ciphertext, credential_nonce
         FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    decrypt_json(&state.config.credential_encryption_key, &ciphertext, &nonce).unwrap()
}

async fn credential_snapshot(state: &AppState, id: Uuid) -> CredentialSnapshot {
    sqlx::query_as(
        "SELECT credential_ciphertext, updated_at, refresh_attempted_at
         FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap()
}

#[sqlx::test]
async fn due_sweep_refreshes_each_account_only_after_its_thirty_to_forty_five_minute_interval(
    pool: PgPool,
) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;

    // The last ID byte sets the per-account offset: 0x00 refreshes after
    // exactly 30 minutes and 0xFF after 44m56s, the widest spread.
    let earliest = connection_ending_in(&state, owner, "grok", 0x00).await.id;
    let earliest_early = connection_ending_in(&state, owner, "grok", 0x00).await.id;
    let latest = connection_ending_in(&state, owner, "grok", 0xFF).await.id;
    let latest_early = connection_ending_in(&state, owner, "grok", 0xFF).await.id;
    let recently_attempted = connection_ending_in(&state, owner, "grok", 0x00).await.id;
    assert_eq!(scheduled_refresh_after(earliest), Duration::minutes(30));
    assert_eq!(
        scheduled_refresh_after(latest),
        Duration::seconds(44 * 60 + 56)
    );
    assert!(scheduled_refresh_after(latest) < Duration::minutes(45));

    for (id, refresh_token, updated_ago, attempted_ago) in [
        // Just past 30 minutes: the earliest offset is due.
        (
            earliest,
            "earliest-due",
            Duration::seconds(30 * 60 + 5),
            None,
        ),
        // Under 30 minutes: no account refreshes this early.
        (
            earliest_early,
            "earliest-early",
            Duration::seconds(29 * 60 + 30),
            None,
        ),
        // At 45 minutes even the latest offset is due.
        (latest, "latest-due", Duration::minutes(45), None),
        // Older than 30 minutes but still inside this account's own offset.
        (
            latest_early,
            "latest-early",
            Duration::seconds(44 * 60 + 26),
            None,
        ),
        // An old credential whose last scheduled attempt was recent waits a
        // full interval from that attempt.
        (
            recently_attempted,
            "recently-attempted",
            Duration::hours(2),
            Some(Duration::seconds(29 * 60 + 30)),
        ),
    ] {
        store_refreshable_credential(&state, id, refresh_token).await;
        backdate_refresh(&state, id, updated_ago, attempted_ago).await;
    }

    let summary = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&summary), [2, 0, 0, 0]);
    assert_eq!(recorded(&calls), ["earliest-due", "latest-due"]);
    for (id, refresh_token) in [(earliest, "earliest-due"), (latest, "latest-due")] {
        let stored = stored_token(&state, id).await;
        assert_eq!(stored["access_token"], format!("{refresh_token}-access"));
        assert_eq!(stored["refresh_token"], format!("{refresh_token}-rotated"));
        assert_eq!(
            account_state(&state, id).await,
            account("connected", "active", None)
        );
    }
    for (id, refresh_token) in [
        (earliest_early, "earliest-early"),
        (latest_early, "latest-early"),
        (recently_attempted, "recently-attempted"),
    ] {
        let stored = stored_token(&state, id).await;
        assert_eq!(
            stored["access_token"],
            format!("{refresh_token}-old-access")
        );
        assert_eq!(stored["refresh_token"], refresh_token);
    }

    // A rotated credential starts a new interval, so an immediate second sweep
    // makes no provider call.
    let repeated = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&repeated), [0, 0, 0, 0]);
    assert_eq!(recorded(&calls), ["earliest-due", "latest-due"]);
    server.abort();
}

#[sqlx::test]
async fn due_sweep_restores_accounts_marked_for_a_recoverable_reconnect(pool: PgPool) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;

    for (message, refresh_token) in [
        (PROVIDER_LOGIN_REQUIRED_MESSAGE, "login-required"),
        (EXPIRED_AUTHORIZATION_PROMPT_MESSAGE, "prompt-expired"),
    ] {
        let id = connection(&state, owner, "grok").await.id;
        store_refreshable_credential(&state, id, refresh_token).await;
        mark_for_reconnect(&state, id, Some(message)).await;
        backdate_refresh(&state, id, Duration::minutes(46), None).await;

        let summary = refresh_due_provider_credentials(&state).await.unwrap();
        assert_eq!(counts(&summary), [1, 1, 0, 0], "{message}");
        assert_eq!(
            account_state(&state, id).await,
            account("connected", "active", None),
            "{message}"
        );
        let stored = stored_token(&state, id).await;
        assert_eq!(stored["access_token"], format!("{refresh_token}-access"));
        assert_eq!(stored["refresh_token"], format!("{refresh_token}-rotated"));
    }
    assert_eq!(recorded(&calls), ["login-required", "prompt-expired"]);
    server.abort();
}

#[sqlx::test]
async fn due_sweep_skips_unrecoverable_marks_and_accounts_with_a_pending_reconnect(pool: PgPool) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer.clone();
    // A Gemini refresh or verification probe would reach the fake's
    // unexpected-call recorder instead of Google.
    state.config.gemini_token_url = format!("{issuer}/gemini/token");
    state.config.gemini_code_assist_url = format!("{issuer}/gemini");
    let owner = user(&state.pool).await;

    let mut skipped = Vec::new();
    for (provider, message, refresh_token, pending_reconnect) in [
        (
            "grok",
            Some(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE),
            "refresh-rejected",
            false,
        ),
        (
            "gemini",
            Some(ACCOUNT_VERIFICATION_REQUIRED_MESSAGE),
            "verification-required",
            false,
        ),
        ("grok", None, "unexplained-mark", false),
        (
            "grok",
            Some(PROVIDER_LOGIN_REQUIRED_MESSAGE),
            "owner-reconnecting",
            true,
        ),
    ] {
        let id = connection(&state, owner, provider).await.id;
        store_refreshable_credential(&state, id, refresh_token).await;
        mark_for_reconnect(&state, id, message).await;
        backdate_refresh(&state, id, Duration::hours(2), None).await;
        if pending_reconnect {
            reconnect_prompt(&state, id, Utc::now() + Duration::minutes(10)).await;
        }
        let before = credential_snapshot(&state, id).await;
        skipped.push((id, message, pending_reconnect, before));
    }
    // Control: the same due, recoverable mark without a pending reconnect is
    // retried, so the skips above are not an artefact of the fixture.
    let recoverable = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, recoverable, "recoverable").await;
    mark_for_reconnect(&state, recoverable, Some(PROVIDER_LOGIN_REQUIRED_MESSAGE)).await;
    backdate_refresh(&state, recoverable, Duration::hours(2), None).await;

    let summary = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&summary), [1, 1, 0, 0]);
    assert_eq!(recorded(&calls), ["recoverable"]);
    assert_eq!(
        account_state(&state, recoverable).await,
        account("connected", "active", None)
    );
    for (id, message, pending_reconnect, before) in skipped {
        assert_eq!(
            account_state(&state, id).await,
            account("connected", "reauth_required", message),
            "{message:?}"
        );
        assert_eq!(credential_snapshot(&state, id).await, before, "{message:?}");
        assert_eq!(
            has_reconnect_prompt(&state, id).await,
            pending_reconnect,
            "{message:?}"
        );
    }
    server.abort();
}

#[sqlx::test]
async fn rejected_recovery_refresh_keeps_the_mark_and_is_not_retried(pool: PgPool) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "rejected").await;
    mark_for_reconnect(&state, id, Some(PROVIDER_LOGIN_REQUIRED_MESSAGE)).await;
    backdate_refresh(&state, id, Duration::minutes(46), None).await;

    let summary = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&summary), [0, 0, 1, 0]);
    assert_eq!(recorded(&calls), ["rejected"]);
    let marked = account(
        "connected",
        "reauth_required",
        Some(EXPIRED_PROVIDER_AUTHORIZATION_MESSAGE),
    );
    assert_eq!(account_state(&state, id).await, marked);
    assert_eq!(stored_token(&state, id).await["refresh_token"], "rejected");

    // Long past its interval again, the dead refresh credential is still not
    // sent to the provider: only its owner can reconnect it now.
    backdate_refresh(&state, id, Duration::hours(2), None).await;
    let repeated = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&repeated), [0, 0, 0, 0]);
    assert_eq!(recorded(&calls), ["rejected"]);
    assert_eq!(account_state(&state, id).await, marked);
    server.abort();
}

#[sqlx::test]
async fn manual_refresh_clears_a_stale_reconnect_prompt_so_polling_keeps_the_account_active(
    pool: PgPool,
) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let jar = session_jar(&state.pool, owner).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "manual").await;
    // An earlier failed manual refresh left the account waiting on a
    // reconnect prompt, which has since expired.
    mark_for_reconnect(&state, id, None).await;
    reconnect_prompt(&state, id, Utc::now() - Duration::minutes(1)).await;

    let refreshed = refresh_connection(State(state.clone()), jar.clone(), Path(id))
        .await
        .unwrap()
        .0;
    assert_eq!(refreshed.status, AgentConnectionStatus::Connected);
    assert_eq!(refreshed.availability_status, "active");
    assert!(refreshed.failure_message.is_none());
    assert!(refreshed.authorization.is_none());
    assert_eq!(recorded(&calls), ["manual"]);
    assert_eq!(
        stored_token(&state, id).await["access_token"],
        "manual-access"
    );
    assert!(!has_reconnect_prompt(&state, id).await);

    let polled = get_connection(State(state.clone()), jar, Path(id))
        .await
        .unwrap()
        .0;
    assert_eq!(polled.status, AgentConnectionStatus::Connected);
    assert_eq!(polled.availability_status, "active");
    assert!(polled.failure_message.is_none());
    assert!(polled.authorization.is_none());
    assert_eq!(
        account_state(&state, id).await,
        account("connected", "active", None)
    );
    assert_eq!(recorded(&calls), ["manual"]);
    server.abort();
}

#[sqlx::test]
async fn expired_old_prompt_does_not_demote_a_connected_active_account(pool: PgPool) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let jar = session_jar(&state.pool, owner).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "current").await;
    reconnect_prompt(&state, id, Utc::now() - Duration::minutes(1)).await;

    let polled = get_connection(State(state.clone()), jar, Path(id))
        .await
        .unwrap()
        .0;
    assert_eq!(polled.status, AgentConnectionStatus::Connected);
    assert_eq!(polled.availability_status, "active");
    assert!(polled.failure_message.is_none());
    assert!(polled.authorization.is_none());
    assert_eq!(
        account_state(&state, id).await,
        account("connected", "active", None)
    );
    assert!(!has_reconnect_prompt(&state, id).await);
    assert!(recorded(&calls).is_empty());
    server.abort();
}

#[sqlx::test]
async fn expired_reconnect_prompt_on_a_marked_account_becomes_recoverable_by_the_sweep(
    pool: PgPool,
) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let jar = session_jar(&state.pool, owner).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "abandoned-prompt").await;
    // `start_connection_reauthorization` marks the account without a message
    // and stores a prompt; the owner never finished it.
    mark_for_reconnect(&state, id, None).await;
    reconnect_prompt(&state, id, Utc::now() - Duration::minutes(1)).await;

    let polled = get_connection(State(state.clone()), jar, Path(id))
        .await
        .unwrap()
        .0;
    assert_eq!(polled.availability_status, "reauth_required");
    assert_eq!(
        polled.failure_message.as_deref(),
        Some(EXPIRED_AUTHORIZATION_PROMPT_MESSAGE)
    );
    assert!(!has_reconnect_prompt(&state, id).await);
    assert!(recorded(&calls).is_empty());

    backdate_refresh(&state, id, Duration::minutes(46), None).await;
    let summary = refresh_due_provider_credentials(&state).await.unwrap();
    assert_eq!(counts(&summary), [1, 1, 0, 0]);
    assert_eq!(recorded(&calls), ["abandoned-prompt"]);
    assert_eq!(
        account_state(&state, id).await,
        account("connected", "active", None)
    );
    server.abort();
}

#[sqlx::test]
async fn request_credential_reads_do_not_queue_behind_a_locked_refresh(pool: PgPool) {
    let (issuer, calls, server) = fake_grok_issuer().await;
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "current").await;
    expire_access_token_in(&state, id, Duration::hours(1)).await;

    // A background refresh holds the credential row lock while it waits on
    // its provider.
    let mut background_refresh = state.pool.begin().await.unwrap();
    sqlx::query(
        "SELECT connection_id FROM agent_connection_credentials
         WHERE connection_id = $1 FOR UPDATE",
    )
    .bind(id)
    .fetch_one(&mut *background_refresh)
    .await
    .unwrap();
    let lock_error = sqlx::query(
        "SELECT connection_id FROM agent_connection_credentials
         WHERE connection_id = $1 FOR UPDATE NOWAIT",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap_err();
    assert_eq!(
        lock_error
            .as_database_error()
            .and_then(|error| error.code())
            .as_deref(),
        Some("55P03"),
        "the credential row lock must really be held"
    );

    let lookup = tokio::time::timeout(
        std::time::Duration::from_secs(1),
        gateway_credential(&state, id),
    )
    .await
    .expect("a credential that is not near expiry must be read without the row lock")
    .unwrap();
    let CredentialLookup::Ready(provider, token) = lookup else {
        panic!("the stored credential must be usable");
    };
    assert_eq!(provider, AgentProvider::Grok);
    assert_eq!(token["access_token"], "current-old-access");
    background_refresh.rollback().await.unwrap();
    assert!(recorded(&calls).is_empty());
    server.abort();
}

#[sqlx::test]
async fn cancelled_request_does_not_roll_back_a_rotated_credential(pool: PgPool) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let calls = Arc::new(AtomicUsize::new(0));
    let received = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let app = Router::new().route(
        "/oauth2/token",
        post({
            let (calls, received, release) = (calls.clone(), received.clone(), release.clone());
            move || {
                let (calls, received, release) = (calls.clone(), received.clone(), release.clone());
                async move {
                    calls.fetch_add(1, Ordering::SeqCst);
                    received.notify_one();
                    // The provider now holds the refresh token and would rotate
                    // it, but it only answers after the caller has gone away.
                    release.notified().await;
                    Json(json!({
                        "access_token": "rotated-access",
                        "refresh_token": "rotated-refresh",
                        "expires_in": 3600
                    }))
                }
            }
        }),
    );
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.grok_issuer = issuer;
    let owner = user(&state.pool).await;
    let id = connection(&state, owner, "grok").await.id;
    store_refreshable_credential(&state, id, "near-expiry").await;
    expire_access_token_in(&state, id, Duration::minutes(1)).await;

    let request = tokio::time::timeout(
        std::time::Duration::from_millis(100),
        gateway_credential(&state, id),
    )
    .await;
    assert!(
        request.is_err(),
        "the request must still be waiting on the provider when it is cancelled"
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), received.notified())
        .await
        .expect("the refresh must reach the provider although its caller was cancelled");
    assert_eq!(
        stored_token(&state, id).await["refresh_token"],
        "near-expiry"
    );

    release.notify_one();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(1500);
    let stored = loop {
        let stored = stored_token(&state, id).await;
        if stored["refresh_token"] == "rotated-refresh" {
            break stored;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the detached refresh did not commit the rotated credential"
        );
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    };
    assert_eq!(stored["access_token"], "rotated-access");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let expires_at: Option<DateTime<Utc>> = sqlx::query_scalar(
        "SELECT access_token_expires_at FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert!(expires_at.is_some_and(|expires_at| expires_at > Utc::now() + Duration::minutes(50)));

    // The next request uses the committed rotation without another provider
    // call.
    let CredentialLookup::Ready(provider, token) = gateway_credential(&state, id).await.unwrap()
    else {
        panic!("the rotated credential must be usable");
    };
    assert_eq!(provider, AgentProvider::Grok);
    assert_eq!(token["access_token"], "rotated-access");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    server.abort();
}
