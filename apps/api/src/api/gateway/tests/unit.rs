#[test]
fn a_gemini_validation_link_must_be_googles_own_https_address() {
    use crate::api::gateway::providers::gemini_verification::gemini_validation_url;

    assert_eq!(
        gemini_validation_url(
            br#"{"ineligibleTiers":[{"reasonCode":"VALIDATION_REQUIRED",
                     "validationUrl":"https://accounts.google.com/signin/continue?sarp=1"}]}"#
        )
        .as_deref(),
        Some("https://accounts.google.com/signin/continue?sarp=1")
    );
    assert_eq!(
        gemini_validation_url(br#"{"validationUrl":"http://accounts.google.com/signin/continue"}"#),
        None
    );
    assert_eq!(
        gemini_validation_url(br#"{"validationUrl":"https://accounts.google.com.evil.test/x"}"#),
        None
    );
    assert_eq!(
        gemini_validation_url(br#"{"error":{"message":"Verify your account to continue."}}"#),
        None
    );
    assert_eq!(gemini_validation_url(b"not json"), None);
}

#[test]
fn gemini_verification_challenge_requires_an_explicit_provider_message() {
    use crate::api::gateway::providers::gemini_verification::gemini_verification_challenge;

    assert!(gemini_verification_challenge(
            br#"{"error":{"code":403,"message":"Verify your account to continue.","status":"PERMISSION_DENIED"}}"#
        ));
    assert!(gemini_verification_challenge(
        b"Please verify your account to continue."
    ));
    assert!(!gemini_verification_challenge(
            br#"{"error":{"message":"Project lacks model permission"},"debug":"Verify your account to continue."}"#
        ));
    assert!(!gemini_verification_challenge(
        br#"{"error":{"status":"PERMISSION_DENIED"}}"#
    ));
}

#[tokio::test]
async fn playground_gemini_disconnect_closes_upstream_without_waiting_for_next_chunk() {
    use axum::{Router, routing::get};
    use std::{sync::Arc, time::Duration};
    use tokio::{
        net::TcpListener,
        sync::{Mutex, mpsc},
    };
    use tokio_stream::wrappers::ReceiverStream;

    let (tx, rx) = mpsc::channel::<Result<axum::body::Bytes, std::io::Error>>(1);
    tx.send(Ok(axum::body::Bytes::from_static(
        b"data: {\"response\":{\"candidates\":[]}}\n\n",
    )))
    .await
    .unwrap();
    let receiver = Arc::new(Mutex::new(Some(rx)));
    let server = Router::new().route(
        "/stream",
        get(move || {
            let receiver = receiver.clone();
            async move {
                axum::body::Body::from_stream(ReceiverStream::new(
                    receiver.lock().await.take().unwrap(),
                ))
            }
        }),
    );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/stream", listener.local_addr().unwrap());
    let task = tokio::spawn(async move { axum::serve(listener, server).await.unwrap() });
    let upstream = reqwest::get(url).await.unwrap();
    let response = crate::api::gateway::providers::gemini::gemini_upstream_response(
        upstream,
        crate::api::gateway::providers::gemini::GeminiOperation::StreamGenerate,
        true,
    )
    .await
    .unwrap();
    drop(response);
    tokio::time::timeout(Duration::from_secs(2), tx.closed())
        .await
        .expect("cancel must drop the upstream stream");
    task.abort();
}

use axum::{
    body::Bytes,
    http::{HeaderMap, HeaderValue},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde_json::{Value, json};
use uuid::Uuid;

use crate::utils::provider_catalogue::AgentProvider;

use crate::api::gateway::catalogue::{
    default_claude_model_catalogue, default_openai_model_catalogue,
    filter_current_live_model_catalogue, filter_current_live_model_response,
    intersect_live_catalogue, parse_claude_models_markdown, parse_openai_models_markdown,
};
use crate::api::gateway::keys::hash_gateway_key;
use crate::api::gateway::providers::gemini::{
    GeminiOperation, GeminiSseTransformer, antigravity_model_id, gemini_code_assist_request,
    gemini_model_catalogue, gemini_upstream_disposition, parse_gemini_operation,
    unwrap_gemini_response,
};
use crate::api::gateway::proxy::{
    UpstreamDisposition, chatgpt_account_id, ensure_claude_billing_header, grok_proxy_headers,
    merged_anthropic_beta, retry_delay, should_retry_same_candidate,
    strip_unsupported_codex_fields, upstream_disposition,
};
use crate::api::gateway::selection::rate_limit_cooldown;
use crate::api::gateway::usage::{MAX_USAGE_PAYLOAD_BYTES, TokenUsage, UsageObserver};

#[test]
fn usage_observer_reads_split_responses_event_without_counting_partial_streams() {
    let mut observer = UsageObserver::new(AgentProvider::Chatgpt, true);
    observer.push(
        b"data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,",
    );
    observer.push(b"\"output_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":3}}}}\n\n");
    assert_eq!(
        observer.finish_with_completion().1,
        Some(TokenUsage {
            input_tokens: Some(12),
            output_tokens: Some(7),
            cached_tokens: Some(3),
        })
    );

    let mut incomplete = UsageObserver::new(AgentProvider::Chatgpt, true);
    incomplete
        .push(b"data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":12}}\n\n");
    assert_eq!(incomplete.finish_with_completion().1, None);
}

