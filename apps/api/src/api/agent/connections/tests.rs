use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use axum::{
    Form, Json, Router,
    http::HeaderMap,
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use reqwest::Url;
use serde_json::{Value, json};
use tokio::net::TcpListener;

use chrono::{Duration, Utc};

use crate::{
    api::agent::connections::{
        ACCOUNT_VERIFICATION_REQUIRED_MESSAGE, ANTIGRAVITY_CLIENT_VERSION, AgentProvider,
        RECOVERABLE_REAUTHORIZATION_MESSAGES,
        authorize::{
            AuthorizationSecret, CODEX_REDIRECT_URI, CODEX_SCOPES, GEMINI_SCOPES, GROK_SCOPES,
            exchange_gemini_code, gemini_code_assist_body, parse_callback_value,
            start_claude_authorization, start_codex_authorization, start_gemini_authorization,
            start_grok_authorization, validate_api_key_input, validate_prompt_url,
            validate_static_key,
        },
        metadata::{
            connection_metadata, fetch_claude_profile, mask_account_label,
            provider_account_identity, reauthorization_identity_matches,
        },
        refresh::{
            CredentialRefreshMode, next_regular_refresh_at, refresh_provider_token,
            refresh_requires_reauthorization, refresh_status_is_transient,
            should_refresh_credential,
        },
        token::{
            decrypt_json, encrypt_json, merge_token_response, provider_expiry_at, token_claims,
        },
    },
    core::AppConfig,
};

#[test]
fn authorization_secrets_are_encrypted_and_round_trip() {
    let key = [42_u8; 32];
    let secret = AuthorizationSecret::Grok {
        device_code: "device-secret".to_owned(),
        user_code: "ABCD-EFGH".to_owned(),
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH"
            .to_owned(),
    };
    let (ciphertext, nonce) = encrypt_json(&key, &secret).unwrap();
    assert!(!String::from_utf8_lossy(&ciphertext).contains("device-secret"));
    let decoded: AuthorizationSecret = decrypt_json(&key, &ciphertext, &nonce).unwrap();
    assert_eq!(
        serde_json::to_value(decoded).unwrap(),
        serde_json::to_value(secret).unwrap()
    );
}

#[tokio::test]
async fn claude_authorization_uses_pkce_and_official_manual_callback() {
    let state = crate::core::AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };
    let started = start_claude_authorization(&state).unwrap();
    let url = reqwest::Url::parse(&started.prompt_url).unwrap();
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(url.host_str(), Some("claude.com"));
    assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
    assert_eq!(
        query.get("redirect_uri").unwrap(),
        "https://platform.claude.com/oauth/code/callback"
    );
    assert!(started.requires_callback_url);
}

#[tokio::test]
async fn gemini_authorization_uses_agy_google_oauth_with_pkce() {
    let state = crate::core::AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };
    let started = start_gemini_authorization(&state).unwrap();
    let url = reqwest::Url::parse(&started.prompt_url).unwrap();
    let query = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();

    assert_eq!(url.host_str(), Some("accounts.google.com"));
    assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
    assert_eq!(query.get("scope").unwrap(), GEMINI_SCOPES);
    assert_eq!(query.get("access_type").unwrap(), "offline");
    assert_eq!(query.get("prompt").unwrap(), "consent");
    assert_eq!(
        query.get("redirect_uri").unwrap(),
        "https://antigravity.google/oauth-callback"
    );
    assert!(started.requires_callback_url);
}

#[tokio::test]
async fn claude_plan_is_read_from_the_oauth_profile_contract() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(None));
    let captured_request = captured.clone();
    let server = Router::new().route(
        "/api/oauth/profile",
        get(move |headers: HeaderMap| {
            let captured_request = captured_request.clone();
            async move {
                *captured_request.lock().unwrap() = Some(headers);
                Json(json!({
                    "organization": {
                        "organization_type": "claude_max",
                        "organization_rate_limit_tier": "default_claude_max_5x"
                    }
                }))
            }
        }),
    );
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await });
    let state = crate::core::AppState {
        config: AppConfig {
            claude_profile_url: format!("{origin}/api/oauth/profile"),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };
    let token = json!({ "access_token": "claude-access" });

    let profile = fetch_claude_profile(&state, &token).await.unwrap();
    server_task.abort();

    let headers = captured.lock().unwrap();
    let headers = headers.as_ref().unwrap();
    assert_eq!(headers["authorization"], "Bearer claude-access");
    assert_eq!(headers["cache-control"], "no-cache");
    assert_eq!(
        connection_metadata(AgentProvider::Claude, &token, Some(&profile)).1,
        Some("MAX".to_owned())
    );
}

