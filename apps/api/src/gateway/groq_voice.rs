use axum::{
    Json,
    body::{Body, to_bytes},
    response::{IntoResponse, Response, Sse, sse::Event},
};
use futures_util::StreamExt;
use std::convert::Infallible;
use tokio::sync::{Notify, mpsc};
use tokio_stream::wrappers::ReceiverStream;

#[path = "groq_voice_stream.rs"]
mod stream;
use base64::{Engine, engine::general_purpose::STANDARD};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};
use uuid::Uuid;

use super::{
    GatewaySelection, ProviderCandidate, TokenUsage, claim_candidate, mark_active,
    mark_rate_limited, nonnegative_i64, organization_usage_event, provider_credential,
    record_organization_usage, release_probe, selected_provider_candidates,
};
use crate::{
    AgentProvider, AppState,
    connections::{CredentialLookup, recover_rejected_credential},
    error::ApiError,
    playground_groq_voice::{
        GROQ_CHAT_MODEL, GROQ_TTS_MODEL, GroqVoiceTurnRequest, GroqVoiceTurnResponse,
    },
};

static TURN_RELEASED: Notify = Notify::const_new();
static IN_FLIGHT: OnceLock<Mutex<HashSet<Uuid>>> = OnceLock::new();
struct TurnPermit(Uuid);
impl TurnPermit {
    async fn wait(id: Uuid) -> Result<Self, ApiError> {
        // Allow a canceled stream's bounded probe cleanup to finish before the next turn.
        tokio::time::timeout(std::time::Duration::from_secs(4), async {
            loop {
                let notified = TURN_RELEASED.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                match Self::acquire(id) {
                    Ok(permit) => return Ok(permit),
                    Err(ApiError::Provider(_)) => notified.await,
                    Err(error) => return Err(error),
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            Err(ApiError::Provider(
                "This Groq account is answering another call. Try again shortly.".into(),
            ))
        })
    }
    fn acquire(id: Uuid) -> Result<Self, ApiError> {
        let mut active = IN_FLIGHT
            .get_or_init(Default::default)
            .lock()
            .map_err(|_| ApiError::Internal)?;
        if !active.insert(id) {
            return Err(ApiError::Provider(
                "This Groq account is answering another call. Try again shortly.".into(),
            ));
        }
        Ok(Self(id))
    }
}
impl Drop for TurnPermit {
    fn drop(&mut self) {
        if let Ok(mut active) = IN_FLIGHT.get_or_init(Default::default).lock() {
            active.remove(&self.0);
            TURN_RELEASED.notify_waiters();
        }
    }
}

pub(crate) async fn groq_voice_turn_for_user(
    state: &AppState,
    user_id: Uuid,
    request: GroqVoiceTurnRequest,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        user_id,
        connection_id: Some(request.connection_id),
        organization_id: request.organization_id,
    };
    // Start the turn on the chosen account, or on the next usable Groq account
    // in the same scope when it is cooling down, needs reconnect or is busy. A
    // turn that has started is never replayed on another account.
    let mut saw_rate_limit = false;
    let mut saw_reauthorization = false;
    let mut last_error = None;
    let mut started = None;
    for listed in selected_provider_candidates(state, selection, AgentProvider::Groq).await? {
        if !candidate_may_be_claimed(&listed) {
            if listed.availability_status == "reauth_required" {
                saw_reauthorization = true;
            } else {
                saw_rate_limit = true;
            }
            continue;
        }
        let permit = match TurnPermit::wait(listed.id).await {
            Ok(permit) => permit,
            Err(error) => {
                last_error = Some(error);
                continue;
            }
        };
        // Another turn may have cooled down or revoked the account while we waited.
        let Some(candidate) = selected_provider_candidates(state, selection, AgentProvider::Groq)
            .await?
            .into_iter()
            .find(|candidate| candidate.id == listed.id)
        else {
            continue;
        };
        match claim_candidate(state, &candidate).await? {
            Some(claimed) => {
                started = Some((candidate, claimed, permit));
                break;
            }
            None if candidate.availability_status == "reauth_required" => {
                saw_reauthorization = true;
            }
            None => saw_rate_limit = true,
        }
    }
    let Some((candidate, claimed, permit)) = started else {
        return Err(if saw_rate_limit {
            ApiError::RateLimited
        } else if saw_reauthorization {
            ApiError::Provider("Reconnect this Groq account before calling.".into())
        } else {
            last_error.unwrap_or(ApiError::Forbidden)
        });
    };
    let streaming = request.stream;
    let early_audio = streaming && request.stream_audio;
    let (tx, mut rx) = mpsc::channel::<Result<Value, ApiError>>(4);
    let state = state.clone();
    tokio::spawn(async move {
        let state = &state;
        // A turn is pinned to the chosen account and never automatically replayed.
        let work = async {
            let (provider, token) = provider_credential(state, candidate.id).await?;
            if provider != AgentProvider::Groq {
                return Err(ApiError::Forbidden);
            }
            let key = token
                .get("access_token")
                .and_then(Value::as_str)
                .ok_or(ApiError::Forbidden)?;
            let base = &state.config.groq_api_url;
            let transcript = request.transcript.trim();
            emit(&tx, json!({"type":"transcript", "text":transcript})).await?;
            let mut messages = vec![
                json!({"role":"system", "content":"You are a friendly English conversation tutor in Hub William. Respond in spoken English, preferably one or two sentences under 200 characters. Help the user practise English. You have no camera access or tools. Do not include markdown, stage directions or audio tags."}),
            ];
            messages.extend(
                request
                    .messages
                    .iter()
                    .map(|m| json!({"role":m.role, "content":m.content})),
            );
            messages.push(json!({"role":"user", "content":transcript}));
            let request = state.gateway_http.post(format!("{base}/chat/completions"))
            .bearer_auth(key).json(&json!({"model":GROQ_CHAT_MODEL, "messages":messages, "max_completion_tokens":1024, "reasoning_effort":"low", "include_reasoning":false, "stream":streaming}));
            let completion: Value = if streaming {
                let response = checked_request(state, candidate.id, key, request, "reply").await?;
                if early_audio {
                    let (sentences, mut queue) = mpsc::channel::<String>(8);
                    let speech = async {
                        let mut audio_bytes = 0;
                        while let Some(text) = queue.recv().await {
                            speak(state, candidate.id, key, &text, &tx, &mut audio_bytes).await?;
                        }
                        Ok::<_, ApiError>(())
                    };
                    // Both futures are owned here: error/disconnect drops the entire pipeline.
                    tokio::try_join!(stream::completion(response, &tx, Some(sentences)), speech)?.0
                } else {
                    stream::completion(response, &tx, None).await?
                }
            } else {
                let bytes =
                    checked_response(state, candidate.id, key, request, "reply", 128 * 1024)
                        .await?;
                serde_json::from_slice(&bytes).map_err(|_| invalid_response())?
            };
            let reply = completion
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= 1600)
                .ok_or_else(invalid_response)?
                .trim()
                .to_owned();
            if !streaming {
                emit(&tx, json!({"type":"delta", "text":reply})).await?;
            }
            if !early_audio {
                let mut audio_bytes = 0;
                for chunk in speech_chunks(&reply) {
                    speak(state, candidate.id, key, &chunk, &tx, &mut audio_bytes).await?;
                }
            }
            let usage = completion.get("usage").map(|u| TokenUsage {
                input_tokens: nonnegative_i64(u.get("prompt_tokens")),
                output_tokens: nonnegative_i64(u.get("completion_tokens")),
                cached_tokens: None,
            });
            Ok(usage)
        };
        let result = tokio::select! {
            biased;
            _ = tx.closed() => None,
            result = tokio::time::timeout(std::time::Duration::from_secs(90), work) => Some(result.unwrap_or_else(|_| Err(ApiError::Provider("Groq Call timed out. Start a new call to retry.".into())))),
        };
        // Cancellation drops the upstream future, then always releases the account probe.
        let result = match result {
            Some(result) => result,
            None => Err(ApiError::Internal),
        };
        let result = match result {
            Ok(usage) => {
                // Usage gets its own budget: status maintenance must not consume
                // the time reserved for recording a completed organization turn.
                if let Some(event) = organization_usage_event(
                    state,
                    selection,
                    candidate.id,
                    AgentProvider::Groq,
                    Some(GROQ_CHAT_MODEL),
                ) && !matches!(
                    tokio::time::timeout(
                        std::time::Duration::from_secs(15),
                        record_organization_usage(&event, usage),
                    )
                    .await,
                    Ok(Ok(()))
                ) {
                    // Never replay an ambiguous insert: it may have committed.
                    eprintln!(
                        "Groq voice completed; organization usage recording failed or timed out"
                    );
                }
                if candidate.availability_status != "active"
                    && !matches!(
                        tokio::time::timeout(
                            std::time::Duration::from_secs(3),
                            mark_active(state, candidate.id),
                        )
                        .await,
                        Ok(Ok(()))
                    )
                {
                    eprintln!(
                        "Groq voice completed; account availability update failed or timed out"
                    );
                }
                Ok(())
            }
            Err(error) => Err(error),
        };
        if claimed
            && !matches!(
                tokio::time::timeout(
                    std::time::Duration::from_secs(3),
                    release_probe(state, candidate.id)
                )
                .await,
                Ok(Ok(()))
            )
        {
            eprintln!("Groq voice probe cleanup failed");
        }
        drop(permit);
        if !tx.is_closed() {
            let terminal = result.map(|_| json!({"type":"done"}));
            let _ = tx.send(terminal).await;
        }
    });
    if streaming {
        let events = ReceiverStream::new(rx).map(|item| {
            let value = item.unwrap_or_else(|error| json!({"type":"error", "message": match error {
                ApiError::Provider(message) => message,
                ApiError::RateLimited => "Groq's rate limit was reached. Try again after the account cooldown.".into(),
                _ => "Groq could not complete this turn. Start a new call to retry.".into(),
            }}));
            Ok::<_, Infallible>(Event::default().data(value.to_string()))
        });
        return Ok(Sse::new(events)
            .keep_alive(axum::response::sse::KeepAlive::default())
            .into_response());
    }
    // Preserve JSON for clients loaded before the streaming deployment.
    let mut response = GroqVoiceTurnResponse {
        transcript: String::new(),
        reply: String::new(),
        audio: Vec::new(),
    };
    while let Some(event) = rx.recv().await {
        let event = event?;
        match event["type"].as_str() {
            Some("transcript") => {
                response.transcript = event["text"].as_str().unwrap_or_default().into()
            }
            Some("delta") => response
                .reply
                .push_str(event["text"].as_str().unwrap_or_default()),
            Some("audio") => response
                .audio
                .push(event["audio"].as_str().unwrap_or_default().into()),
            Some("done") => return Ok(Json(response).into_response()),
            _ => {}
        }
    }
    Err(invalid_response())
}

