//! ChatGPT (Codex) gateway endpoints.

use axum::{
    body::Bytes,
    extract::{OriginalUri, State},
    http::{HeaderMap, Method},
    response::Response,
};

use crate::{
    api::gateway::{
        OPENAI_RESPONSES_URL,
        keys::authorize_gateway_key,
        models::subscriber_models,
        proxy::{proxy_request, strip_unsupported_codex_fields},
    },
    core::{ApiError, AppState},
    utils::provider_catalogue::AgentProvider,
};

pub async fn openai_responses(
    State(state): State<AppState>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Response, ApiError> {
    let body = strip_unsupported_codex_fields(body);
    proxy_request(
        &state,
        AgentProvider::Chatgpt,
        OPENAI_RESPONSES_URL,
        Method::POST,
        &uri,
        &headers,
        body,
    )
    .await
}

pub async fn openai_models(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let authorized = authorize_gateway_key(&state, &headers).await?;
    subscriber_models(&state, authorized.into(), AgentProvider::Chatgpt).await
}
