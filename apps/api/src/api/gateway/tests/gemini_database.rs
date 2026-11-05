use std::sync::{Arc, Mutex};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json, Router,
    body::{Bytes, to_bytes},
    extract::State,
    http::{HeaderMap, StatusCode, header},
    routing::post,
};
use rand::RngCore;
use serde_json::{Value, json};
use sqlx::PgPool;
use tokio::net::TcpListener;
use uuid::Uuid;

use crate::{
    api::gateway::{
        providers::gemini::{GeminiOperation, gemini_proxy_request_for_user},
        selection::{GatewaySelection, SERVED_CONNECTION_HEADER, mark_active, mark_rate_limited},
    },
    core::{AppConfig, AppState},
};

#[derive(Clone)]
struct FakeCodeAssist {
    blocked_status: Arc<Mutex<StatusCode>>,
    blocked_message: Arc<Mutex<Option<String>>>,
    generation_tokens: Arc<Mutex<Vec<String>>>,
}

async fn load_code_assist() -> Json<Value> {
    Json(json!({ "cloudaicompanionProject": "test-project" }))
}

async fn available_models(
    State(fake): State<FakeCodeAssist>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let (status, body) = generate(State(fake), headers).await;
    if status != StatusCode::OK {
        return (status, body);
    }
    (
        StatusCode::OK,
        Json(json!({ "models": {
                "gemini-3.8-flash-high": { "displayName": "Gemini 3.8 Flash (High)" }
            } })),
    )
}

async fn generate(
    State(fake): State<FakeCodeAssist>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let authorization = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_owned();
    fake.generation_tokens
        .lock()
        .unwrap()
        .push(authorization.clone());
    if authorization == "Bearer blocked-token" {
        let message = fake.blocked_message.lock().unwrap().clone();
        (
            *fake.blocked_status.lock().unwrap(),
            Json(json!({ "error": {
                    "status": "PERMISSION_DENIED", "message": message
                } })),
        )
    } else {
        (
            StatusCode::OK,
            Json(json!({
                "response": {
                    "candidates": [{
                        "content": { "parts": [{ "text": "healthy pool" }] }
                    }]
                }
            })),
        )
    }
}

