use axum::body::{Body, to_bytes};
use serde_json::Value;
use uuid::Uuid;

use super::{
    GatewaySelection, RejectedCredential, chatgpt_account_id, claim_candidate,
    handle_rejected_credential, mark_active, mark_rate_limited, organization_usage_event,
    record_organization_usage, release_probe, selected_provider_candidates,
};
use crate::{
    AgentProvider, AppState,
    connections::{CredentialLookup, gateway_credential},
    error::ApiError,
};

const CODEX_VOICE_URL: &str =
    "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";

pub(crate) async fn create_voice_session_for_user(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    organization_id: Option<Uuid>,
    body: Value,
) -> Result<String, ApiError> {
    create_session(
        state,
        GatewaySelection {
            user_id,
            connection_id: Some(connection_id),
            organization_id,
        },
        body,
        CODEX_VOICE_URL,
    )
    .await
}

/// Why one account could not start a voice session.
enum VoiceAttempt {
    Started(String),
    RateLimited,
    ReauthorizationRequired,
    /// The provider refused this account before creating a session; another
    /// account in the scope may still start the call.
    NextAccount(ApiError),
}

async fn create_session(
    state: &AppState,
    selection: GatewaySelection,
    body: Value,
    url: &str,
) -> Result<String, ApiError> {
    let candidates = selected_provider_candidates(state, selection, AgentProvider::Chatgpt).await?;
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;

    for candidate in candidates {
        let Some(claimed) = claim_candidate(state, &candidate).await? else {
            if candidate.availability_status == "reauth_required" {
                saw_reauthorization = true;
            } else {
                saw_rate_limit = true;
            }
            continue;
        };
        // Session creation is non-idempotent. A lost or unreadable answer may
        // already have created a session, so it is never replayed; only an
        // explicit refusal moves to the next account.
        let attempt = start_session(state, selection, candidate.id, &body, url).await;
        if claimed {
            release_probe(state, candidate.id).await?;
        }
        match attempt? {
            VoiceAttempt::Started(sdp) => return Ok(sdp),
            VoiceAttempt::RateLimited => saw_rate_limit = true,
            VoiceAttempt::ReauthorizationRequired => saw_reauthorization = true,
            VoiceAttempt::NextAccount(error) => last_error = Some(error),
        }
    }

    if saw_rate_limit {
        Err(ApiError::RateLimited)
    } else if saw_reauthorization {
        Err(ApiError::Provider(
            "Reconnect this account before starting a voice call.".into(),
        ))
    } else {
        Err(last_error.unwrap_or(ApiError::Forbidden))
    }
}

