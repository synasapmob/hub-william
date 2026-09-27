use axum::body::{Body, to_bytes};
use serde_json::Value;
use uuid::Uuid;

use super::{
    GatewaySelection, chatgpt_account_id, claim_candidate, mark_active, mark_rate_limited,
    mark_reauth_required, organization_usage_event, provider_credential, record_organization_usage,
    release_probe, selected_provider_candidates,
};
use crate::{AgentProvider, AppState, error::ApiError};

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

async fn create_session(
    state: &AppState,
    selection: GatewaySelection,
    body: Value,
    url: &str,
) -> Result<String, ApiError> {
    let candidate = selected_provider_candidates(state, selection, AgentProvider::Chatgpt)
        .await?
        .pop()
        .ok_or(ApiError::Forbidden)?;
    let claimed = claim_candidate(state, &candidate).await?.ok_or_else(|| {
        if candidate.availability_status == "reauth_required" {
            ApiError::Provider("Reconnect this account before starting a voice call.".into())
        } else {
            ApiError::RateLimited
        }
    })?;

    // Session creation is non-idempotent. Do not replay a lost SDP answer or
    // fall back to another account. The user can deliberately start a new call.
    let result = async {
        let (provider, token) = provider_credential(state, candidate.id).await?;
        if provider != AgentProvider::Chatgpt {
            return Err(ApiError::Forbidden);
        }
        let access_token = token
            .get("access_token")
            .and_then(Value::as_str)
            .ok_or(ApiError::Forbidden)?;
        let mut request = state
            .gateway_http
            .post(url)
            .timeout(std::time::Duration::from_secs(35))
            .bearer_auth(access_token)
            .header("openai-alpha", "quicksilver=v2")
            .header("x-session-id", Uuid::new_v4().to_string())
            .header("originator", "codex_cli_rs")
            .header(
                "user-agent",
                format!("codex_cli_rs/{}", state.config.codex_client_version),
            )
            .json(&body);
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
            mark_rate_limited(state, candidate.id).await?;
            return Err(ApiError::RateLimited);
        }
        if status == reqwest::StatusCode::UNAUTHORIZED {
            mark_reauth_required(state, candidate.id).await?;
            return Err(ApiError::Provider(
                "Reconnect this account before starting a voice call.".into(),
            ));
        }
        if !status.is_success() {
            return Err(ApiError::Provider(format!(
                "This account could not start a voice call (provider HTTP {}).",
                status.as_u16()
            )));
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
        mark_active(state, candidate.id).await?;
        // Media and provider usage events go directly to the browser over
        // WebRTC. Count a successful session setup; token counts remain unknown.
        if let Some(event) = organization_usage_event(
            state,
            selection,
            candidate.id,
            AgentProvider::Chatgpt,
            body["session"]["model"].as_str(),
        ) {
            record_organization_usage(&event, None)
                .await
                .map_err(|_| ApiError::Internal)?;
        }
        Ok(sdp)
    }
    .await;

    if claimed {
        release_probe(state, candidate.id).await?;
    }
    result
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
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };

    #[sqlx::test]
    async fn voice_pins_authorized_account_preserves_cooldown_and_never_replays_setup(
        pool: PgPool,
    ) {
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
            (other, "never-use-this-token"),
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
        let calls = Arc::new(AtomicUsize::new(0));
        let seen = calls.clone();
        let status = Arc::new(AtomicUsize::new(201));
        let returned_status = status.clone();
        let server = Router::new().route(
            "/voice",
            post(move |headers: HeaderMap, Json(body): Json<Value>| {
                let seen = seen.clone();
                let status = returned_status.clone();
                async move {
                    seen.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(headers["authorization"], "Bearer selected-voice-token");
                    assert_eq!(headers["openai-alpha"], "quicksilver=v2");
                    assert!(headers.contains_key("x-session-id"));
                    assert!(!headers.contains_key("cookie"));
                    assert!(!headers.contains_key("origin"));
                    assert_eq!(body["session"]["model"], "gpt-live-1-codex");
                    (
                        StatusCode::from_u16(status.load(Ordering::SeqCst) as u16).unwrap(),
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
        let body = json!({"sdp":"v=0\r\nm=audio 9 RTP/SAVPF 111\r\n", "session":{"model":"gpt-live-1-codex"}});
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
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(
            create_session(&state, selection, body.clone(), &url)
                .await
                .unwrap()
                .starts_with("v=0")
        );
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        status.store(503, Ordering::SeqCst);
        assert!(matches!(
            create_session(&state, selection, body.clone(), &url).await,
            Err(ApiError::Provider(_))
        ));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            2,
            "session creation must not replay or fail over"
        );
        status.store(429, Ordering::SeqCst);
        assert!(matches!(
            create_session(&state, selection, body.clone(), &url).await,
            Err(ApiError::RateLimited)
        ));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(matches!(
            create_session(&state, selection, body, &url).await,
            Err(ApiError::RateLimited)
        ));
        assert_eq!(
            calls.load(Ordering::SeqCst),
            3,
            "cooling account must not be called again"
        );
        task.abort();
    }
}