async fn add_gemini_connection(
    state: &AppState,
    user_id: Uuid,
    access_token: &str,
    older: bool,
) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status)
             VALUES ($1, $2, 'gemini', 'connected')",
    )
    .bind(id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .unwrap();
    if older {
        sqlx::query(
            "UPDATE agent_connections
                 SET updated_at = NOW() - INTERVAL '1 minute' WHERE id = $1",
        )
        .bind(id)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    let token = json!({
        "access_token": access_token,
        "cloudaicompanion_project": "test-project"
    });
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
    id
}

async fn generation(state: &AppState, selection: GatewaySelection) -> axum::response::Response {
    gemini_proxy_request_for_user(
        state,
        selection,
        "gemini-3.8-flash-high",
        GeminiOperation::Generate,
        Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
    )
    .await
    .unwrap()
}

#[sqlx::test]
async fn blocked_gemini_accounts_fail_over_within_scope_but_invalid_requests_do_not(pool: PgPool) {
    let fake = FakeCodeAssist {
        blocked_status: Arc::new(Mutex::new(StatusCode::FORBIDDEN)),
        blocked_message: Arc::new(Mutex::new(None)),
        generation_tokens: Arc::new(Mutex::new(Vec::new())),
    };
    let server = Router::new()
        .route("/v1internal:loadCodeAssist", post(load_code_assist))
        .route("/v1internal:generateContent", post(generate))
        .route("/v1internal:countTokens", post(generate))
        .route("/v1internal:fetchAvailableModels", post(available_models))
        .with_state(fake.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let upstream_url = format!("http://{}", listener.local_addr().unwrap());
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let mut config = AppConfig::default();
    config.gemini_code_assist_url = upstream_url;
    let state = AppState {
        config,
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    };
    let user_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO users (id, username, password_hash)
             VALUES ($1, $2, 'test-only')",
    )
    .bind(user_id)
    .bind(user_id.simple().to_string())
    .execute(&state.pool)
    .await
    .unwrap();
    let healthy_id = add_gemini_connection(&state, user_id, "healthy-token", true).await;
    let blocked_id = add_gemini_connection(&state, user_id, "blocked-token", false).await;
    let selection = GatewaySelection::from(user_id);

    let response = generation(&state, selection).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1_000_000).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap()["candidates"][0]["content"]["parts"][0]["text"],
        "healthy pool"
    );
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer blocked-token", "Bearer healthy-token"]
    );
    let availability: String =
        sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
            .bind(blocked_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(availability, "active");

    // A browser request tries its chosen account first, then fails over to
    // the rest of its scope and names the account that answered.
    let preferred = GatewaySelection {
        user_id,
        connection_id: Some(blocked_id),
        organization_id: None,
    };
    let response = generation(&state, preferred).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        response.headers()[SERVED_CONNECTION_HEADER],
        healthy_id.to_string().as_str()
    );
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer blocked-token", "Bearer healthy-token"]
    );

    *fake.blocked_status.lock().unwrap() = StatusCode::BAD_REQUEST;
    assert_eq!(
        generation(&state, selection).await.status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer blocked-token"]
    );

    // A 401 first tries to refresh the credential. This fixture stores no
    // refresh token, so the account is marked with the refresh reason and
    // the request continues on the next account.
    *fake.blocked_status.lock().unwrap() = StatusCode::UNAUTHORIZED;
    assert_eq!(generation(&state, selection).await.status(), StatusCode::OK);
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer blocked-token", "Bearer healthy-token"]
    );
    let (availability, failure_message): (String, Option<String>) = sqlx::query_as(
        "SELECT availability_status, failure_message FROM agent_connections WHERE id = $1",
    )
    .bind(blocked_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(availability, "reauth_required");
    assert_eq!(
        failure_message.as_deref(),
        Some("Provider authorization expired. Refresh this pool to reconnect.")
    );

    sqlx::query(
        "UPDATE agent_connections SET availability_status = 'active', updated_at = NOW()
             WHERE id = $1",
    )
    .bind(blocked_id)
    .execute(&state.pool)
    .await
    .unwrap();
    *fake.blocked_status.lock().unwrap() = StatusCode::FORBIDDEN;
    *fake.blocked_message.lock().unwrap() = Some("Verify your account to continue.".to_owned());
    assert_eq!(generation(&state, selection).await.status(), StatusCode::OK);
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer blocked-token", "Bearer healthy-token"]
    );
    let (availability, failure_message): (String, Option<String>) = sqlx::query_as(
        "SELECT availability_status, failure_message FROM agent_connections WHERE id = $1",
    )
    .bind(blocked_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(availability, "reauth_required");
    assert!(failure_message.unwrap().contains("verification"));
    assert_eq!(generation(&state, selection).await.status(), StatusCode::OK);
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer healthy-token"]
    );
    // Another request may already be in flight when the challenge turns
    // this pool red. Its later 200 or 429 must not make it selectable.
    mark_active(&state, blocked_id).await.unwrap();
    mark_rate_limited(&state, blocked_id).await.unwrap();
    let availability: String =
        sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
            .bind(blocked_id)
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(availability, "reauth_required");

    // Personal and organization requests whose chosen account needs to
    // reconnect fail over only within their own scope.
    let org_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Team')")
        .bind(org_id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO organization_memberships (id, org_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, 'owner', 'accepted', NOW())",
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             SELECT $1, id, user_id FROM agent_connections WHERE user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .unwrap();
    for organization_id in [None, Some(org_id)] {
        let preferred = GatewaySelection {
            user_id,
            connection_id: Some(blocked_id),
            organization_id,
        };
        let models =
            crate::api::gateway::providers::gemini::gemini_models_for_user(&state, preferred)
                .await
                .unwrap();
        assert_eq!(models.0["data"][0]["id"], "gemini-3.8-flash-high");
        for operation in [GeminiOperation::Generate, GeminiOperation::CountTokens] {
            let response = gemini_proxy_request_for_user(
                &state,
                preferred,
                "gemini-3.8-flash-high",
                operation,
                Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
            )
            .await
            .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                response.headers()[SERVED_CONNECTION_HEADER],
                healthy_id.to_string().as_str()
            );
        }
    }
    assert_eq!(
        std::mem::take(&mut *fake.generation_tokens.lock().unwrap()),
        ["Bearer healthy-token"; 6],
        "an account waiting for reconnect is never called"
    );

    // Only when every account in the scope needs to reconnect does the
    // request fail, with a message about that scope.
    sqlx::query(
        "UPDATE agent_connections SET availability_status = 'reauth_required' WHERE id = $1",
    )
    .bind(healthy_id)
    .execute(&state.pool)
    .await
    .unwrap();
    for (organization_id, scope) in [
        (None, "available to you"),
        (Some(org_id), "in this organization"),
    ] {
        let preferred = GatewaySelection {
            user_id,
            connection_id: Some(blocked_id),
            organization_id,
        };
        let models =
            crate::api::gateway::providers::gemini::gemini_models_for_user(&state, preferred).await;
        assert!(
            matches!(&models, Err(crate::core::ApiError::Provider(message))
                if message.starts_with("Every account for this provider") && message.contains(scope))
        );
        for operation in [GeminiOperation::Generate, GeminiOperation::CountTokens] {
            let result = gemini_proxy_request_for_user(
                &state,
                preferred,
                "gemini-3.8-flash-high",
                operation,
                Bytes::from_static(br#"{"contents":[{"role":"user","parts":[{"text":"hi"}]}]}"#),
            )
            .await;
            assert!(
                matches!(&result, Err(crate::core::ApiError::Provider(message))
                    if message.starts_with("Every account for this provider") && message.contains(scope))
            );
        }
    }
    assert!(fake.generation_tokens.lock().unwrap().is_empty());
    server_task.abort();
}
