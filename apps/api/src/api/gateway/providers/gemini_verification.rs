//! Google account verification: reading the challenge from a rejected Gemini
//! response and probing whether an account still needs it.

use axum::{
    body::{Body, Bytes},
    http::StatusCode,
    response::Response,
};
use futures_util::{StreamExt, stream};
use serde_json::{Value, json};

use super::gemini::{GeminiOperation, current_gemini_project, gemini_code_assist_request};
use crate::{
    api::{
        agent::ANTIGRAVITY_CLIENT_VERSION,
        gateway::{proxy::should_forward_response_header, upstream_network_error},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

const MAX_GEMINI_ERROR_INSPECTION_BYTES: usize = 64 * 1024;

pub(crate) fn gemini_verification_challenge(body: &[u8]) -> bool {
    let parsed = serde_json::from_slice::<Value>(body).ok();
    let message = if let Some(payload) = parsed.as_ref() {
        payload
            .pointer("/error/message")
            .or_else(|| payload.get("message"))
            .and_then(Value::as_str)
    } else {
        std::str::from_utf8(body).ok()
    };
    message.is_some_and(|message| {
        message
            .to_ascii_lowercase()
            .contains("verify your account to continue")
    })
}

async fn gemini_error_prefix(
    upstream: &mut reqwest::Response,
) -> Result<(Vec<u8>, Option<Bytes>), reqwest::Error> {
    let mut prefix = Vec::new();
    while prefix.len() < MAX_GEMINI_ERROR_INSPECTION_BYTES {
        let Some(chunk) = upstream.chunk().await? else {
            break;
        };
        let take = chunk
            .len()
            .min(MAX_GEMINI_ERROR_INSPECTION_BYTES - prefix.len());
        prefix.extend_from_slice(&chunk[..take]);
        if take < chunk.len() {
            return Ok((prefix, Some(chunk.slice(take..))));
        }
    }
    Ok((prefix, None))
}

async fn gemini_response_requires_verification(upstream: &mut reqwest::Response) -> bool {
    gemini_error_prefix(upstream)
        .await
        .is_ok_and(|(prefix, _)| gemini_verification_challenge(&prefix))
}

/// The account-verification link inside a provider payload. Only Google's own
/// HTTPS address is accepted, so a provider response can never turn the Hub
/// into a redirect somewhere else.
pub(crate) fn gemini_validation_url(body: &[u8]) -> Option<String> {
    let payload = serde_json::from_slice::<Value>(body).ok()?;
    find_gemini_validation_url(&payload)
}

fn find_gemini_validation_url(value: &Value) -> Option<String> {
    match value {
        Value::Object(object) => object
            .get("validationUrl")
            .and_then(Value::as_str)
            .filter(|url| is_google_validation_url(url))
            .map(str::to_owned)
            .or_else(|| object.values().find_map(find_gemini_validation_url)),
        Value::Array(items) => items.iter().find_map(find_gemini_validation_url),
        _ => None,
    }
}

fn is_google_validation_url(url: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(url) else {
        return false;
    };
    url.scheme() == "https"
        && url
            .host_str()
            .is_some_and(|host| host == "google.com" || host.ends_with(".google.com"))
}

/// Ask Google for the verification link it wants the account owner to open. The
/// refusal body does not carry it, so this reads the Code Assist tier payload
/// that marks the account's free tier ineligible.
pub(crate) async fn gemini_account_validation_url(
    state: &AppState,
    access_token: &str,
    project: &str,
) -> Option<String> {
    let payload = crate::api::agent::load_gemini_code_assist(state, access_token, Some(project))
        .await
        .ok()?;
    find_gemini_validation_url(&payload)
}

pub(super) async fn inspect_gemini_forbidden_response(
    mut upstream: reqwest::Response,
) -> Result<(bool, Option<String>, Response), ApiError> {
    let status = upstream.status();
    let headers = upstream.headers().clone();
    let (prefix, overflow) = gemini_error_prefix(&mut upstream)
        .await
        .map_err(|error| upstream_network_error(AgentProvider::Gemini, error))?;
    let verification_required = gemini_verification_challenge(&prefix);
    let validation_url = gemini_validation_url(&prefix).filter(|_| verification_required);
    let mut response = Response::builder().status(status);
    for (name, value) in &headers {
        if should_forward_response_header(name) {
            response = response.header(name, value);
        }
    }
    let chunks = std::iter::once(Bytes::from(prefix)).chain(overflow);
    let body = Body::from_stream(
        stream::iter(chunks.map(Ok::<_, reqwest::Error>)).chain(upstream.bytes_stream()),
    );
    Ok((
        verification_required,
        validation_url,
        response.body(body).map_err(|_| ApiError::Internal)?,
    ))
}

/// A forced refresh checks that a newly rotated AGY token can discover models,
/// count tokens and make a minimal generation request through Code Assist. A
/// generic 403 is inconclusive; only Google's explicit account verification
/// challenge means the owner must reconnect.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum GeminiVerificationProbe {
    Verified,
    ReauthorizationRequired,
    Inconclusive,
}

pub(crate) async fn probe_gemini_account_verification(
    state: &AppState,
    access_token: &str,
    project: &str,
) -> GeminiVerificationProbe {
    // The gateway resolves the Code Assist project on every request, so the
    // probe has to test that same project: a stored project Code Assist has
    // moved on from would make the probe refuse a login real traffic serves.
    let resolved_project = current_gemini_project(state, access_token, project).await;
    if resolved_project != project {
        println!(
            "gemini verification probe: Code Assist reports a project other than the stored credential"
        );
    }
    let project = resolved_project.as_str();
    let models_url = format!(
        "{}/v1internal:fetchAvailableModels",
        state.config.gemini_code_assist_url.trim_end_matches('/')
    );
    let Ok(mut models) = state
        .gateway_http
        .post(models_url)
        .bearer_auth(access_token)
        .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
        .json(&json!({ "project": project }))
        .send()
        .await
    else {
        return GeminiVerificationProbe::Inconclusive;
    };
    // Google answers the listing and counting endpoints with the account
    // verification challenge for accounts that still serve generations, so a
    // challenge there cannot condemn the login. Only a rejected generation
    // below does; the catalogue falls back to the reviewed model list.
    let catalogue = if models.status() == StatusCode::FORBIDDEN {
        if !gemini_response_requires_verification(&mut models).await {
            return GeminiVerificationProbe::Inconclusive;
        }
        println!(
            "gemini verification probe: model discovery returned the account verification challenge"
        );
        None
    } else if models.status().is_success() {
        models.json::<Value>().await.ok()
    } else {
        return GeminiVerificationProbe::Inconclusive;
    };
    let definition = crate::utils::provider_catalogue::provider(AgentProvider::Gemini);
    let model = catalogue
        .as_ref()
        .and_then(|catalogue| {
            definition.chat_models().find(|model| {
                catalogue
                    .pointer("/models")
                    .and_then(|models| models.get(&model.id))
                    .is_some()
            })
        })
        .or_else(|| definition.chat_models().next())
        .expect("validated Gemini chat catalogue");
    let model = model.id.as_str();
    let count_url = format!(
        "{}/v1internal:countTokens",
        state.config.gemini_code_assist_url.trim_end_matches('/')
    );
    let body = gemini_code_assist_request(
        model,
        project,
        GeminiOperation::CountTokens,
        &json!({"contents": [{"role": "user", "parts": [{"text": "verify"}]}]}),
    );
    let Ok(mut count) = state
        .gateway_http
        .post(count_url)
        .bearer_auth(access_token)
        .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
        .json(&body)
        .send()
        .await
    else {
        return GeminiVerificationProbe::Inconclusive;
    };
    if count.status() == StatusCode::FORBIDDEN {
        if !gemini_response_requires_verification(&mut count).await {
            return GeminiVerificationProbe::Inconclusive;
        }
        println!(
            "gemini verification probe: token counting returned the account verification challenge"
        );
    } else if !count.status().is_success() {
        return GeminiVerificationProbe::Inconclusive;
    }
    let count_succeeded = count.status().is_success();
    let generate_url = format!(
        "{}/v1internal:generateContent",
        state.config.gemini_code_assist_url.trim_end_matches('/')
    );
    let body = gemini_code_assist_request(
        model,
        project,
        GeminiOperation::Generate,
        &json!({
            "contents": [{"role": "user", "parts": [{"text": "Reply OK"}]}],
            "generationConfig": {"maxOutputTokens": 8}
        }),
    );
    let Ok(mut generated) = state
        .gateway_http
        .post(generate_url)
        .bearer_auth(access_token)
        .header("user-agent", ANTIGRAVITY_CLIENT_VERSION)
        .json(&body)
        .send()
        .await
    else {
        return GeminiVerificationProbe::Inconclusive;
    };
    let status = generated.status();
    if status == StatusCode::FORBIDDEN
        && gemini_response_requires_verification(&mut generated).await
    {
        println!(
            "gemini verification probe: generation returned the account verification challenge"
        );
        return GeminiVerificationProbe::ReauthorizationRequired;
    }
    if status.is_success() {
        return GeminiVerificationProbe::Verified;
    }
    println!("gemini verification probe: generation returned HTTP {status}");
    // A counted token proves the credential and project reach Code Assist, so a
    // generation that failed for a model-specific reason does not condemn the
    // login: a successful token count is enough to restore it.
    if count_succeeded {
        GeminiVerificationProbe::Verified
    } else {
        GeminiVerificationProbe::Inconclusive
    }
}