#[test]
fn claude_profile_types_use_concise_plan_labels() {
    for (organization_type, label) in [
        ("claude_max", "MAX"),
        ("claude_pro", "Pro"),
        ("claude_team", "Team"),
        ("claude_enterprise", "Enterprise"),
    ] {
        let profile = json!({
            "organization": { "organization_type": organization_type }
        });
        assert_eq!(
            connection_metadata(
                AgentProvider::Claude,
                &json!({ "access_token": "token" }),
                Some(&profile)
            )
            .1,
            Some(label.to_owned())
        );
    }
}

#[tokio::test]
async fn gemini_token_exchange_sends_the_agy_client_secret() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(None));
    let captured_request = captured.clone();
    let captured_load_headers = Arc::new(Mutex::new(None));
    let load_headers = captured_load_headers.clone();
    let server = Router::new()
        .route(
            "/token",
            post(move |Form(form): Form<HashMap<String, String>>| {
                let captured_request = captured_request.clone();
                async move {
                    *captured_request.lock().unwrap() = Some(form);
                    Json(json!({
                        "access_token": "google-access-token",
                        "refresh_token": "google-refresh-token"
                    }))
                }
            }),
        )
        .route(
            "/userinfo",
            get(|| async { Json(json!({ "email": "owner@example.com" })) }),
        )
        .route(
            "/v1internal:loadCodeAssist",
            post(
                move |headers: HeaderMap, Json(body): Json<Value>| async move {
                    *load_headers.lock().unwrap() = Some((headers, body));
                    Json(json!({
                        "cloudaicompanionProject": "subscription-project",
                        "currentTier": { "name": "Google AI Pro" }
                    }))
                },
            ),
        );
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

    let state = crate::core::AppState {
        config: AppConfig {
            gemini_client_id: "agy-client-id".to_owned(),
            gemini_client_secret: "agy-client-secret".to_owned(),
            gemini_code_assist_url: issuer.clone(),
            gemini_token_url: format!("{issuer}/token"),
            gemini_userinfo_url: format!("{issuer}/userinfo"),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };

    let token = exchange_gemini_code(
        &state,
        "one-time-code",
        "pkce-code-verifier",
        "https://antigravity.google/oauth-callback",
    )
    .await
    .unwrap();
    server_task.abort();

    let captured = captured.lock().unwrap();
    let form = captured.as_ref().unwrap();
    assert_eq!(form.get("client_id").unwrap(), "agy-client-id");
    assert_eq!(form.get("client_secret").unwrap(), "agy-client-secret");
    assert_eq!(form.get("code_verifier").unwrap(), "pkce-code-verifier");
    let load_headers = captured_load_headers.lock().unwrap();
    let (headers, body) = load_headers.as_ref().unwrap();
    assert_eq!(headers["user-agent"], ANTIGRAVITY_CLIENT_VERSION);
    assert_eq!(body, &json!({ "metadata": { "ideType": "ANTIGRAVITY" } }));
    assert_eq!(
        token.get("cloudaicompanion_project").unwrap(),
        "subscription-project"
    );
}

#[test]
fn gemini_code_assist_refresh_matches_the_current_agy_metadata_shape() {
    assert_eq!(
        gemini_code_assist_body(Some("aicode-consumers")),
        json!({
            "cloudaicompanionProject": "aicode-consumers",
            "metadata": { "ideType": "ANTIGRAVITY" }
        })
    );
}

