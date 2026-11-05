//! Grok gateway endpoints.

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method},
    response::Response,
};

use crate::{
    api::gateway::{
        GROK_MODELS_URL, GROK_RESPONSES_URL, catalogue::filter_current_live_model_response,
        proxy::proxy_request,
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

const GROK_CHAT_URL: &str = "https://cli-chat-proxy.grok.com/v1/chat/completions";

pub async fn grok_chat(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_CHAT_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn grok_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_RESPONSES_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn grok_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy_request(
        &state,
        AgentProvider::Grok,
        GROK_MODELS_URL,
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await?;
    filter_current_live_model_response(response, AgentProvider::Grok).await
}