async fn speak(
    state: &AppState,
    connection_id: Uuid,
    key: &str,
    text: &str,
    tx: &mpsc::Sender<Result<Value, ApiError>>,
    audio_bytes: &mut usize,
) -> Result<(), ApiError> {
    let wav = checked_response(state, connection_id, key, state.gateway_http.post(format!("{}/audio/speech", state.config.groq_api_url))
        .bearer_auth(key).json(&json!({"model":GROQ_TTS_MODEL, "voice":"hannah", "input":text, "response_format":"wav"})),
        "speech", 2 * 1024 * 1024).await?;
    if !wav.starts_with(b"RIFF") || wav.get(8..12) != Some(b"WAVE") {
        return Err(invalid_response());
    }
    *audio_bytes += wav.len();
    if *audio_bytes > 4 * 1024 * 1024 {
        return Err(invalid_response());
    }
    emit(tx, json!({"type":"audio", "audio":STANDARD.encode(wav)})).await
}

async fn emit(tx: &mpsc::Sender<Result<Value, ApiError>>, event: Value) -> Result<(), ApiError> {
    tx.send(Ok(event)).await.map_err(|_| ApiError::Internal)
}

/// Whether `claim_candidate` could hand this account to a new turn, checked
/// before waiting for its turn permit.
fn candidate_may_be_claimed(candidate: &ProviderCandidate) -> bool {
    match candidate.availability_status.as_str() {
        "reauth_required" => false,
        "rate_limited" => candidate
            .rate_limited_until
            .is_some_and(|until| until <= chrono::Utc::now()),
        _ => true,
    }
}