#[tokio::test]
async fn gemini_token_refresh_sends_the_agy_client_secret() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let captured = Arc::new(Mutex::new(None));
    let captured_request = captured.clone();
    let server = Router::new().route(
        "/token",
        post(move |Form(form): Form<HashMap<String, String>>| {
            let captured_request = captured_request.clone();
            async move {
                *captured_request.lock().unwrap() = Some(form);
                Json(json!({ "access_token": "refreshed-access-token" }))
            }
        }),
    );
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

    let state = crate::core::AppState {
        config: AppConfig {
            gemini_client_id: "agy-client-id".to_owned(),
            gemini_client_secret: "agy-client-secret".to_owned(),
            gemini_token_url: format!("{issuer}/token"),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };

    let refreshed = match refresh_provider_token(
        &state,
        AgentProvider::Gemini,
        "google-refresh-token",
        &json!({}),
    )
    .await
    {
        Ok(token) => token,
        Err(_) => panic!("Gemini token refresh should succeed"),
    };
    server_task.abort();

    let captured = captured.lock().unwrap();
    let form = captured.as_ref().unwrap();
    assert_eq!(form.get("grant_type").unwrap(), "refresh_token");
    assert_eq!(form.get("client_secret").unwrap(), "agy-client-secret");
    assert_eq!(
        refreshed.get("access_token").unwrap(),
        "refreshed-access-token"
    );
}

#[tokio::test]
async fn grok_device_authorization_uses_the_current_oauth_contract() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let issuer = format!("http://{}", listener.local_addr().unwrap());
    let prompt_url = format!("{issuer}/oauth2/device?user_code=ABCD-EFGH");
    let captured = Arc::new(Mutex::new(None));
    let captured_request = captured.clone();
    let response_prompt_url = prompt_url.clone();
    let server = Router::new().route(
        "/oauth2/device/code",
        post(
            move |headers: HeaderMap, Form(form): Form<HashMap<String, String>>| {
                let captured_request = captured_request.clone();
                let response_prompt_url = response_prompt_url.clone();
                async move {
                    *captured_request.lock().unwrap() = Some((headers, form));
                    Json(json!({
                        "device_code": "device-secret",
                        "user_code": "ABCD-EFGH",
                        "verification_uri": response_prompt_url.clone(),
                        "verification_uri_complete": response_prompt_url,
                        "expires_in": 900,
                        "interval": 5
                    }))
                }
            },
        ),
    );
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await });

    let config = AppConfig {
        grok_client_id: "current-client-id".to_owned(),
        grok_client_version: "9.8.7".to_owned(),
        grok_issuer: issuer,
        ..AppConfig::default()
    };
    let state = crate::core::AppState {
        config,
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };

    let started = start_grok_authorization(&state).await.unwrap();
    server_task.abort();

    let captured = captured.lock().unwrap();
    let (headers, form) = captured.as_ref().unwrap();
    assert_eq!(form.get("client_id").unwrap(), "current-client-id");
    assert_eq!(form.get("scope").unwrap(), GROK_SCOPES);
    assert_eq!(
        GROK_SCOPES,
        "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write"
    );
    assert_eq!(headers["x-grok-client-version"], "9.8.7");
    assert_eq!(headers["x-grok-client-surface"], "grok-build");
    assert_eq!(headers["user-agent"], "xai-grok-build/9.8.7");
    assert_eq!(started.prompt_url, prompt_url);
    assert_eq!(started.user_code.as_deref(), Some("ABCD-EFGH"));
    assert!(!started.requires_callback_url);
}

#[test]
fn grok_device_prompt_is_restricted_to_the_official_account_origin() {
    assert!(
        validate_prompt_url(
            "https://auth.x.ai",
            "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH"
        )
        .is_ok()
    );
    assert!(
        validate_prompt_url(
            "https://auth.x.ai",
            "https://accounts.x.ai.evil.example/oauth2/device"
        )
        .is_err()
    );
}

#[test]
fn callback_parser_accepts_urls_and_claude_code_state_pairs() {
    assert_eq!(
        parse_callback_value(
            "https://platform.claude.com/oauth/code/callback?code=abc&state=state-1"
        )
        .unwrap(),
        ("abc".to_owned(), Some("state-1".to_owned()))
    );
    assert_eq!(
        parse_callback_value("abc#state-1").unwrap(),
        ("abc".to_owned(), Some("state-1".to_owned()))
    );
}

#[tokio::test]
async fn codex_browser_authorization_uses_the_official_local_callback_contract() {
    let state = crate::core::AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };
    let started = start_codex_authorization(&state).unwrap();
    let url = Url::parse(&started.prompt_url).unwrap();
    let query = url.query_pairs().collect::<HashMap<_, _>>();

    assert_eq!(url.path(), "/oauth/authorize");
    assert_eq!(query.get("redirect_uri").unwrap(), CODEX_REDIRECT_URI);
    assert_eq!(query.get("scope").unwrap(), CODEX_SCOPES);
    assert_eq!(query.get("code_challenge_method").unwrap(), "S256");
    assert!(started.requires_callback_url);
    assert_eq!(started.user_code, None);
}

