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
        json!([{"id":"deepseek-flash", "name":"Test model", "modes":["chat"]}])
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