#[test]
fn usage_observer_includes_claude_cached_input_and_final_output() {
    let mut observer = UsageObserver::new(AgentProvider::Claude, true);
    observer.push(b"data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":5,\"cache_read_input_tokens\":20,\"cache_creation_input_tokens\":10,\"output_tokens\":1}}}\n\n");
    observer.push(b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":8}}\n\n");
    observer.push(b"data: {\"type\":\"message_stop\"}\n\n");
    assert_eq!(
        observer.finish_with_completion().1,
        Some(TokenUsage {
            input_tokens: Some(35),
            output_tokens: Some(8),
            cached_tokens: Some(20),
        })
    );
}

#[test]
fn usage_observer_reads_gemini_metadata_and_bounded_json() {
    let mut observer = UsageObserver::new(AgentProvider::Gemini, true);
    observer.push(b"data: {\"response\":{\"candidates\":[{\"finishReason\":\"STOP\"}],\"usageMetadata\":{\"promptTokenCount\":10,\"totalTokenCount\":18,\"candidatesTokenCount\":5,\"cachedContentTokenCount\":4}}}\n\n");
    assert_eq!(
        observer.finish_with_completion().1,
        Some(TokenUsage {
            input_tokens: Some(10),
            output_tokens: Some(8),
            cached_tokens: Some(4),
        })
    );

    let mut oversized = UsageObserver::new(AgentProvider::Grok, false);
    oversized.push(&vec![b'x'; MAX_USAGE_PAYLOAD_BYTES + 1]);
    assert!(oversized.pending.is_empty());
    assert_eq!(oversized.finish_with_completion().1, None);
}

#[test]
fn usage_observer_requires_provider_completion_not_just_stream_end() {
    let mut failed_response = UsageObserver::new(AgentProvider::Chatgpt, true);
    failed_response.push(b"data: {\"type\":\"response.incomplete\"}\n\ndata: [DONE]\n\n");
    assert_eq!(failed_response.finish_with_completion(), (false, None));

    let mut partial_gemini = UsageObserver::new(AgentProvider::Gemini, true);
    partial_gemini.push(b"data: {\"response\":{\"usageMetadata\":{\"promptTokenCount\":12}}}\n\n");
    assert_eq!(partial_gemini.finish_with_completion(), (false, None));

    let mut limited_claude = UsageObserver::new(AgentProvider::Claude, true);
    limited_claude.push(b"data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"max_tokens\"}}\n\ndata: {\"type\":\"message_stop\"}\n\n");
    assert_eq!(limited_claude.finish_with_completion(), (false, None));

    let mut completed_chat = UsageObserver::new(AgentProvider::Deepseek, true);
    completed_chat.push(b"data: {\"choices\":[{\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n");
    assert_eq!(completed_chat.finish_with_completion(), (true, None));
}

