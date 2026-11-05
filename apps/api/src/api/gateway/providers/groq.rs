//! Groq gateway endpoints.

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

pub async fn groq_chat(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Groq,
        &format!("{}/chat/completions", state.config.groq_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn groq_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    proxy_request(
        &state,
        AgentProvider::Groq,
        &format!("{}/responses", state.config.groq_api_url),
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn groq_models(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let response = proxy_request(
        &state,
        AgentProvider::Groq,
        &format!("{}/models", state.config.groq_api_url),
        Method::GET,
        &uri,
        &headers,
        Bytes::new(),
    )
    .await?;
    filter_current_live_model_response(response, AgentProvider::Groq).await
}
