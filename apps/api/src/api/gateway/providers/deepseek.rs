//! DeepSeek gateway endpoints.

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method},
    response::Response,
};

use crate::{
    api::gateway::{catalogue::filter_current_live_model_response, proxy::proxy_request},
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub async fn deepseek_chat(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/chat/completions", state.config.deepseek_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn deepseek_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/responses", state.config.deepseek_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn deepseek_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy_request(
        &state,
        AgentProvider::Deepseek,
        &format!("{}/models", state.config.deepseek_api_url),
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await?;
    filter_current_live_model_response(response, AgentProvider::Deepseek).await
}