#[test]
fn gateway_key_hash_does_not_store_the_plaintext() {
    let key = "hw_live_test-secret-that-is-long-enough";
    let hash = hash_gateway_key(key);
    assert_ne!(hash, key.as_bytes());
    assert_eq!(hash.len(), 32);
}

#[test]
fn codex_subscription_requests_drop_the_unsupported_output_limit() {
    let body =
        Bytes::from_static(br#"{"model":"gpt-5.6-sol","input":"hello","max_output_tokens":32000}"#);
    let normalized = strip_unsupported_codex_fields(body);
    let payload: serde_json::Value = serde_json::from_slice(&normalized).unwrap();

    assert_eq!(payload["model"], "gpt-5.6-sol");
    assert_eq!(payload["input"], "hello");
    assert!(payload.get("max_output_tokens").is_none());
}

#[test]
fn grok_proxy_headers_match_the_current_subscription_contract() {
    let body = Bytes::from_static(br#"{"model":"grok-4.6","input":"hello"}"#);
    let headers = grok_proxy_headers("1.0.30", &body, true);

    assert_eq!(headers["x-xai-token-auth"], "xai-grok-cli");
    assert_eq!(headers["x-authenticateresponse"], "authenticate-response");
    assert_eq!(headers["x-grok-client-identifier"], "hub-william");
    assert_eq!(headers["x-grok-client-mode"], "headless");
    assert_eq!(headers["x-grok-client-version"], "1.0.30");
    assert_eq!(headers["x-grok-model-override"], "grok-4.6");
    assert_eq!(headers["x-grok-conv-id"], headers["x-grok-session-id"]);
    assert!(Uuid::parse_str(headers["x-grok-req-id"].to_str().unwrap()).is_ok());
}

#[test]
fn claude_oauth_beta_is_preserved_without_duplication() {
    let mut headers = HeaderMap::new();
    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("prompt-caching-2024-07-31"),
    );
    let merged = merged_anthropic_beta(&headers);
    let text = merged.to_str().unwrap();
    assert!(text.contains("prompt-caching-2024-07-31"));
    assert!(text.contains("claude-code-20250219"));
    assert!(text.contains("oauth-2025-04-20"));

    headers.insert(
        "anthropic-beta",
        HeaderValue::from_static("oauth-2025-04-20"),
    );
    let merged = merged_anthropic_beta(&headers);
    let text = merged.to_str().unwrap();
    assert!(text.contains("claude-code-20250219"));
    assert!(text.contains("oauth-2025-04-20"));
    assert_eq!(text.matches("oauth-2025-04-20").count(), 1);
}

#[test]
fn claude_billing_header_is_injected_into_system_prompt() {
    let empty_body = Bytes::from_static(br#"{"model":"claude-opus-5","messages":[]}"#);
    let with_billing = ensure_claude_billing_header(empty_body, "2.1.223");
    let parsed: Value = serde_json::from_slice(&with_billing).unwrap();
    let system_arr = parsed["system"].as_array().unwrap();
    assert!(
        system_arr[0]["text"]
            .as_str()
            .unwrap()
            .contains("x-anthropic-billing-header: cc_version=2.1.223.bd6; cc_entrypoint=sdk-cli;")
    );

    let string_body = Bytes::from_static(
        br#"{"model":"claude-opus-5","system":"You are helpful.","messages":[]}"#,
    );
    let with_billing = ensure_claude_billing_header(string_body, "2.1.223");
    let parsed: Value = serde_json::from_slice(&with_billing).unwrap();
    let system_str = parsed["system"].as_str().unwrap();
    assert!(system_str.starts_with(
            "x-anthropic-billing-header: cc_version=2.1.223.bd6; cc_entrypoint=sdk-cli;\n\nYou are helpful."
        ));
}

#[test]
fn chatgpt_account_id_can_be_read_from_trusted_token_claims() {
    let claims = json!({
        "https://api.openai.com/auth.chatgpt_account_id": "account-123"
    });
    let jwt = format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    assert_eq!(
        chatgpt_account_id(&json!({ "access_token": jwt })),
        Some("account-123".to_owned())
    );
}

#[test]
fn rate_limited_pools_cool_down_for_thirty_minutes() {
    assert_eq!(rate_limit_cooldown().num_minutes(), 30);
}

#[test]
fn upstream_authentication_and_rate_limits_advance_to_the_next_pool() {
    assert_eq!(
        upstream_disposition(axum::http::StatusCode::UNAUTHORIZED),
        UpstreamDisposition::Reauthorize
    );
    assert_eq!(
        upstream_disposition(axum::http::StatusCode::TOO_MANY_REQUESTS),
        UpstreamDisposition::RateLimit
    );
    assert_eq!(
        upstream_disposition(axum::http::StatusCode::BAD_REQUEST),
        UpstreamDisposition::Return
    );
}

#[test]
fn gemini_forbidden_is_account_failover_without_changing_other_client_errors() {
    use axum::http::StatusCode;

    assert_eq!(
        gemini_upstream_disposition(StatusCode::FORBIDDEN),
        UpstreamDisposition::NextPool
    );
    assert_eq!(
        upstream_disposition(StatusCode::FORBIDDEN),
        UpstreamDisposition::Return
    );
    assert_eq!(
        gemini_upstream_disposition(StatusCode::BAD_REQUEST),
        UpstreamDisposition::Return
    );
    assert_eq!(
        gemini_upstream_disposition(StatusCode::UNAUTHORIZED),
        UpstreamDisposition::Reauthorize
    );
}

#[test]
fn transient_upstream_statuses_are_retried_before_returning_to_the_client() {
    for status in [
        axum::http::StatusCode::REQUEST_TIMEOUT,
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        axum::http::StatusCode::BAD_GATEWAY,
        axum::http::StatusCode::SERVICE_UNAVAILABLE,
        axum::http::StatusCode::GATEWAY_TIMEOUT,
    ] {
        assert_eq!(
            upstream_disposition(status),
            UpstreamDisposition::RetryTransient
        );
    }
}

#[test]
fn transient_retries_preserve_attempts_for_remaining_candidates() {
    assert!(should_retry_same_candidate(1, 1, 0, 3));
    assert!(!should_retry_same_candidate(2, 2, 0, 3));
    assert!(!should_retry_same_candidate(3, 1, 1, 3));
    assert!(!should_retry_same_candidate(4, 1, 2, 3));

    assert!(should_retry_same_candidate(1, 1, 0, 1));
    assert!(should_retry_same_candidate(2, 2, 0, 1));
    assert!(should_retry_same_candidate(3, 3, 0, 1));
    assert!(!should_retry_same_candidate(4, 4, 0, 1));
}

#[test]
fn retry_backoff_is_bounded_and_honors_short_retry_after_values() {
    let first = retry_delay(1, None);
    assert!((400..=600).contains(&first.as_millis()));

    let third = retry_delay(3, None);
    assert!((1_600..=2_000).contains(&third.as_millis()));

    let mut headers = HeaderMap::new();
    headers.insert("retry-after", HeaderValue::from_static("1"));
    assert!(retry_delay(1, Some(&headers)).as_millis() >= 1_000);
    headers.insert("retry-after", HeaderValue::from_static("60"));
    assert_eq!(retry_delay(1, Some(&headers)).as_millis(), 2_000);
}

#[test]
fn gemini_native_requests_are_wrapped_for_code_assist() {
    let wrapped = gemini_code_assist_request(
        "gemini-3.8-flash-medium",
        "project-123",
        GeminiOperation::Generate,
        &json!({"contents": [{"role": "user", "parts": [{"text": "Hi"}]}]}),
    );
    assert_eq!(wrapped["model"], "gemini-3.8-flash-medium");
    assert_eq!(wrapped["project"], "project-123");
    assert_eq!(wrapped["request"]["contents"][0]["role"], "user");
    assert!(
        wrapped["requestId"]
            .as_str()
            .is_some_and(|request_id| request_id.starts_with("agent/"))
    );
    assert_eq!(wrapped["userAgent"], "antigravity");
    assert_eq!(wrapped["requestType"], "agent");
}

#[test]
fn gemini_native_base_models_map_to_current_agy_effort_ids() {
    assert_eq!(
        antigravity_model_id(
            "gemini-4-argon",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": -1}}})
        ),
        "gemini-4-argon-high"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-4-argon",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 4000}}})
        ),
        "gemini-4-argon-medium"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-4-argon",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 1000}}})
        ),
        "gemini-4-argon-low"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-3.8-flash",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": -1}}})
        ),
        "gemini-3.8-flash-high"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-3.8-flash",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 4000}}})
        ),
        "gemini-3.8-flash-medium"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-3.8-flash",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 1000}}})
        ),
        "gemini-3.8-flash-low"
    );
    assert_eq!(
        antigravity_model_id("gemini-3.1-pro-preview-customtools", &json!({})),
        "gemini-3.1-pro-high"
    );
    assert_eq!(
        antigravity_model_id(
            "gemini-3.1-pro-preview",
            &json!({"generationConfig": {"thinkingConfig": {"thinkingBudget": 1024}}})
        ),
        "gemini-3.1-pro-low"
    );
}

