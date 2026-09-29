use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
use axum::{
    Json, Router,
    body::{Body, Bytes, to_bytes},
    http::{HeaderMap, Request, StatusCode},
    response::IntoResponse,
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
    keyed_connection(state, owner, "test-provider-token").await
}

/// A connected DeepSeek account whose stored API key is `api_key`.
async fn keyed_connection(state: &AppState, owner: Uuid, api_key: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO agent_connections (id, user_id, provider, status) VALUES ($1, $2, 'deepseek', 'connected')")
        .bind(id).bind(owner).execute(&state.pool).await.unwrap();
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
    let nonce: [u8; 12] = Uuid::new_v4().as_bytes()[..12].try_into().unwrap();
    let payload = json!({ "access_token": api_key }).to_string();
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce), payload.as_bytes())
        .unwrap();
    sqlx::query("INSERT INTO agent_connection_credentials (connection_id, credential_ciphertext, credential_nonce, access_token_expires_at) VALUES ($1, $2, $3, NOW() + INTERVAL '1 day')")
        .bind(id).bind(ciphertext).bind(nonce.to_vec()).execute(&state.pool).await.unwrap();
    id
}

#[sqlx::test]
async fn voice_authenticates_before_parsing_and_requires_origin_and_pinned_access(pool: PgPool) {
    let (state, upstream) = fixture(pool).await;
    let (_, cookie) = user(&state.pool).await;
    let router = app(state);
    for (auth, origin, body, expected) in [
        ("", "http://localhost:5173", "not-json".into(), StatusCode::UNAUTHORIZED),
        (cookie.as_str(), "https://attacker.example", "not-json".into(), StatusCode::FORBIDDEN),
        (cookie.as_str(), "http://localhost:5173", " ".repeat(97 * 1024), StatusCode::PAYLOAD_TOO_LARGE),
        (cookie.as_str(), "http://localhost:5173", json!({"connection_id":Uuid::new_v4(),"provider":"chatgpt","model":"gpt-live-1-codex","sdp":"v=0\r\nm=audio 9 RTP/SAVPF 111\r\n"}).to_string(), StatusCode::FORBIDDEN),
    ] {
        let response = router.clone().oneshot(Request::builder().method("POST").uri("/playground/voice")
            .header("cookie", auth).header("origin", origin).header("content-type", "application/json")
            .body(Body::from(body)).unwrap()).await.unwrap();
        assert_eq!(response.status(), expected);
    }
    upstream.abort();
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
        assert_eq!(
            response.headers()[crate::gateway::SERVED_CONNECTION_HEADER],
            connection.to_string().as_str()
        );
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
        json!([{"id":"deepseek-flash", "name":"Test model", "modes":["chat"], "capabilities":["chat"]}])
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

#[sqlx::test]
async fn groq_local_transcript_pipeline_pins_access_without_remote_stt_or_replay(pool: PgPool) {
    use crate::playground_groq_voice::{GROQ_CHAT_MODEL, GROQ_TTS_MODEL};
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let hold_chat = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let chat_held = hold_chat.clone();
    let hold_after_first = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let chat_split = hold_after_first.clone();
    let release_chat = Arc::new(tokio::sync::Notify::new());
    let chat_release = release_chat.clone();
    let spoken = Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let spoken_text = spoken.clone();
    let sentence_mode = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let tts_sentence_mode = sentence_mode.clone();
    let calls = Arc::new(AtomicUsize::new(0));
    let status = Arc::new(AtomicUsize::new(200));
    let stt_calls = Arc::new(AtomicUsize::new(0));
    let rejected_stt = stt_calls.clone();
    let chat_status = status.clone();
    let chat_calls = calls.clone();
    let tts_calls = calls.clone();
    let text_calls = Arc::new(AtomicUsize::new(0));
    let text_requests = text_calls.clone();
    let upstream = Router::new()
        .route("/models", get(|headers: HeaderMap| async move {
            assert_eq!(headers["authorization"], "Bearer gsk_test_groq_key_1234");
            Json(json!({"data":[{"id":"qwen/qwen3.8-27b"},{"id":GROQ_CHAT_MODEL},{"id":"openai/gpt-oss-120b"},{"id":"llama-3.3-70b-versatile"},{"id":GROQ_TTS_MODEL}]}))
        }))
        .route("/responses", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let calls = text_requests.clone(); async move {
                assert_eq!(headers["authorization"], "Bearer gsk_test_groq_key_1234");
                assert!(matches!(body["model"].as_str(), Some("qwen/qwen3.8-27b" | "openai/gpt-oss-20b" | "openai/gpt-oss-120b")));
                assert_eq!(body["input"][0]["content"][0]["text"], "Hello");
                assert_eq!(body["stream"], true);
                assert!(body.get("store").is_none());
                calls.fetch_add(1, Ordering::SeqCst);
                ([("content-type", "text/event-stream")], "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"Groq chat accepted\"}\n\nevent: response.completed\ndata: {\"type\":\"response.completed\"}\n\n")
            }
        }))
        .route("/audio/transcriptions", post(move || {
            let rejected = rejected_stt.clone();
            async move {
                rejected.fetch_add(1, Ordering::SeqCst);
                StatusCode::INTERNAL_SERVER_ERROR
            }
        }))
        .route("/chat/completions", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let calls = chat_calls.clone(); let status = chat_status.clone(); let held = chat_held.clone(); let split = chat_split.clone(); let release = chat_release.clone(); async move {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["authorization"], "Bearer gsk_test_groq_key_1234");
                assert!(!headers.contains_key("cookie") && !headers.contains_key("origin"));
                assert_eq!(body["model"], GROQ_CHAT_MODEL);
                if status.load(Ordering::SeqCst) != 200 {
                    return StatusCode::from_u16(status.load(Ordering::SeqCst) as u16).unwrap().into_response();
                }
                assert_eq!(body["messages"][1]["content"], "Hello teacher");
                if body["stream"] == true {
                    let records = [
                        json!({"choices":[{"delta":{"content":"Hello! "}}]}),
                        json!({"choices":[{"delta":{"content":"How was your day?"},"finish_reason":"stop"}],"x_groq":{"usage":{"prompt_tokens":25,"completion_tokens":8}}}),
                    ];
                    if split.load(Ordering::SeqCst) {
                        let first = format!("data: {}\r\n\r\n", records[0]);
                        let last = format!("data: {}\r\n\r\ndata: [DONE]\r\n\r\n", records[1]);
                        let stream = futures_util::stream::once(async move { Ok::<_, std::convert::Infallible>(first) })
                            .chain(futures_util::stream::once(async move {
                                release.notified().await;
                                Ok::<_, std::convert::Infallible>(last)
                            }));
                        return ([("content-type", "text/event-stream")], Body::from_stream(stream)).into_response();
                    }
                    let mut bytes = records.iter().map(|record| format!("data: {record}\r\n\r\n")).collect::<String>();
                    bytes.push_str("data: [DONE]\r\n\r\n");
                    let delay = held.load(Ordering::SeqCst);
                    let stream = futures_util::stream::once(async move {
                        if delay { tokio::time::sleep(std::time::Duration::from_secs(60)).await; }
                        Ok::<_, std::convert::Infallible>(bytes)
                    });
                    return ([("content-type", "text/event-stream")], Body::from_stream(stream)).into_response();
                }
                Json(json!({"choices":[{"message":{"content":"Hello! How was your day?"}}],"usage":{"prompt_tokens":25,"completion_tokens":8}})).into_response()
            }
        }))
        .route("/audio/speech", post(move |headers: HeaderMap, Json(body): Json<Value>| {
            let calls = tts_calls.clone(); let spoken = spoken_text.clone(); let sentences = tts_sentence_mode.clone(); async move {
                calls.fetch_add(1, Ordering::SeqCst);
                assert_eq!(headers["authorization"], "Bearer gsk_test_groq_key_1234");
                assert_eq!(body["model"], GROQ_TTS_MODEL); assert_eq!(body["voice"], "hannah");
                let text = body["input"].as_str().unwrap();
                if sentences.load(Ordering::SeqCst) {
                    assert!(matches!(text, "Hello!" | "How was your day?"));
                } else {
                    assert_eq!(text, "Hello! How was your day?");
                }
                spoken.lock().unwrap().push(text.to_owned());
                ([("content-type","audio/wav")], b"RIFF\x00\x00\x00\x00WAVEfixture".to_vec())
            }
        }));
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let state = AppState {
        config: AppConfig {
            groq_api_url: format!("http://{}", listener.local_addr().unwrap()),
            ..AppConfig::default()
        },
        pool,
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
    };
    let task = tokio::spawn(async move {
        axum::serve(listener, upstream).await.unwrap();
    });
    let (owner_id, cookie) = user(&state.pool).await;
    let (_, stranger) = user(&state.pool).await;
    let router = app(state.clone());
    let connected = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/agent-connections/groq")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"api_key":"gsk_test_groq_key_1234"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(connected.status(), StatusCode::CREATED);
    let bytes = to_bytes(connected.into_body(), 16384).await.unwrap();
    assert!(!String::from_utf8_lossy(&bytes).contains("gsk_test_groq"));
    let account: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(account["account_label"], "••••1234");
    assert_eq!(account["provider"], "groq");
    let id = account["id"].as_str().unwrap();
    let catalogue = router
        .clone()
        .oneshot(
            Request::builder()
                .uri(format!("/playground/groq/accounts/{id}/models"))
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(catalogue.status(), StatusCode::OK);
    let catalogue: Value =
        serde_json::from_slice(&to_bytes(catalogue.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(catalogue.as_array().unwrap().len(), 3);
    let call_models = catalogue
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["id"] == GROQ_CHAT_MODEL)
        .collect::<Vec<_>>();
    assert_eq!(call_models.len(), 1);
    assert_eq!(call_models[0]["modes"], json!(["chat", "voice"]));
    for model in catalogue.as_array().unwrap().iter().take(3) {
        let response = router.clone().oneshot(
            Request::builder()
                .method("POST")
                .uri("/playground/chat")
                .header("cookie", &cookie)
                .header("origin", "http://localhost:5173")
                .header("content-type", "application/json")
                .body(Body::from(json!({"provider":"groq", "connection_id":id, "model":model["id"], "messages":[{"role":"user","content":"Hello"}]}).to_string()))
                .unwrap()
        ).await.unwrap();
        assert_eq!(
            response.status(),
            StatusCode::OK,
            "chat model {}",
            model["id"]
        );
        let text = to_bytes(response.into_body(), 16384).await.unwrap();
        assert!(String::from_utf8_lossy(&text).contains("Groq chat accepted"));
    }
    assert_eq!(text_calls.load(Ordering::SeqCst), 3);
    let body = json!({"connection_id":id, "model":GROQ_CHAT_MODEL,"transcript":"Hello teacher","messages":[]}).to_string();
    let call_request = |auth: &str, origin: &str, payload: String| {
        Request::builder()
            .method("POST")
            .uri("/playground/groq/voice/turn")
            .header("cookie", auth)
            .header("origin", origin)
            .header("content-type", "application/json")
            .body(Body::from(payload))
            .unwrap()
    };
    for (auth, origin, payload, expected) in [
        (
            "",
            "http://localhost:5173",
            "bad-json".to_owned(),
            StatusCode::UNAUTHORIZED,
        ),
        (
            cookie.as_str(),
            "https://attacker.example",
            "bad-json".to_owned(),
            StatusCode::FORBIDDEN,
        ),
        (
            stranger.as_str(),
            "http://localhost:5173",
            body.clone(),
            StatusCode::FORBIDDEN,
        ),
        (
            cookie.as_str(),
            "http://localhost:5173",
            " ".repeat(64 * 1024 + 1),
            StatusCode::PAYLOAD_TOO_LARGE,
        ),
    ] {
        assert_eq!(
            router
                .clone()
                .oneshot(call_request(auth, origin, payload))
                .await
                .unwrap()
                .status(),
            expected
        );
    }
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    let response = router
        .clone()
        .oneshot(call_request(&cookie, "http://localhost:5173", body.clone()))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let response: Value =
        serde_json::from_slice(&to_bytes(response.into_body(), 16384).await.unwrap()).unwrap();
    assert_eq!(response["transcript"], "Hello teacher");
    assert_eq!(response["reply"], "Hello! How was your day?");
    assert_eq!(response["audio"].as_array().unwrap().len(), 1);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    let mut streaming: Value = serde_json::from_str(&body).unwrap();
    streaming["stream"] = true.into();
    let streamed = router
        .clone()
        .oneshot(call_request(
            &cookie,
            "http://localhost:5173",
            streaming.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(streamed.status(), StatusCode::OK);
    assert_eq!(streamed.headers()["content-type"], "text/event-stream");
    let text = to_bytes(streamed.into_body(), 16384).await.unwrap();
    let text = std::str::from_utf8(&text).unwrap();
    let events: Vec<Value> = text
        .lines()
        .filter_map(|line| line.strip_prefix("data: "))
        .map(|data| serde_json::from_str(data).unwrap())
        .collect();
    assert_eq!(
        events
            .iter()
            .map(|event| event["type"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["transcript", "delta", "delta", "audio", "done"]
    );
    assert_eq!(events[1]["text"], "Hello! ");
    assert_eq!(events[2]["text"], "How was your day?");
    assert_eq!(calls.load(Ordering::SeqCst), 4);

    // Disconnect while upstream is still generating. No TTS or silent replay is allowed.
    use futures_util::StreamExt;
    hold_chat.store(true, Ordering::SeqCst);
    let canceled = router
        .clone()
        .oneshot(call_request(
            &cookie,
            "http://localhost:5173",
            streaming.to_string(),
        ))
        .await
        .unwrap();
    let mut canceled = canceled.into_body().into_data_stream();
    let transcript = canceled.next().await.unwrap().unwrap();
    assert!(
        std::str::from_utf8(&transcript)
            .unwrap()
            .contains("transcript")
    );
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        while calls.load(Ordering::SeqCst) < 5 {
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    drop(canceled);
    hold_chat.store(false, Ordering::SeqCst);
    let replacement = router
        .clone()
        .oneshot(call_request(
            &cookie,
            "http://localhost:5173",
            streaming.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(replacement.status(), StatusCode::OK);
    let replacement = to_bytes(replacement.into_body(), 16384).await.unwrap();
    assert!(
        std::str::from_utf8(&replacement)
            .unwrap()
            .contains("\"type\":\"done\"")
    );
    assert_eq!(calls.load(Ordering::SeqCst), 7);

    // No legacy audio endpoint or provider fallback remains.
    let removed = router
        .clone()
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/playground/groq/voice/transcription")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::NOT_FOUND);
    for text in ["", " ", ".", "...?!", "🎵"] {
        let mut empty = streaming.clone();
        empty["transcript"] = text.into();
        let response = router
            .clone()
            .oneshot(call_request(
                &cookie,
                "http://localhost:5173",
                empty.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert_eq!(calls.load(Ordering::SeqCst), 7, "Noise never reaches Groq");

    // Block the LLM after its first sentence until the test receives early audio.
    sentence_mode.store(true, Ordering::SeqCst);
    hold_after_first.store(true, Ordering::SeqCst);
    streaming["stream_audio"] = true.into();
    for canceled in [false, true] {
        let before = calls.load(Ordering::SeqCst);
        spoken.lock().unwrap().clear();
        let response = router
            .clone()
            .oneshot(call_request(
                &cookie,
                "http://localhost:5173",
                streaming.to_string(),
            ))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let mut body = response.into_body().into_data_stream();
        let first = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let mut first = String::new();
            while !first.contains("\"type\":\"audio\"") {
                let bytes = body.next().await.unwrap().unwrap();
                first.push_str(std::str::from_utf8(&bytes).unwrap());
            }
            first
        })
        .await
        .expect("TTS/audio must happen before LLM completion");
        assert!(first.contains("Hello! ") && !first.contains("How was your day?"));
        assert_eq!(calls.load(Ordering::SeqCst), before + 2);
        assert_eq!(*spoken.lock().unwrap(), ["Hello!"]);
        if canceled {
            drop(body); // No detached TTS/LLM task may continue after disconnect.
        } else {
            release_chat.notify_one();
            let mut rest = String::new();
            while let Some(bytes) = body.next().await {
                rest.push_str(std::str::from_utf8(&bytes.unwrap()).unwrap());
            }
            assert!(rest.contains("How was your day?") && rest.contains("\"type\":\"done\""));
            assert_eq!(calls.load(Ordering::SeqCst), before + 3);
            assert_eq!(*spoken.lock().unwrap(), ["Hello!", "How was your day?"]);
        }
    }
    hold_after_first.store(false, Ordering::SeqCst);
    let before = calls.load(Ordering::SeqCst);
    let response = router
        .clone()
        .oneshot(call_request(
            &cookie,
            "http://localhost:5173",
            streaming.to_string(),
        ))
        .await
        .unwrap();
    let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .contains("\"type\":\"done\"")
    );
    assert_eq!(
        calls.load(Ordering::SeqCst),
        before + 3,
        "Canceled pipeline releases the account for a replacement"
    );

    // Only completed text-to-speech conversations record organization usage.
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id,name) VALUES ($1,'Voice fixture')")
        .bind(org)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organization_memberships (id,org_id,user_id,role,status,joined_at) VALUES ($1,$2,$3,'owner','accepted',NOW())")
        .bind(Uuid::new_v4()).bind(org).bind(owner_id).execute(&state.pool).await.unwrap();
    sqlx::query(
        "INSERT INTO organization_agents (org_id,connection_id,owner_user_id) VALUES ($1,$2,$3)",
    )
    .bind(org)
    .bind(Uuid::parse_str(id).unwrap())
    .bind(owner_id)
    .execute(&state.pool)
    .await
    .unwrap();
    streaming["organization_id"] = org.to_string().into();
    let response = router
        .clone()
        .oneshot(call_request(
            &cookie,
            "http://localhost:5173",
            streaming.to_string(),
        ))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = to_bytes(response.into_body(), 16384).await.unwrap();
    assert!(
        std::str::from_utf8(&bytes)
            .unwrap()
            .contains("\"type\":\"done\"")
    );
    let usage: (i64, i64, i64) = sqlx::query_as("SELECT COUNT(*),SUM(input_tokens)::bigint,SUM(output_tokens)::bigint FROM organization_usage_events WHERE org_id=$1")
        .bind(org).fetch_one(&state.pool).await.unwrap();
    assert_eq!(usage, (1, 25, 8));
    let before_cooldown = calls.load(Ordering::SeqCst);
    status.store(429, Ordering::SeqCst);
    for _ in 0..2 {
        assert_eq!(
            router
                .clone()
                .oneshot(call_request(&cookie, "http://localhost:5173", body.clone()))
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        before_cooldown + 1,
        "429 must cool down without replay or later pipeline calls"
    );
    assert_eq!(
        stt_calls.load(Ordering::SeqCst),
        0,
        "Browser speech must never reach Groq STT"
    );
    task.abort();
}

const BROWSER_ORIGIN: &str = "http://localhost:5173";

/// A fake DeepSeek upstream that answers per bearer API key, so every account
/// can be made healthy or unavailable on its own, and records which key was
/// called on which path, in order.
#[derive(Clone, Default)]
struct KeyedUpstream {
    statuses: Arc<Mutex<HashMap<String, StatusCode>>>,
    calls: Arc<Mutex<Vec<(&'static str, String)>>>,
}

impl KeyedUpstream {
    fn answer(&self, api_key: &str, status: StatusCode) {
        self.statuses
            .lock()
            .unwrap()
            .insert(api_key.to_owned(), status);
    }

    fn calls(&self) -> Vec<(&'static str, String)> {
        self.calls.lock().unwrap().clone()
    }

    fn record(&self, path: &'static str, headers: &HeaderMap) -> (String, StatusCode) {
        let api_key = headers
            .get("authorization")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.strip_prefix("Bearer "))
            .unwrap_or_default()
            .to_owned();
        self.calls.lock().unwrap().push((path, api_key.clone()));
        // An unregistered key answers with a status no test expects.
        let status = self
            .statuses
            .lock()
            .unwrap()
            .get(&api_key)
            .copied()
            .unwrap_or(StatusCode::IM_A_TEAPOT);
        (api_key, status)
    }
}

fn called(path: &'static str, api_key: &str) -> (&'static str, String) {
    (path, api_key.to_owned())
}

async fn keyed_fixture(pool: PgPool) -> (AppState, KeyedUpstream, tokio::task::JoinHandle<()>) {
    let upstream = KeyedUpstream::default();
    let models = upstream.clone();
    let responses = upstream.clone();
    let router = Router::new()
        .route(
            "/models",
            get(move |headers: HeaderMap| {
                let upstream = models.clone();
                async move {
                    let (api_key, status) = upstream.record("/models", &headers);
                    if status != StatusCode::OK {
                        return (status, Json(json!({"error":{"message":"unavailable"}})))
                            .into_response();
                    }
                    Json(json!({"data":[{"id":"deepseek-flash","name":format!("Served by {api_key}")}]}))
                        .into_response()
                }
            }),
        )
        .route(
            "/responses",
            post(move |headers: HeaderMap| {
                let upstream = responses.clone();
                async move {
                    let (api_key, status) = upstream.record("/responses", &headers);
                    if status != StatusCode::OK {
                        return (status, Json(json!({"error":{"message":"unavailable"}})))
                            .into_response();
                    }
                    let delta = json!({"type":"response.output_text.delta","delta":format!("Served by {api_key}")});
                    let completed = json!({"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":11,"output_tokens":7}}});
                    (
                        [("content-type", "text/event-stream")],
                        format!(
                            "event: response.output_text.delta\ndata: {delta}\n\nevent: response.completed\ndata: {completed}\n\n"
                        ),
                    )
                        .into_response()
                }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let config = AppConfig {
        deepseek_api_url: format!("http://{}", listener.local_addr().unwrap()),
        ..AppConfig::default()
    };
    let task = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (
        AppState {
            config,
            pool,
            http: reqwest::Client::new(),
            gateway_http: reqwest::Client::new(),
        },
        upstream,
        task,
    )
}

/// An organization owned by `owner` with every user in `members` accepted.
async fn organization(pool: &PgPool, owner: Uuid, members: &[Uuid]) -> Uuid {
    let org = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Rotation fixture')")
        .bind(org)
        .execute(pool)
        .await
        .unwrap();
    for (user_id, role) in
        std::iter::once((owner, "owner")).chain(members.iter().map(|member| (*member, "member")))
    {
        sqlx::query(
            "INSERT INTO organization_memberships (id, org_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, $4, 'accepted', NOW())",
        )
        .bind(Uuid::new_v4())
        .bind(org)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    }
    org
}

async fn share(pool: &PgPool, org: Uuid, connection_id: Uuid, owner: Uuid) {
    sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id) VALUES ($1, $2, $3)",
    )
    .bind(org)
    .bind(connection_id)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
}

async fn pool_request(pool: &PgPool, connection_id: Uuid, requester: Uuid, status: &str) {
    sqlx::query("INSERT INTO agent_pool_join_requests (id, connection_id, requester_user_id, reason, telegram, status) VALUES ($1, $2, $3, 'test access', '@tester', $4)")
        .bind(Uuid::new_v4()).bind(connection_id).bind(requester).bind(status).execute(pool).await.unwrap();
}

fn chat_request(cookie: &str, connection_id: Uuid, organization_id: Option<Uuid>) -> Request<Body> {
    let mut body = json!({"connection_id":connection_id,"provider":"deepseek","model":"deepseek-flash","messages":[{"role":"user","content":"Hello"}]});
    if let Some(organization_id) = organization_id {
        body["organization_id"] = json!(organization_id);
    }
    Request::builder()
        .method("POST")
        .uri("/playground/chat")
        .header("cookie", cookie)
        .header("origin", BROWSER_ORIGIN)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap()
}

fn models_request(
    cookie: &str,
    connection_id: Uuid,
    organization_id: Option<Uuid>,
) -> Request<Body> {
    let query = organization_id
        .map(|organization_id| format!("?organization_id={organization_id}"))
        .unwrap_or_default();
    Request::builder()
        .uri(format!(
            "/playground/deepseek/accounts/{connection_id}/models{query}"
        ))
        .header("cookie", cookie)
        .body(Body::empty())
        .unwrap()
}

async fn body_text(response: axum::response::Response) -> String {
    String::from_utf8(
        to_bytes(response.into_body(), 65536)
            .await
            .unwrap()
            .to_vec(),
    )
    .unwrap()
}

fn served_by(response: &axum::response::Response) -> Option<&str> {
    response
        .headers()
        .get(crate::gateway::SERVED_CONNECTION_HEADER)
        .and_then(|value| value.to_str().ok())
}

async fn error_code(response: axum::response::Response) -> String {
    let body: Value = serde_json::from_str(&body_text(response).await).unwrap();
    body["code"].as_str().unwrap().to_owned()
}

/// (availability_status, failure_message, still cooling down for 25+ minutes)
async fn availability(pool: &PgPool, connection_id: Uuid) -> (String, Option<String>, bool) {
    sqlx::query_as(
        "SELECT availability_status, failure_message,
                COALESCE(rate_limited_until > NOW() + INTERVAL '25 minutes', FALSE)
         FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_one(pool)
    .await
    .unwrap()
}

type UsageRow = (
    Uuid,
    Option<Uuid>,
    String,
    Option<String>,
    Option<i64>,
    Option<i64>,
);

async fn organization_usage(pool: &PgPool, org: Uuid) -> Vec<UsageRow> {
    sqlx::query_as(
        "SELECT user_id, connection_id, provider, model, input_tokens, output_tokens
         FROM organization_usage_events WHERE org_id = $1 ORDER BY created_at, id",
    )
    .bind(org)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn usage_event_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM organization_usage_events")
        .fetch_one(pool)
        .await
        .unwrap()
}

#[sqlx::test]
async fn organization_chat_fails_over_from_rate_limited_preferred_share_to_teammate_share(
    pool: PgPool,
) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (owner, _) = user(&state.pool).await;
    let (member, member_cookie) = user(&state.pool).await;
    let org = organization(&state.pool, owner, &[member]).await;
    let preferred = keyed_connection(&state, member, "key-a").await;
    let teammate = keyed_connection(&state, owner, "key-b").await;
    share(&state.pool, org, preferred, member).await;
    share(&state.pool, org, teammate, owner).await;
    upstream.answer("key-a", StatusCode::TOO_MANY_REQUESTS);
    upstream.answer("key-b", StatusCode::OK);
    let router = app(state.clone());

    let response = router
        .clone()
        .oneshot(chat_request(&member_cookie, preferred, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(response.headers()["content-type"], "text/event-stream");
    assert_eq!(served_by(&response), Some(teammate.to_string().as_str()));
    let stream = body_text(response).await;
    assert!(stream.contains("Served by key-b"), "{stream}");
    assert!(!stream.contains("key-a"));
    assert_eq!(
        upstream.calls(),
        [called("/responses", "key-a"), called("/responses", "key-b")]
    );
    assert_eq!(
        availability(&state.pool, preferred).await,
        ("rate_limited".to_owned(), None, true)
    );
    assert_eq!(
        availability(&state.pool, teammate).await,
        ("active".to_owned(), None, false)
    );
    let billed_to_teammate = (
        member,
        Some(teammate),
        "deepseek".to_owned(),
        Some("deepseek-flash".to_owned()),
        Some(11),
        Some(7),
    );
    assert_eq!(
        organization_usage(&state.pool, org).await,
        [billed_to_teammate.clone()],
        "Usage belongs to the account that served the request"
    );

    // While the preferred share cools down it is skipped without a call.
    let response = router
        .clone()
        .oneshot(chat_request(&member_cookie, preferred, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by(&response), Some(teammate.to_string().as_str()));
    assert!(body_text(response).await.contains("Served by key-b"));
    assert_eq!(
        upstream.calls(),
        [
            called("/responses", "key-a"),
            called("/responses", "key-b"),
            called("/responses", "key-b")
        ]
    );
    assert_eq!(
        organization_usage(&state.pool, org).await,
        [billed_to_teammate.clone(), billed_to_teammate]
    );
    server.abort();
}

#[sqlx::test]
async fn organization_chat_is_rate_limited_without_touching_members_personal_account(pool: PgPool) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (owner, _) = user(&state.pool).await;
    let (member, member_cookie) = user(&state.pool).await;
    let org = organization(&state.pool, owner, &[member]).await;
    let preferred = keyed_connection(&state, member, "key-a").await;
    let teammate = keyed_connection(&state, owner, "key-b").await;
    // The member's own healthy account that was never shared with the organization.
    let personal = keyed_connection(&state, member, "key-personal").await;
    share(&state.pool, org, preferred, member).await;
    share(&state.pool, org, teammate, owner).await;
    upstream.answer("key-a", StatusCode::TOO_MANY_REQUESTS);
    upstream.answer("key-b", StatusCode::TOO_MANY_REQUESTS);
    upstream.answer("key-personal", StatusCode::OK);
    let router = app(state.clone());

    let response = router
        .clone()
        .oneshot(chat_request(&member_cookie, preferred, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(served_by(&response), None);
    assert_eq!(error_code(response).await, "all_pools_rate_limited");
    assert_eq!(
        upstream.calls(),
        [called("/responses", "key-a"), called("/responses", "key-b")],
        "Organization failover stays inside the organization's shares"
    );
    for share in [preferred, teammate] {
        assert_eq!(
            availability(&state.pool, share).await,
            ("rate_limited".to_owned(), None, true)
        );
    }
    assert_eq!(
        availability(&state.pool, personal).await,
        ("active".to_owned(), None, false)
    );
    assert_eq!(organization_usage(&state.pool, org).await, []);

    // The personal account was healthy and reachable in its own scope all along.
    let response = router
        .clone()
        .oneshot(chat_request(&member_cookie, personal, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by(&response), Some(personal.to_string().as_str()));
    assert!(body_text(response).await.contains("Served by key-personal"));
    assert_eq!(
        upstream.calls().last(),
        Some(&called("/responses", "key-personal"))
    );
    assert_eq!(usage_event_count(&state.pool).await, 0);
    server.abort();
}

#[sqlx::test]
async fn personal_chat_fails_over_only_to_own_accounts_and_accepted_pools(pool: PgPool) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (requester, cookie) = user(&state.pool).await;
    let (pool_owner, _) = user(&state.pool).await;
    let (org_owner, _) = user(&state.pool).await;
    let own = keyed_connection(&state, requester, "key-own").await;
    let accepted_pool = keyed_connection(&state, pool_owner, "key-pool").await;
    pool_request(&state.pool, accepted_pool, requester, "accepted").await;
    let pending_pool = keyed_connection(&state, pool_owner, "key-pending").await;
    pool_request(&state.pool, pending_pool, requester, "pending").await;
    // Shared with an organization the requester belongs to, but never pooled.
    let org = organization(&state.pool, org_owner, &[requester]).await;
    let org_share = keyed_connection(&state, org_owner, "key-org-share").await;
    share(&state.pool, org, org_share, org_owner).await;
    upstream.answer("key-own", StatusCode::TOO_MANY_REQUESTS);
    upstream.answer("key-pool", StatusCode::OK);
    upstream.answer("key-pending", StatusCode::OK);
    upstream.answer("key-org-share", StatusCode::OK);
    let router = app(state.clone());

    let response = router
        .clone()
        .oneshot(chat_request(&cookie, own, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(
        served_by(&response),
        Some(accepted_pool.to_string().as_str())
    );
    assert!(body_text(response).await.contains("Served by key-pool"));
    assert_eq!(
        upstream.calls(),
        [
            called("/responses", "key-own"),
            called("/responses", "key-pool")
        ]
    );
    assert_eq!(
        availability(&state.pool, own).await,
        ("rate_limited".to_owned(), None, true)
    );

    // Once the personal scope is exhausted the request fails instead of
    // borrowing the organization-only share or the pending pool.
    upstream.answer("key-pool", StatusCode::TOO_MANY_REQUESTS);
    let response = router
        .clone()
        .oneshot(chat_request(&cookie, own, None))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(response).await, "all_pools_rate_limited");
    assert_eq!(
        upstream.calls(),
        [
            called("/responses", "key-own"),
            called("/responses", "key-pool"),
            called("/responses", "key-pool")
        ]
    );
    assert_eq!(usage_event_count(&state.pool).await, 0);

    // The organization share was healthy and reachable in its own scope.
    let response = router
        .clone()
        .oneshot(chat_request(&cookie, org_share, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by(&response), Some(org_share.to_string().as_str()));
    assert!(
        body_text(response)
            .await
            .contains("Served by key-org-share")
    );
    assert!(
        upstream
            .calls()
            .iter()
            .all(|(_, api_key)| api_key != "key-pending"),
        "A pending pool request never grants access"
    );
    server.abort();
}

#[sqlx::test]
async fn preferred_share_needing_reconnect_is_skipped_for_models_and_chat(pool: PgPool) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (owner, _) = user(&state.pool).await;
    let (member, member_cookie) = user(&state.pool).await;
    let org = organization(&state.pool, owner, &[member]).await;
    let reconnect = keyed_connection(&state, owner, "key-reconnect").await;
    let healthy = keyed_connection(&state, member, "key-b").await;
    share(&state.pool, org, reconnect, owner).await;
    share(&state.pool, org, healthy, member).await;
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', failure_message = $2
         WHERE id = $1",
    )
    .bind(reconnect)
    .bind(crate::connections::PROVIDER_LOGIN_REQUIRED_MESSAGE)
    .execute(&state.pool)
    .await
    .unwrap();
    // Even a key the provider would accept must not be used until reconnect.
    upstream.answer("key-reconnect", StatusCode::OK);
    upstream.answer("key-b", StatusCode::OK);
    let router = app(state.clone());

    let response = router
        .clone()
        .oneshot(models_request(&member_cookie, reconnect, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let models: Value = serde_json::from_str(&body_text(response).await).unwrap();
    assert_eq!(models.as_array().unwrap().len(), 1);
    assert_eq!(models[0]["id"], "deepseek-flash");
    assert_eq!(models[0]["name"], "Served by key-b");

    let response = router
        .clone()
        .oneshot(chat_request(&member_cookie, reconnect, Some(org)))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_by(&response), Some(healthy.to_string().as_str()));
    assert!(body_text(response).await.contains("Served by key-b"));
    assert_eq!(
        upstream.calls(),
        [called("/models", "key-b"), called("/responses", "key-b")]
    );
    assert_eq!(
        availability(&state.pool, reconnect).await,
        (
            "reauth_required".to_owned(),
            Some(crate::connections::PROVIDER_LOGIN_REQUIRED_MESSAGE.to_owned()),
            false
        ),
        "Skipping the account leaves its reconnect prompt untouched"
    );
    assert_eq!(
        organization_usage(&state.pool, org).await,
        [(
            member,
            Some(healthy),
            "deepseek".to_owned(),
            Some("deepseek-flash".to_owned()),
            Some(11),
            Some(7)
        )]
    );
    server.abort();
}

#[sqlx::test]
async fn every_account_needing_reconnect_fails_with_a_scope_specific_message(pool: PgPool) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (owner, owner_cookie) = user(&state.pool).await;
    let (member, member_cookie) = user(&state.pool).await;
    let org = organization(&state.pool, owner, &[member]).await;
    let first = keyed_connection(&state, owner, "key-first").await;
    let second = keyed_connection(&state, member, "key-second").await;
    share(&state.pool, org, first, owner).await;
    share(&state.pool, org, second, member).await;
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'reauth_required', failure_message = $1",
    )
    .bind(crate::connections::PROVIDER_LOGIN_REQUIRED_MESSAGE)
    .execute(&state.pool)
    .await
    .unwrap();
    upstream.answer("key-first", StatusCode::OK);
    upstream.answer("key-second", StatusCode::OK);
    let router = app(state.clone());

    for (request, expected) in [
        (
            chat_request(&member_cookie, first, Some(org)),
            "Every account for this provider in this organization needs to reconnect.",
        ),
        (
            models_request(&member_cookie, first, Some(org)),
            "Every account for this provider in this organization needs to reconnect.",
        ),
        (
            chat_request(&owner_cookie, first, None),
            "Every account for this provider available to you needs to reconnect.",
        ),
    ] {
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
        let body: Value = serde_json::from_str(&body_text(response).await).unwrap();
        assert_eq!(body["code"], "provider_unavailable");
        assert!(
            body["message"].as_str().unwrap().starts_with(expected),
            "{body}"
        );
    }
    assert_eq!(upstream.calls(), []);
    server.abort();
}

#[sqlx::test]
async fn preferred_account_outside_callers_scope_is_forbidden_before_any_upstream_call(
    pool: PgPool,
) {
    let (state, upstream, server) = keyed_fixture(pool).await;
    let (requester, cookie) = user(&state.pool).await;
    let (stranger, _) = user(&state.pool).await;
    let (org_owner, _) = user(&state.pool).await;
    let (other_org_owner, _) = user(&state.pool).await;
    // The requester's own healthy account, a failover target in personal scope.
    let own = keyed_connection(&state, requester, "key-own").await;
    // A stranger's account the requester only asked to join.
    let foreign = keyed_connection(&state, stranger, "key-foreign").await;
    pool_request(&state.pool, foreign, requester, "pending").await;
    let org = organization(&state.pool, org_owner, &[requester]).await;
    let org_share = keyed_connection(&state, org_owner, "key-org").await;
    share(&state.pool, org, org_share, org_owner).await;
    // Another organization the requester is not a member of.
    let other_org = organization(&state.pool, other_org_owner, &[]).await;
    let other_share = keyed_connection(&state, other_org_owner, "key-other-org").await;
    share(&state.pool, other_org, other_share, other_org_owner).await;
    for api_key in ["key-own", "key-foreign", "key-org", "key-other-org"] {
        upstream.answer(api_key, StatusCode::OK);
    }
    let router = app(state.clone());

    for (label, request) in [
        (
            "personal chat, stranger's account",
            chat_request(&cookie, foreign, None),
        ),
        (
            "personal models, stranger's account",
            models_request(&cookie, foreign, None),
        ),
        (
            "personal chat, organization-only share",
            chat_request(&cookie, org_share, None),
        ),
        (
            "organization chat, own unshared account",
            chat_request(&cookie, own, Some(org)),
        ),
        (
            "organization models, own unshared account",
            models_request(&cookie, own, Some(org)),
        ),
        (
            "organization chat, another organization's share",
            chat_request(&cookie, other_share, Some(org)),
        ),
        (
            "organization models, stranger's account",
            models_request(&cookie, foreign, Some(org)),
        ),
        (
            "non-member organization chat",
            chat_request(&cookie, other_share, Some(other_org)),
        ),
    ] {
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN, "{label}");
        assert_eq!(served_by(&response), None, "{label}");
        assert_eq!(error_code(response).await, "forbidden", "{label}");
        assert_eq!(upstream.calls(), [], "{label} must not reach the provider");
    }
    for connection_id in [own, foreign, org_share, other_share] {
        assert_eq!(
            availability(&state.pool, connection_id).await,
            ("active".to_owned(), None, false)
        );
    }
    assert_eq!(usage_event_count(&state.pool).await, 0);

    // The same caller still reaches every account inside its scope.
    for (request, served, api_key) in [
        (chat_request(&cookie, own, None), own, "key-own"),
        (
            chat_request(&cookie, org_share, Some(org)),
            org_share,
            "key-org",
        ),
    ] {
        let response = router.clone().oneshot(request).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(served_by(&response), Some(served.to_string().as_str()));
        assert!(
            body_text(response)
                .await
                .contains(&format!("Served by {api_key}"))
        );
    }
    assert_eq!(
        upstream.calls(),
        [
            called("/responses", "key-own"),
            called("/responses", "key-org")
        ]
    );
    server.abort();
}