#[test]
fn account_labels_are_masked_before_browser_storage() {
    assert_eq!(
        mask_account_label("10279579+maplenorth@utc2eduvn.onmicrosoft.com"),
        "10**579@utc**.com"
    );
    assert_eq!(mask_account_label("duy@example.com"), "du**y@exa**.com");
    assert_eq!(mask_account_label("ab@x.dev"), "ab**@x**.dev");
    assert_eq!(mask_account_label("not-an-email"), "connected account");
    assert_eq!(json!({ "masked": true })["masked"], true);
}

#[test]
fn deepseek_api_keys_are_validated_without_exposing_the_secret() {
    assert_eq!(
        validate_api_key_input("  sk-deepseek-secret-123456  ").unwrap(),
        "sk-deepseek-secret-123456"
    );
    assert!(validate_api_key_input("short").is_err());
    assert!(validate_api_key_input("sk-deepseek secret 123456").is_err());

    let (label, plan) = connection_metadata(
        AgentProvider::Deepseek,
        &json!({
            "access_token": "sk-do-not-display",
            "api_key_last_four": "3456",
            "plan": "API"
        }),
        None,
    );
    assert_eq!(label.as_deref(), Some("••••3456"));
    assert_eq!(plan.as_deref(), Some("API"));
}

#[tokio::test]
async fn deepseek_api_key_validation_uses_bearer_auth_on_the_models_endpoint() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let server = Router::new().route(
        "/models",
        get(|headers: HeaderMap| async move {
            assert_eq!(
                headers.get("authorization").unwrap(),
                "Bearer sk-deepseek-secret-123456"
            );
            Json(json!({ "object": "list", "data": [] }))
        }),
    );
    let server_task = tokio::spawn(async move { axum::serve(listener, server).await });
    let state = crate::core::AppState {
        config: AppConfig {
            deepseek_api_url: api_url,
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    };

    validate_static_key(&state, AgentProvider::Deepseek, "sk-deepseek-secret-123456")
        .await
        .unwrap();
    server_task.abort();
}

#[test]
fn provider_identity_metadata_can_be_read_from_trusted_token_claims() {
    let claims = json!({
        "email": "owner@example.com",
        "https://api.openai.com/auth.chatgpt_plan_type": "plus"
    });
    let token = format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );

    assert_eq!(token_claims(&json!({ "id_token": token })), Some(claims));
}

#[test]
fn provider_account_identity_prefers_stable_ids_and_normalizes_email() {
    let claims = json!({
        "email": "OTHER@example.com",
        "sub": "personal-user-123",
        "https://api.openai.com/auth.chatgpt_account_id": "account-123"
    });
    let token = format!(
        "header.{}.signature",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
    );
    assert_eq!(
        provider_account_identity(AgentProvider::Chatgpt, &json!({ "id_token": token }), None),
        Some("chatgpt:sub:personal-user-123".to_owned())
    );
    assert_eq!(
        provider_account_identity(
            AgentProvider::Gemini,
            &json!({ "email": " Owner@Example.COM " }),
            None
        ),
        Some("email:owner@example.com".to_owned())
    );
}

#[test]
fn chatgpt_identity_never_uses_a_workspace_or_legacy_cache_alone() {
    assert_eq!(
        provider_account_identity(
            AgentProvider::Chatgpt,
            &json!({
                "account_id": "shared-workspace", "hub_account_identity": "id:shared-workspace"
            }),
            None
        ),
        None
    );
    for email in ["person+maple@example.test", "person+juliet@example.test"] {
        assert_eq!(
            provider_account_identity(
                AgentProvider::Chatgpt,
                &json!({
                    "account_id": "shared-workspace", "email": format!(" {} ", email.to_uppercase()),
                    "hub_account_identity": "id:shared-workspace"
                }),
                None
            ),
            Some(format!("chatgpt:email:{email}"))
        );
    }
}

#[test]
fn reauthorization_requires_the_exact_same_provider_identity() {
    assert!(reauthorization_identity_matches(
        Some("id:account-1"),
        Some("id:account-1")
    ));
    assert!(!reauthorization_identity_matches(
        Some("id:account-1"),
        Some("id:account-2")
    ));
    assert!(!reauthorization_identity_matches(
        Some("id:account-1"),
        None
    ));
}