#[test]
fn gemini_model_catalogue_keeps_only_current_antigravity_models() {
    let catalogue = gemini_model_catalogue(&json!({
        "models": {
            "gemini-3.8-flash-high": {"displayName": "Gemini 3.8 Flash (High)"},
            "gemini-3.7-flash-medium": {"displayName": "Gemini 3.7 Flash (Medium)"},
            "gemini-3.6-flash-low": {"displayName": "Gemini 3.6 Flash (Low)", "isInternal": true},
            "gemini-2.5-pro": {"displayName": "Gemini 2.5 Pro"}
        }
    }));
    assert_eq!(catalogue["object"], "list");
    assert_eq!(catalogue["data"].as_array().unwrap().len(), 2);
    assert_eq!(catalogue["data"][0]["id"], "gemini-3.8-flash-high");
    assert_eq!(catalogue["data"][1]["id"], "gemini-3.7-flash-medium");
}

#[test]
fn gemini_route_parser_accepts_only_native_content_operations() {
    assert!(matches!(
        parse_gemini_operation("gemini-3.1-pro-preview:generateContent"),
        Ok(("gemini-3.1-pro-preview", GeminiOperation::Generate))
    ));
    assert!(parse_gemini_operation("gemini-3.1-pro-preview:delete").is_err());
    assert!(parse_gemini_operation("nested/model:generateContent").is_err());
}