async fn start_session(
    state: &AppState,
    selection: GatewaySelection,
    connection_id: Uuid,
    body: &Value,
    url: &str,
) -> Result<VoiceAttempt, ApiError> {
    // Nothing has been sent for this account yet, so a credential problem
    // moves on to the next account instead of ending the call.
    let mut token = match gateway_credential(state, connection_id).await {
        Ok(CredentialLookup::Ready(AgentProvider::Chatgpt, token)) => token,
        Ok(CredentialLookup::Ready(..)) => {
            return Ok(VoiceAttempt::NextAccount(ApiError::Forbidden));
        }
        Ok(CredentialLookup::ReauthorizationRequired) => {
            return Ok(VoiceAttempt::ReauthorizationRequired);
        }
        Err(error) => return Ok(VoiceAttempt::NextAccount(error)),
    };
    let mut credential_retried = false;
    loop {
        let Some(access_token) = token
            .get("access_token")
            .and_then(Value::as_str)
            .map(str::to_owned)
        else {
            return Ok(VoiceAttempt::NextAccount(ApiError::Forbidden));
        };
        let mut request = state
            .gateway_http
            .post(url)
            .timeout(std::time::Duration::from_secs(35))
            .bearer_auth(&access_token)
            .header("openai-alpha", "quicksilver=v2")
            .header("x-session-id", Uuid::new_v4().to_string())
            .header("originator", "codex_cli_rs")
            .header(
                "user-agent",
                format!("codex_cli_rs/{}", state.config.codex_client_version),
            )
            .json(body);
        if let Some(account_id) = chatgpt_account_id(&token) {
            request = request.header("chatgpt-account-id", account_id);
        }
        let upstream = request.send().await.map_err(|_| {
            ApiError::Provider(
                "The voice service could not be reached. Start a new call to retry.".into(),
            )
        })?;
        let status = upstream.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            mark_rate_limited(state, connection_id).await?;
            return Ok(VoiceAttempt::RateLimited);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            // A 401 creates no session, so one retry with a refreshed token is safe.
            match handle_rejected_credential(
                state,
                connection_id,
                AgentProvider::Chatgpt,
                &access_token,
                credential_retried,
            )
            .await?
            {
                RejectedCredential::Retry(refreshed) => {
                    credential_retried = true;
                    token = refreshed;
                    continue;
                }
                RejectedCredential::ReauthorizationRequired => {
                    return Ok(VoiceAttempt::ReauthorizationRequired);
                }
                RejectedCredential::NextAccount(error) => {
                    return Ok(VoiceAttempt::NextAccount(error));
                }
            }
        }
        if !status.is_success() {
            return Ok(VoiceAttempt::NextAccount(ApiError::Provider(format!(
                "This account could not start a voice call (provider HTTP {}).",
                status.as_u16()
            ))));
        }
        let bytes = to_bytes(Body::from_stream(upstream.bytes_stream()), 128 * 1024)
            .await
            .map_err(|_| {
                ApiError::Provider("The voice service returned an unreadable session.".into())
            })?;
        let sdp = String::from_utf8(bytes.to_vec()).map_err(|_| {
            ApiError::Provider("The voice service returned an invalid session.".into())
        })?;
        if !sdp.starts_with("v=0") || !sdp.lines().any(|line| line.starts_with("m=audio ")) {
            return Err(ApiError::Provider(
                "The voice service did not create an audio session.".into(),
            ));
        }
        mark_active(state, connection_id).await?;
        // Media and provider usage events go directly to the browser over
        // WebRTC. Count a successful session setup; token counts remain unknown.
        if let Some(event) = organization_usage_event(
            state,
            selection,
            connection_id,
            AgentProvider::Chatgpt,
            body["session"]["model"].as_str(),
        ) {
            record_organization_usage(&event, None)
                .await
                .map_err(|_| ApiError::Internal)?;
        }
        return Ok(VoiceAttempt::Started(sdp));
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod tests {
    use super::*;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use axum::{
        Json, Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use serde_json::json;
    use sqlx::PgPool;
    use std::{
        collections::HashMap,
        sync::{Arc, Mutex},
    };

    #[sqlx::test]
    async fn voice_fails_over_on_refusals_preserves_cooldown_and_never_replays_setup(pool: PgPool) {
        let state = AppState {
            config: crate::AppConfig::default(),
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool,
        };
        let owner = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        for id in [owner, outsider] {
            sqlx::query(
                "INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')",
            )
            .bind(id)
            .bind(id.simple().to_string())
            .execute(&state.pool)
            .await
            .unwrap();
        }
        let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
        let selected = Uuid::new_v4();
        let other = Uuid::new_v4();
        for (id, token) in [
            (selected, "selected-voice-token"),
            (other, "other-voice-token"),
        ] {
            sqlx::query("INSERT INTO agent_connections (id,user_id,provider,status) VALUES ($1,$2,'chatgpt','connected')")
                .bind(id).bind(owner).execute(&state.pool).await.unwrap();
            let nonce = [5_u8; 12];
            let payload = json!({"access_token":token}).to_string();
            let ciphertext = cipher
                .encrypt(Nonce::from_slice(&nonce), payload.as_bytes())
                .unwrap();
            sqlx::query("INSERT INTO agent_connection_credentials (connection_id,credential_ciphertext,credential_nonce,access_token_expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '1 day')")
                .bind(id).bind(ciphertext).bind(nonce.to_vec()).execute(&state.pool).await.unwrap();
        }
        // Each token answers with its own status; "garbled" returns an
        // unreadable 201 so we can prove an ambiguous answer is not replayed.
        let statuses: Arc<Mutex<HashMap<String, u16>>> = Arc::new(Mutex::new(HashMap::from([
            ("Bearer selected-voice-token".to_owned(), 201),
            ("Bearer other-voice-token".to_owned(), 201),
        ])));
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let returned = statuses.clone();
        let server = Router::new().route(
            "/voice",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let seen = seen.clone();
                let returned = returned.clone();
                async move {
                    let authorization = headers["authorization"].to_str().unwrap().to_owned();
                    seen.lock().unwrap().push(authorization.clone());
                    assert_eq!(headers["openai-alpha"], "quicksilver=v2");
                    assert!(headers.contains_key("x-session-id"));
                    assert!(!headers.contains_key("cookie"));
                    assert!(!headers.contains_key("origin"));
                    assert_eq!(body["session"]["model"], "gpt-live-1-codex");
                    let status = returned.lock().unwrap()[&authorization];
                    if status == 299 {
                        return (StatusCode::CREATED, "not a session");
                    }
                    (
                        StatusCode::from_u16(status).unwrap(),
                        "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/voice", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let selection = GatewaySelection {
            user_id: owner,
            connection_id: Some(selected),
            organization_id: None,
        };
        let set = |token: &str, status: u16| {
            statuses
                .lock()
                .unwrap()
                .insert(format!("Bearer {token}"), status);
        };
        let take = || std::mem::take(&mut *calls.lock().unwrap());
        let body = json!({"sdp":"v=0\r\nm=audio 9 RTP/SAVPF 111\r\n", "session":{"model":"gpt-live-1-codex"}});

        // An account outside the caller's scope is never used.
        assert!(matches!(
            create_session(
                &state,
                GatewaySelection {
                    user_id: outsider,
                    ..selection
                },
                body.clone(),
                &url
            )
            .await,
            Err(ApiError::Forbidden)
        ));
        assert!(take().is_empty());

        // The chosen account starts the call.
        assert!(
            create_session(&state, selection, body.clone(), &url)
                .await
                .unwrap()
                .starts_with("v=0")
        );
        assert_eq!(take(), ["Bearer selected-voice-token"]);

        // An explicit refusal before a session exists moves to the next account.
        set("selected-voice-token", 503);
        assert!(
            create_session(&state, selection, body.clone(), &url)
                .await
                .is_ok()
        );
        assert_eq!(
            take(),
            ["Bearer selected-voice-token", "Bearer other-voice-token"]
        );

        // An unreadable answer may already have created a session: never replay it.
        set("selected-voice-token", 299);
        assert!(matches!(
            create_session(&state, selection, body.clone(), &url).await,
            Err(ApiError::Provider(_))
        ));
        assert_eq!(take(), ["Bearer selected-voice-token"]);

        // A rate limit cools the chosen account and the call starts elsewhere;
        // later calls skip the cooling account without calling it.
        set("selected-voice-token", 429);
        assert!(
            create_session(&state, selection, body.clone(), &url)
                .await
                .is_ok()
        );
        assert_eq!(
            take(),
            ["Bearer selected-voice-token", "Bearer other-voice-token"]
        );
        assert!(
            create_session(&state, selection, body.clone(), &url)
                .await
                .is_ok()
        );
        assert_eq!(take(), ["Bearer other-voice-token"]);

        // Only when every account refuses does the call fail.
        set("other-voice-token", 429);
        assert!(matches!(
            create_session(&state, selection, body, &url).await,
            Err(ApiError::RateLimited)
        ));
        assert_eq!(take(), ["Bearer other-voice-token"]);
        task.abort();
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod credential_failover_tests {
    use super::*;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use axum::{
        Router,
        http::{HeaderMap, StatusCode},
        routing::post,
    };
    use serde_json::json;
    use sqlx::PgPool;
    use std::sync::{Arc, Mutex};

    #[sqlx::test]
    async fn voice_moves_on_when_the_preferred_account_cannot_refresh_its_credential(pool: PgPool) {
        let calls: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let token_calls = Arc::new(Mutex::new(0_usize));
        let token_seen = token_calls.clone();
        let server = Router::new()
            .route(
                "/oauth/token",
                post(move || {
                    let token_seen = token_seen.clone();
                    async move {
                        *token_seen.lock().unwrap() += 1;
                        // The provider's token endpoint is briefly unavailable.
                        (StatusCode::SERVICE_UNAVAILABLE, "try later")
                    }
                }),
            )
            .route(
                "/voice",
                post(move |headers: HeaderMap| {
                    let seen = seen.clone();
                    async move {
                        seen.lock()
                            .unwrap()
                            .push(headers["authorization"].to_str().unwrap().to_owned());
                        (
                            StatusCode::CREATED,
                            "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
                        )
                    }
                }),
            );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            axum::serve(listener, server).await.unwrap();
        });
        let state = AppState {
            config: crate::AppConfig {
                codex_issuer: base.clone(),
                ..crate::AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool,
        };
        let owner = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(owner)
            .bind(owner.simple().to_string())
            .execute(&state.pool)
            .await
            .unwrap();
        let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
        let expiring = Uuid::new_v4();
        let healthy = Uuid::new_v4();
        // The preferred account's token expires within the refresh window, so
        // the request must refresh it first; the other account is current.
        for (id, token, expires_in) in [
            (expiring, "expiring-voice-token", "1 minute"),
            (healthy, "healthy-voice-token", "1 day"),
        ] {
            sqlx::query("INSERT INTO agent_connections (id,user_id,provider,status) VALUES ($1,$2,'chatgpt','connected')")
                .bind(id).bind(owner).execute(&state.pool).await.unwrap();
            let nonce = [7_u8; 12];
            let payload =
                json!({"access_token": token, "refresh_token": "voice-refresh"}).to_string();
            let ciphertext = cipher
                .encrypt(Nonce::from_slice(&nonce), payload.as_bytes())
                .unwrap();
            sqlx::query(&format!("INSERT INTO agent_connection_credentials (connection_id,credential_ciphertext,credential_nonce,access_token_expires_at) VALUES ($1,$2,$3,NOW()+INTERVAL '{expires_in}')"))
                .bind(id).bind(ciphertext).bind(nonce.to_vec()).execute(&state.pool).await.unwrap();
        }
        let selection = GatewaySelection {
            user_id: owner,
            connection_id: Some(expiring),
            organization_id: None,
        };
        let body = json!({"sdp":"v=0\r\nm=audio 9 RTP/SAVPF 111\r\n", "session":{"model":"gpt-live-1-codex"}});

        let sdp = create_session(&state, selection, body, &format!("{base}/voice"))
            .await
            .expect("another account in scope starts the call");
        assert!(sdp.starts_with("v=0"));
        assert_eq!(*token_calls.lock().unwrap(), 1);
        assert_eq!(
            *calls.lock().unwrap(),
            ["Bearer healthy-voice-token"],
            "no session request was made with the account that could not refresh"
        );
        let status: String =
            sqlx::query_scalar("SELECT availability_status FROM agent_connections WHERE id = $1")
                .bind(expiring)
                .fetch_one(&state.pool)
                .await
                .unwrap();
        assert_eq!(
            status, "active",
            "a transient refresh failure is not a reconnect"
        );
        task.abort();
    }
}