fn invalid_response() -> ApiError {
    ApiError::Provider("Groq returned an invalid voice response. Start a new call to retry.".into())
}

async fn checked_response(
    state: &AppState,
    connection_id: Uuid,
    key: &str,
    request: reqwest::RequestBuilder,
    stage: &str,
    limit: usize,
) -> Result<Vec<u8>, ApiError> {
    let response = checked_request(state, connection_id, key, request, stage).await?;
    to_bytes(Body::from_stream(response.bytes_stream()), limit)
        .await
        .map(|b| b.to_vec())
        .map_err(|_| invalid_response())
}

async fn checked_request(
    state: &AppState,
    connection_id: Uuid,
    key: &str,
    request: reqwest::RequestBuilder,
    stage: &str,
) -> Result<reqwest::Response, ApiError> {
    let response = request
        .timeout(std::time::Duration::from_secs(45))
        .send()
        .await
        .map_err(|_| {
            ApiError::Provider(format!(
                "Groq {stage} could not be reached. Start a new call to retry."
            ))
        })?;
    match response.status() {
        reqwest::StatusCode::TOO_MANY_REQUESTS => {
            mark_rate_limited(state, connection_id).await?;
            return Err(ApiError::RateLimited);
        }
        reqwest::StatusCode::UNAUTHORIZED => {
            // Revalidate the key before marking: one rejected call is not proof
            // the key is dead, and a mark would block this account everywhere.
            // A turn in progress is never replayed, so this call still fails.
            return Err(
                match recover_rejected_credential(state, connection_id, key).await {
                    Ok(CredentialLookup::ReauthorizationRequired) => ApiError::Provider(
                        "Reconnect this Groq account with a valid API key.".into(),
                    ),
                    Ok(CredentialLookup::Ready(..)) | Err(_) => ApiError::Provider(format!(
                        "Groq rejected this {stage} request. Start a new call to retry."
                    )),
                },
            );
        }
        status if !status.is_success() => {
            let body = to_bytes(Body::from_stream(response.bytes_stream()), 64 * 1024)
                .await
                .unwrap_or_default();
            return Err(upstream_error(stage, status, &body));
        }
        _ => {}
    }
    Ok(response)
}

