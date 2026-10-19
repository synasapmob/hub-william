use axum::{
    Router,
    extract::DefaultBodyLimit,
    routing::{delete, get, post},
};
use utoipa::OpenApi;

use crate::core::AppState;

use super::{
    claude_count_tokens, claude_messages, claude_models, create_key, deepseek_chat,
    deepseek_models, deepseek_responses, gemini_models, gemini_request, grok_chat, grok_models,
    grok_responses, groq_chat, groq_models, groq_responses, list_keys, openai_models,
    openai_responses, revoke_key,
};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/gateway-keys", get(list_keys).post(create_key))
        .route("/gateway-keys/{key_id}", delete(revoke_key))
        .merge(provider_routes())
}

/// Provider-compatible endpoints. Prompts carry attachments, so these accept
/// request bodies of any size, unlike the browser API.
fn provider_routes() -> Router<AppState> {
    Router::new()
        .route("/gateway/openai/v1/responses", post(openai_responses))
        .route("/gateway/openai/v1/models", get(openai_models))
        .route("/gateway/claude/v1/messages", post(claude_messages))
        .route("/gateway/claude/v1/models", get(claude_models))
        .route(
            "/gateway/claude/v1/messages/count_tokens",
            post(claude_count_tokens),
        )
        .route("/gateway/grok/v1/chat/completions", post(grok_chat))
        .route("/gateway/grok/v1/responses", post(grok_responses))
        .route("/gateway/grok/v1/models", get(grok_models))
        .route("/gateway/gemini/v1beta/models", get(gemini_models))
        .route(
            "/gateway/gemini/v1beta/models/{*operation}",
            post(gemini_request),
        )
        .route("/gateway/deepseek/chat/completions", post(deepseek_chat))
        .route("/gateway/deepseek/responses", post(deepseek_responses))
        .route("/gateway/deepseek/models", get(deepseek_models))
        .route("/gateway/groq/v1/models", get(groq_models))
        .route("/gateway/groq/v1/responses", post(groq_responses))
        .route("/gateway/groq/v1/chat/completions", post(groq_chat))
        .layer(DefaultBodyLimit::disable())
}

#[derive(OpenApi)]
#[openapi(
    paths(super::create_key, super::list_keys, super::revoke_key),
    components(schemas(super::CreatedGatewayKey, super::GatewayKey)),
    tags((name = "gateway keys", description = "Revocable keys for provider-specific gateway access"))
)]
pub(crate) struct GatewayApi;
