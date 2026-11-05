//! Claude gateway endpoints.

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method},
    response::Response,
};

use crate::{
    api::gateway::{
        CLAUDE_COUNT_TOKENS_URL, CLAUDE_MESSAGES_URL,
        keys::authorize_gateway_key,
        models::subscriber_models,
        proxy::{ensure_claude_billing_header, proxy_request},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub async fn claude_messages(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = ensure_claude_billing_header(body, &state.config.claude_client_version);
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_MESSAGES_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn claude_count_tokens(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = ensure_claude_billing_header(body, &state.config.claude_client_version);
    proxy_request(
        &state,
        AgentProvider::Claude,
        CLAUDE_COUNT_TOKENS_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn claude_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    subscriber_models(&state, authorized.into(), AgentProvider::Claude).await
}