fn upstream_error(stage: &str, status: reqwest::StatusCode, body: &[u8]) -> ApiError {
    let payload: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    let code = payload.pointer("/error/code").and_then(Value::as_str);
    let message = payload
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_ascii_lowercase();
    // Classify known errors without exposing arbitrary upstream text, which
    // can include request content or failed generations.
    let requires_terms = code == Some("model_terms_required")
        || (message.contains("terms") && (message.contains("accept") || message.contains("agree")));
    let explanation = if stage == "speech" && requires_terms {
        "Groq requires your organization admin to accept the Orpheus model terms in Groq Console before using speech.".to_owned()
    } else {
        match code {
            Some("model_not_found" | "model_permission_denied") => format!(
                "Groq {stage} model is unavailable for this account. Check model permissions in Groq Console."
            ),
            Some("text_too_long") if stage == "speech" => {
                "Groq rejected the speech text length. Try a shorter reply.".to_owned()
            }
            Some("invalid_voice") if stage == "speech" => {
                "Groq rejected the configured speech voice.".to_owned()
            }
            _ => format!(
                "Groq {stage} rejected the request (HTTP {}). Check the model settings in Groq Console.",
                status.as_u16()
            ),
        }
    };
    ApiError::Provider(explanation)
}

fn speech_chunks(text: &str) -> Vec<String> {
    let mut rest = text.trim();
    let mut chunks = Vec::new();
    while !rest.is_empty() {
        let boundary = rest.char_indices().nth(200).map_or(rest.len(), |(i, _)| i);
        let end = if boundary < rest.len() {
            rest[..boundary]
                .rfind(char::is_whitespace)
                .filter(|i| *i > boundary / 2)
                .unwrap_or(boundary)
        } else {
            boundary
        };
        chunks.push(rest[..end].trim().to_owned());
        rest = rest[end..].trim_start();
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn speech_errors_explain_terms_without_exposing_upstream_content() {
        for error in [
            json!({"code":"model_terms_required", "message":"private details"}),
            json!({"message":"This model requires terms acceptance. Please have your org admin accept the terms."}),
        ] {
            let ApiError::Provider(message) = upstream_error(
                "speech",
                reqwest::StatusCode::BAD_REQUEST,
                &serde_json::to_vec(&json!({"error":error})).unwrap(),
            ) else {
                panic!("expected provider error");
            };
            assert!(message.contains("accept the Orpheus model terms"));
            assert!(!message.contains("private details"));
        }
        let ApiError::Provider(message) = upstream_error(
            "speech",
            reqwest::StatusCode::BAD_REQUEST,
            br#"{"error":{"code":"unexpected","message":"private speech gsk_secret","failed_generation":"private reply"}}"#,
        ) else {
            panic!("expected provider error");
        };
        assert!(message.contains("HTTP 400"));
        assert!(!message.contains("private"));
        assert!(!message.contains("gsk_"));
        assert!(!message.contains("terms"));
    }

    #[test]
    fn turn_permit_rejects_overlapping_account_work_and_releases_on_drop() {
        let account = Uuid::new_v4();
        let first = TurnPermit::acquire(account).unwrap();
        assert!(TurnPermit::acquire(account).is_err());
        assert!(TurnPermit::acquire(Uuid::new_v4()).is_ok());
        drop(first);
        assert!(TurnPermit::acquire(account).is_ok());
    }

    #[tokio::test]
    async fn replacement_waits_for_old_turn_cleanup_without_replaying_upstream_work() {
        let account = Uuid::new_v4();
        let old = TurnPermit::acquire(account).unwrap();
        let replacement = tokio::spawn(TurnPermit::wait(account));
        tokio::task::yield_now().await;
        assert!(!replacement.is_finished());
        drop(old);
        let next = tokio::time::timeout(std::time::Duration::from_secs(1), replacement)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert!(TurnPermit::acquire(account).is_err());
        drop(next);
        assert!(TurnPermit::acquire(account).is_ok());
    }

    #[test]
    fn speech_preserves_all_words_and_respects_unicode_character_limit() {
        let text = "Hello, welcome to English practice. ".repeat(20);
        let chunks = speech_chunks(&text);
        assert!(
            chunks
                .iter()
                .all(|c| c.chars().count() <= 200 && !c.is_empty())
        );
        assert_eq!(chunks.join(" "), text.trim());
        let unicode = "ắ".repeat(401);
        assert_eq!(speech_chunks(&unicode).concat(), unicode);
        assert!(
            speech_chunks(&unicode)
                .iter()
                .all(|s| s.chars().count() <= 200)
        );
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod rejected_key_tests {
    use super::*;
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use axum::{
        Router,
        http::StatusCode,
        routing::{get, post},
    };
    use sqlx::PgPool;
    use std::sync::{
        Arc,
        atomic::{AtomicU16, Ordering},
    };

    const GROQ_KEY: &str = "gsk-voice-test-key-000000000001";

    async fn groq_account(state: &AppState) -> Uuid {
        let owner = Uuid::new_v4();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(owner)
            .bind(owner.simple().to_string())
            .execute(&state.pool)
            .await
            .unwrap();
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO agent_connections (id,user_id,provider,status) VALUES ($1,$2,'groq','connected')",
        )
        .bind(id)
        .bind(owner)
        .execute(&state.pool)
        .await
        .unwrap();
        let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
        let nonce = [9_u8; 12];
        let payload = json!({"access_token": GROQ_KEY}).to_string();
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce), payload.as_bytes())
            .unwrap();
        sqlx::query(
            "INSERT INTO agent_connection_credentials (connection_id,credential_ciphertext,credential_nonce) VALUES ($1,$2,$3)",
        )
        .bind(id)
        .bind(ciphertext)
        .bind(nonce.to_vec())
        .execute(&state.pool)
        .await
        .unwrap();
        id
    }

    async fn availability(state: &AppState, id: Uuid) -> (String, Option<String>) {
        sqlx::query_as(
            "SELECT availability_status, failure_message FROM agent_connections WHERE id = $1",
        )
        .bind(id)
        .fetch_one(&state.pool)
        .await
        .unwrap()
    }

    #[sqlx::test]
    async fn a_rejected_voice_call_marks_the_account_only_when_its_key_is_no_longer_valid(
        pool: PgPool,
    ) {
        // Chat always rejects the call; the key check answers with `models_status`.
        let models_status = Arc::new(AtomicU16::new(200));
        let models = models_status.clone();
        let server = Router::new()
            .route(
                "/chat/completions",
                post(|| async { (StatusCode::UNAUTHORIZED, "rejected") }),
            )
            .route(
                "/models",
                get(move || {
                    let models = models.clone();
                    async move {
                        (
                            StatusCode::from_u16(models.load(Ordering::SeqCst)).unwrap(),
                            axum::Json(json!({"data": []})),
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
                groq_api_url: base.clone(),
                ..crate::AppConfig::default()
            },
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
            pool,
        };
        let id = groq_account(&state).await;
        let call = || {
            checked_request(
                &state,
                id,
                GROQ_KEY,
                state
                    .gateway_http
                    .post(format!("{base}/chat/completions"))
                    .bearer_auth(GROQ_KEY),
                "reply",
            )
        };

        // One rejected call while the key still validates: the call fails,
        // but the account is not blocked for everyone else.
        assert!(matches!(
            call().await,
            Err(ApiError::Provider(message)) if message.contains("Start a new call")
        ));
        assert_eq!(availability(&state, id).await, ("active".to_owned(), None));

        // Once the key itself is rejected, the account needs its owner.
        models_status.store(401, Ordering::SeqCst);
        assert!(matches!(
            call().await,
            Err(ApiError::Provider(message)) if message.contains("valid API key")
        ));
        let (status, message) = availability(&state, id).await;
        assert_eq!(status, "reauth_required");
        assert_eq!(
            message.as_deref(),
            Some("Provider authorization expired. Refresh this pool to reconnect.")
        );
        task.abort();
    }
}