#[test]
fn gemini_code_assist_responses_are_unwrapped_for_agy() {
    let response = unwrap_gemini_response(json!({
        "response": {"candidates": [], "usageMetadata": {"promptTokenCount": 2}},
        "traceId": "trace-123"
    }));
    assert_eq!(response["responseId"], "trace-123");
    assert_eq!(response["usageMetadata"]["promptTokenCount"], 2);
}

#[test]
fn gemini_sse_transformer_handles_split_events() {
    let mut transformer = GeminiSseTransformer::default();
    assert!(
        transformer
            .push(br#"data: {"response":{"candidates"#)
            .is_empty()
    );
    let output = transformer.push(b"\":[]},\"traceId\":\"trace-1\"}\n\n");
    let text = String::from_utf8(output.to_vec()).unwrap();
    assert!(text.contains(r#""responseId":"trace-1""#));
    assert!(!text.contains(r#""response":{"#));
}

#[test]
fn gemini_sse_transformer_normalizes_crlf_event_boundaries() {
    let mut transformer = GeminiSseTransformer::default();
    let output = transformer
        .push(b"data: {\"response\":{\"candidates\":[]},\"traceId\":\"trace-1\"}\r\n\r\n");
    let text = String::from_utf8(output.to_vec()).unwrap();
    assert!(!text.contains('\r'));
    assert!(text.ends_with("\n\n"));
}

#[test]
fn default_openai_model_catalogue_includes_current_rollout_models() {
    let catalogue = default_openai_model_catalogue();
    assert_eq!(catalogue["object"], "list");
    let models = catalogue["data"].as_array().unwrap();
    assert_eq!(models.len(), 6);
    assert_eq!(models[0]["id"], "gpt-6-astra");
    assert_eq!(models[1]["id"], "gpt-6-sol");
    assert_eq!(models[2]["id"], "gpt-6-luna");
    assert_eq!(models[3]["id"], "gpt-5.6-sol");
    assert_eq!(models[4]["id"], "gpt-5.6-terra");
    assert_eq!(models[5]["id"], "gpt-5.6-luna");
}

#[test]
fn subscriber_catalogue_keeps_only_models_the_account_lists() {
    let current = default_openai_model_catalogue();
    let live = json!({ "models": [
            { "slug": "gpt-6-sol", "visibility": "list" },
            { "slug": "gpt-5.6-luna" },
            { "slug": "gpt-6-luna", "visibility": "hide" },
            { "slug": "gpt-6-astra", "active": false },
            { "slug": "legacy-model" }
        ] });
    let filtered = intersect_live_catalogue(&current, &live).unwrap();
    let ids: Vec<&str> = filtered["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|model| model["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["gpt-6-sol", "gpt-5.6-luna"]);
    assert_eq!(filtered["object"], "list");
}

#[test]
fn subscriber_catalogue_keeps_current_metadata_for_claude_models() {
    let current = default_claude_model_catalogue();
    let live = json!({ "data": [{ "id": "claude-sonnet-5" }, { "id": "claude-old" }] });
    let filtered = intersect_live_catalogue(&current, &live).unwrap();
    let models = filtered["data"].as_array().unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0]["id"], "claude-sonnet-5");
    assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
}

#[test]
fn subscriber_catalogue_is_empty_when_the_account_lists_nothing_current() {
    let current = default_claude_model_catalogue();
    let filtered = intersect_live_catalogue(&current, &json!({ "data": [] })).unwrap();
    assert!(filtered["data"].as_array().unwrap().is_empty());
    assert!(intersect_live_catalogue(&current, &json!({})).is_err());
}

#[test]
fn default_claude_model_catalogue_includes_current_models_and_sonnet_effort() {
    let catalogue = default_claude_model_catalogue();
    assert_eq!(catalogue["object"], "list");
    let models = catalogue["data"].as_array().unwrap();
    assert_eq!(models.len(), 4);
    assert_eq!(models[0]["id"], "claude-fable-5-1");
    assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
    assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
    assert_eq!(models[1]["id"], "claude-opus-5-5");
    assert_eq!(models[1]["display_name"], "Claude Opus 5.5");
    assert_eq!(models[1]["capabilities"]["effort"]["supported"], true);
    assert_eq!(models[2]["id"], "claude-sonnet-5");
    assert_eq!(models[2]["capabilities"]["effort"]["supported"], true);
    assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
}

#[test]
fn parse_claude_models_markdown_extracts_models_and_effort() {
    let markdown = r#"
## Compare models

| Feature | Claude Fable 5.1 | Claude Opus 5.5 | Claude Sonnet 5 | Claude Haiku 4.5 |
| :--- | :--- | :--- | :--- | :--- |
| Claude API ID | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5` | `claude-haiku-4-5-20251001` |
| [Default effort](https://platform.claude.com/effort) | `high` | `medium` | `high` | Not supported |
| Claude API alias | `claude-fable-5-1` | `claude-opus-5-5` | `claude-sonnet-5` | `claude-haiku-4-5` |

Legacy models (still available): [Claude Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview), [Claude Opus 5](https://platform.claude.com/docs/en/models/opus-5/overview), [Claude Opus 4.8](https://platform.claude.com/docs/en/models/opus-4-8/overview).
"#;
    let parsed = parse_claude_models_markdown(markdown).unwrap();
    assert_eq!(parsed["object"], "list");
    let models = parsed["data"].as_array().unwrap();
    assert_eq!(models[0]["id"], "claude-fable-5-1");
    assert_eq!(models[0]["display_name"], "Claude Fable 5.1");
    assert_eq!(models[0]["capabilities"]["effort"]["supported"], true);
    assert_eq!(models[1]["id"], "claude-opus-5-5");
    assert_eq!(models[1]["display_name"], "Claude Opus 5.5");
    assert_eq!(models[1]["capabilities"]["effort"]["supported"], true);
    assert_eq!(models[3]["id"], "claude-haiku-4-5-20251001");
    assert!(models[3].get("capabilities").is_none());
    assert_eq!(models.len(), 4);
}

#[test]
fn parse_openai_models_markdown_keeps_recommended_and_rollout_models() {
    let markdown = r#"
## Recommended models

GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna remain available during the rollout.

<ModelDetails
  name="gpt-6-astra"
  slug="gpt-6-astra"
/>
<ModelDetails
  name="gpt-6-sol"
  slug="gpt-6-sol"
/>
<ModelDetails
  name="gpt-6-luna"
  slug="gpt-6-luna"
/>

## Other models

<ModelDetails name="gpt-5.5" slug="gpt-5.5" />

## Deprecated Codex models

The `gpt-5.4` and `gpt-5.3-codex` models have retired.
"#;
    let parsed = parse_openai_models_markdown(markdown).unwrap();
    assert_eq!(parsed["object"], "list");
    let models = parsed["data"].as_array().unwrap();
    assert_eq!(models.len(), 6);
    assert_eq!(models[0]["id"], "gpt-6-astra");
    assert_eq!(models[0]["name"], "GPT-6 Astra");
    assert_eq!(models[1]["id"], "gpt-6-sol");
    assert_eq!(models[2]["id"], "gpt-6-luna");
    assert_eq!(models[3]["id"], "gpt-5.6-sol");
    assert_eq!(models[4]["id"], "gpt-5.6-terra");
    assert_eq!(models[5]["id"], "gpt-5.6-luna");
    assert!(
        parse_openai_models_markdown(
            "## Browse our full catalog of models\n- [GPT-5.5](/api/docs/models/gpt-5.5.md)"
        )
        .is_none()
    );
}

#[test]
fn live_deepseek_and_grok_catalogues_drop_retired_aliases() {
    let mut deepseek = json!({"data": [
        {"id": "deepseek-flash"},
        {"id": "deepseek-v4-flash"},
        {"id": "deepseek-v4-pro"}
    ]});
    filter_current_live_model_catalogue(&mut deepseek, AgentProvider::Deepseek).unwrap();
    assert_eq!(deepseek["data"].as_array().unwrap().len(), 2);
    assert_eq!(deepseek["data"][0]["id"], "deepseek-flash");
    assert_eq!(deepseek["data"][1]["id"], "deepseek-v4-pro");

    let mut grok = json!({"data": [
        {"id": "grok-4.7"},
        {"id": "grok-4.2"},
        {"id": "grok-build"}
    ]});
    filter_current_live_model_catalogue(&mut grok, AgentProvider::Grok).unwrap();
    assert_eq!(grok["data"].as_array().unwrap().len(), 1);
    assert_eq!(grok["data"][0]["id"], "grok-4.7");
}

#[tokio::test]
async fn filtered_live_catalogue_keeps_upstream_status_and_non_body_headers() {
    let response = axum::response::Response::builder()
        .status(axum::http::StatusCode::PARTIAL_CONTENT)
        .header("x-request-id", "upstream-request")
        .header(axum::http::header::CONTENT_LENGTH, "999")
        .body(axum::body::Body::from(
            r#"{"data":[{"id":"grok-4.7"},{"id":"grok-build"}]}"#,
        ))
        .unwrap();
    let filtered = filter_current_live_model_response(response, AgentProvider::Grok)
        .await
        .unwrap();
    assert_eq!(filtered.status(), axum::http::StatusCode::PARTIAL_CONTENT);
    assert_eq!(filtered.headers()["x-request-id"], "upstream-request");
    assert!(
        !filtered
            .headers()
            .contains_key(axum::http::header::CONTENT_LENGTH)
    );
    let body = axum::body::to_bytes(filtered.into_body(), 1024)
        .await
        .unwrap();
    let payload: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(payload["data"].as_array().unwrap().len(), 1);
    assert_eq!(payload["data"][0]["id"], "grok-4.7");
}
