use axum::{
    Router,
    extract::DefaultBodyLimit,
    middleware::from_fn_with_state,
    routing::{get, post},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{Limit, UserLimit, limit_by_user},
    core::AppState,
};

use super::{authorize_chat, chat, groq_voice, models, voice};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    Router::new()
        .route(
            "/playground/{provider}/accounts/{connection_id}/models",
            get(models),
        )
        .merge(
            Router::new()
                .route("/playground/chat", post(chat))
                .route(
                    "/playground/groq/voice/turn",
                    post(groq_voice::create).layer(DefaultBodyLimit::max(64 * 1024)),
                )
                .route(
                    "/playground/voice",
                    post(voice::create).layer(DefaultBodyLimit::max(96 * 1024)),
                )
                .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
                // Inside `authorize_chat`, which has already resolved the session.
                .layer(from_fn_with_state(
                    UserLimit::new(state, Limit::PlaygroundGenerate),
                    limit_by_user,
                ))
                .layer(from_fn_with_state(state.clone(), authorize_chat)),
        )
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::models,
        super::chat,
        super::voice::create,
        super::groq_voice::create
    ),
    components(schemas(
        super::PlaygroundModel,
        super::PlaygroundMode,
        super::PlaygroundAttachment,
        super::PlaygroundRole,
        super::PlaygroundMessage,
        super::PlaygroundChatRequest,
        super::voice::PlaygroundVoiceRequest,
        super::voice::PlaygroundVoiceSession,
        super::groq_voice::GroqVoiceTurnRequest,
        super::groq_voice::GroqVoiceTurnResponse,
        super::groq_voice::GroqVoiceMessage
    ))
)]
pub(crate) struct PlaygroundApi;