#[test]
fn chatgpt_plan_is_read_from_the_live_nested_auth_claim() {
    for (raw_plan, displayed_plan) in [("plus", "Plus"), ("k12", "K12")] {
        let claims = json!({
            "email": "owner@example.com",
            "https://api.openai.com/auth": {
                "chatgpt_plan_type": raw_plan,
            }
        });
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );

        assert_eq!(
            connection_metadata(AgentProvider::Chatgpt, &json!({ "id_token": token }), None),
            (
                Some("ow**ner@exa**.com".to_owned()),
                Some(displayed_plan.to_owned())
            )
        );
    }
}

#[test]
fn grok_numeric_tiers_use_product_plan_labels() {
    for (tier, displayed_plan) in [(1, "Grok"), (5, "Heavy"), (6, "Lite"), (7, "Plus")] {
        let claims = json!({ "email": "owner@example.com", "tier": tier });
        let token = format!(
            "header.{}.signature",
            URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).unwrap())
        );

        assert_eq!(
            connection_metadata(AgentProvider::Grok, &json!({ "access_token": token }), None),
            (
                Some("ow**ner@exa**.com".to_owned()),
                Some(displayed_plan.to_owned())
            )
        );
    }
}

#[test]
fn refresh_rotation_replaces_returned_tokens_and_preserves_omitted_refresh_tokens() {
    let stored = json!({
        "access_token": "old-access",
        "refresh_token": "old-refresh",
        "expires_in": 300,
    });
    let rotated = merge_token_response(
        stored.clone(),
        json!({
            "access_token": "new-access",
            "refresh_token": "new-refresh",
            "expires_in": 600,
        }),
    );
    assert_eq!(rotated["refresh_token"], "new-refresh");
    let preserved = merge_token_response(
        stored,
        json!({ "access_token": "new-access", "expires_in": 600 }),
    );
    assert_eq!(preserved["refresh_token"], "old-refresh");
}

#[test]
fn rejected_refresh_tokens_require_provider_authorization() {
    assert!(refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::BAD_REQUEST,
        Some(&json!({ "error": "invalid_grant" }))
    ));
    assert!(refresh_requires_reauthorization(
        AgentProvider::Claude,
        reqwest::StatusCode::UNAUTHORIZED,
        Some(&json!({ "error": { "type": "invalid_grant" } }))
    ));
    assert!(refresh_requires_reauthorization(
        AgentProvider::Chatgpt,
        reqwest::StatusCode::UNAUTHORIZED,
        Some(&json!({ "error": {
                "type": "invalid_request_error",
                "code": "refresh_token_invalidated"
            } }))
    ));
    assert!(!refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::UNAUTHORIZED,
        Some(&json!({ "error": { "code": "refresh_token_invalidated" } }))
    ));
    assert!(!refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::UNAUTHORIZED,
        Some(&json!({ "error": "invalid_client" }))
    ));
    assert!(!refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::BAD_REQUEST,
        Some(&json!({ "error": "invalid_request" }))
    ));
    assert!(!refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::BAD_REQUEST,
        None
    ));
    assert!(!refresh_requires_reauthorization(
        AgentProvider::Gemini,
        reqwest::StatusCode::TOO_MANY_REQUESTS,
        Some(&json!({ "error": "invalid_grant" }))
    ));
}

fn at(rfc3339: &str) -> chrono::DateTime<Utc> {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .unwrap()
        .to_utc()
}

#[test]
fn scheduled_credentials_refresh_when_their_stored_time_arrives() {
    let now = at("2026-09-15T00:00:00Z");

    for mode in [CredentialRefreshMode::Stale, CredentialRefreshMode::Recover] {
        assert!(!should_refresh_credential(
            mode,
            None,
            now + Duration::seconds(1),
            now - Duration::hours(2),
            now,
        ));
        assert!(should_refresh_credential(
            mode,
            None,
            now,
            now - Duration::seconds(1),
            now,
        ));
        assert!(should_refresh_credential(
            mode,
            None,
            now - Duration::minutes(1),
            now,
            now,
        ));
    }
}

#[test]
fn a_refreshed_credential_is_due_again_exactly_thirty_minutes_later() {
    let now = at("2026-09-15T00:00:00Z");

    assert_eq!(
        next_regular_refresh_at(now, None),
        now + Duration::minutes(30)
    );
    // A refresh token that outlives the interval does not change it.
    assert_eq!(
        next_regular_refresh_at(now, Some(now + Duration::days(29))),
        now + Duration::minutes(30)
    );
}

