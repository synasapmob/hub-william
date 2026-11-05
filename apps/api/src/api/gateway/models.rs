//! The model list a signed-in user or a Hub key sees.

use axum::{
    Json,
    body::{Bytes, to_bytes},
    http::{HeaderMap, HeaderValue, Method, header},
    response::{IntoResponse, Response},
};
use serde_json::Value;
use uuid::Uuid;

use super::{
    GROK_MODELS_URL,
    catalogue::{
        fetch_or_cached_claude_catalogue, fetch_or_cached_openai_catalogue,
        filter_current_live_model_response, intersect_live_catalogue,
    },
    proxy::{GatewayUpstream, proxy_request_for_user},
    selection::GatewaySelection,
};
use crate::{
    api::gateway::providers::gemini::gemini_models_for_user,
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

const OPENAI_MODELS_URL: &str = "https://chatgpt.com/backend-api/models";

pub(crate) async fn models_for_user(
    state: &AppState,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    let selection = GatewaySelection {
        key_id: None,
        user_id,
        connection_id: Some(connection_id),
        organization_id: None,
    };
    models_for_selection(state, selection, provider).await
}

pub(crate) async fn models_for_organization_user(
    state: &AppState,
    user_id: Uuid,
    organization_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    models_for_selection(
        state,
        GatewaySelection {
            key_id: None,
            user_id,
            connection_id: Some(connection_id),
            organization_id: Some(organization_id),
        },
        provider,
    )
    .await
}

async fn models_for_selection(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    match provider {
        AgentProvider::Chatgpt => {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            headers.insert(
                "openai-beta",
                HeaderValue::from_static("responses=experimental"),
            );
            headers.insert(
                "version",
                HeaderValue::from_str(&state.config.codex_client_version)
                    .map_err(|_| ApiError::Internal)?,
            );
            for base_url in [
                state.config.chatgpt_codex_models_url.as_str(),
                OPENAI_MODELS_URL,
            ] {
                let mut url = reqwest::Url::parse(base_url).map_err(|_| ApiError::Internal)?;
                url.query_pairs_mut()
                    .append_pair("client_version", &state.config.codex_client_version);
                let response = proxy_request_for_user(
                    state,
                    selection,
                    GatewayUpstream {
                        provider,
                        url: url.as_str(),
                    },
                    Method::GET,
                    &axum::http::Uri::from_static("/"),
                    &headers,
                    Bytes::new(),
                )
                .await?;
                if response.status().is_success()
                    || response.status().as_u16() == 401
                    || response.status().as_u16() == 403
                {
                    return Ok(response);
                }
            }
            Err(ApiError::Provider(
                "ChatGPT model discovery is temporarily unavailable.".to_owned(),
            ))
        }
        AgentProvider::Claude => {
            let mut headers = HeaderMap::new();
            headers.insert(header::ACCEPT, HeaderValue::from_static("application/json"));
            proxy_request_for_user(
                state,
                selection,
                GatewayUpstream {
                    provider,
                    url: &state.config.claude_models_url,
                },
                Method::GET,
                &axum::http::Uri::from_static("/"),
                &headers,
                Bytes::new(),
            )
            .await
        }
        AgentProvider::Gemini => Ok(gemini_models_for_user(state, selection)
            .await?
            .into_response()),
        AgentProvider::Grok | AgentProvider::Deepseek | AgentProvider::Groq => {
            let url = if provider == AgentProvider::Grok {
                GROK_MODELS_URL.to_owned()
            } else if provider == AgentProvider::Groq {
                format!("{}/models", state.config.groq_api_url)
            } else {
                format!("{}/models", state.config.deepseek_api_url)
            };
            let response = proxy_request_for_user(
                state,
                selection,
                GatewayUpstream {
                    provider,
                    url: &url,
                },
                Method::GET,
                &axum::http::Uri::from_static("/"),
                &HeaderMap::new(),
                Bytes::new(),
            )
            .await?;
            filter_current_live_model_response(response, provider).await
        }
    }
}

/// Lists what the key owner's connected account can actually use. The live
/// account catalogue decides availability; the current catalogue only supplies
/// names and effort metadata and hides retired models, so a model missing from
/// the subscription never reaches key clients such as OpenCode and OMP.
pub(super) async fn subscriber_models(
    state: &AppState,
    selection: GatewaySelection,
    provider: AgentProvider,
) -> Result<Response, ApiError> {
    let response = models_for_selection(state, selection, provider).await?;
    if !response.status().is_success() {
        return Ok(response);
    }
    let bytes = to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .map_err(|_| ApiError::Provider("The model catalogue could not be read.".to_owned()))?;
    let live: Value = serde_json::from_slice(&bytes).map_err(|_| {
        ApiError::Provider("The provider returned an invalid model catalogue.".to_owned())
    })?;
    let current = match provider {
        AgentProvider::Chatgpt => fetch_or_cached_openai_catalogue(&state.http).await,
        AgentProvider::Claude => fetch_or_cached_claude_catalogue(&state.http).await,
        _ => return Err(ApiError::Internal),
    };
    Ok(Json(intersect_live_catalogue(&current, &live)?).into_response())
}