#[test]
fn a_refresh_token_expiring_before_the_interval_is_refreshed_ahead_of_it() {
    let now = at("2026-09-15T00:00:00Z");

    // 26.5 minutes left: refresh five minutes before it ends.
    assert_eq!(
        next_regular_refresh_at(now, Some(now + Duration::seconds(1590))),
        now + Duration::seconds(1590 - 300)
    );
    // Closer than the margin, the next try is a minute away, not a loop.
    assert_eq!(
        next_regular_refresh_at(now, Some(now + Duration::minutes(3))),
        now + Duration::seconds(60)
    );
    // An expiry already behind us is ignored rather than refreshed around.
    assert_eq!(
        next_regular_refresh_at(now, Some(now - Duration::minutes(10))),
        now + Duration::minutes(30)
    );
}

#[test]
fn only_provider_unavailability_is_a_transient_refresh_failure() {
    use reqwest::StatusCode;

    for status in [
        StatusCode::INTERNAL_SERVER_ERROR,
        StatusCode::BAD_GATEWAY,
        StatusCode::SERVICE_UNAVAILABLE,
        StatusCode::GATEWAY_TIMEOUT,
        StatusCode::TOO_MANY_REQUESTS,
        StatusCode::REQUEST_TIMEOUT,
    ] {
        assert!(refresh_status_is_transient(status), "{status}");
    }
    for status in [
        StatusCode::BAD_REQUEST,
        StatusCode::UNAUTHORIZED,
        StatusCode::FORBIDDEN,
        StatusCode::NOT_FOUND,
    ] {
        assert!(!refresh_status_is_transient(status), "{status}");
    }
}

#[test]
fn nightly_refresh_skips_credentials_already_checked_today() {
    let day_start = chrono::DateTime::parse_from_rfc3339("2026-09-25T17:00:00Z")
        .unwrap()
        .to_utc();

    assert!(should_refresh_credential(
        CredentialRefreshMode::Nightly(day_start),
        None,
        day_start,
        day_start - chrono::Duration::seconds(1),
        day_start,
    ));
    assert!(!should_refresh_credential(
        CredentialRefreshMode::Nightly(day_start),
        None,
        day_start,
        day_start,
        day_start,
    ));
}

#[test]
fn request_refresh_still_uses_access_token_expiry() {
    let now = chrono::DateTime::parse_from_rfc3339("2026-09-15T00:00:00Z")
        .unwrap()
        .to_utc();

    assert!(!should_refresh_credential(
        CredentialRefreshMode::NearExpiry,
        Some(now + chrono::Duration::minutes(6)),
        now - chrono::Duration::hours(2),
        now - chrono::Duration::hours(2),
        now,
    ));
    assert!(should_refresh_credential(
        CredentialRefreshMode::NearExpiry,
        Some(now + chrono::Duration::minutes(5)),
        now,
        now,
        now,
    ));
}

#[test]
fn provider_reported_lifetime_must_be_positive() {
    let now = Utc::now();

    assert!(
        provider_expiry_at(&json!({ "expires_in": 3600 }), "expires_in")
            .is_some_and(|expires_at| expires_at > now + Duration::minutes(59))
    );
    assert_eq!(
        provider_expiry_at(
            &json!({ "refresh_token_expires_in": 0 }),
            "refresh_token_expires_in"
        ),
        None
    );
    assert_eq!(
        provider_expiry_at(
            &json!({ "refresh_token_expires_in": -60 }),
            "refresh_token_expires_in"
        ),
        None
    );
    assert_eq!(
        provider_expiry_at(&json!({}), "refresh_token_expires_in"),
        None
    );
    assert_eq!(
        provider_expiry_at(&json!({ "expires_in": "3600" }), "expires_in"),
        None
    );
}

#[test]
fn a_verification_challenge_is_recoverable_by_the_sweep() {
    let mode = CredentialRefreshMode::Recover;

    assert!(mode.records_scheduled_attempt());
    assert!(mode.restores_availability());
    assert!(RECOVERABLE_REAUTHORIZATION_MESSAGES.contains(&ACCOUNT_VERIFICATION_REQUIRED_MESSAGE));
}
