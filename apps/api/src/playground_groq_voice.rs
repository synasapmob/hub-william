use axum::{
    Json,
    extract::{Extension, State},
    response::Response,
};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AppState,
    error::ApiError,
    gateway,
    playground::{PlaygroundRole, PlaygroundSession},
};

pub(crate) use crate::provider_catalogue_generated::{
    CALL_GROQ_CHAT_MODEL as GROQ_CHAT_MODEL, CALL_GROQ_TTS_MODEL as GROQ_TTS_MODEL,
};

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GroqVoiceMessage {
    pub role: PlaygroundRole,
    pub content: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct GroqVoiceTurnRequest {
    pub connection_id: Uuid,
    pub organization_id: Option<Uuid>,
    pub model: String,
    /// Final transcript recognized locally in the browser, at most 8000 UTF-8 bytes.
    pub transcript: String,
    pub messages: Vec<GroqVoiceMessage>,
    /// Stream accepted transcript, reply deltas and audio clips as SSE.
    #[serde(default)]
    pub stream: bool,
    /// With stream=true, allow sentence audio to interleave with reply deltas.
    #[serde(default)]
    pub stream_audio: bool,
}

#[derive(Serialize, ToSchema)]
pub struct GroqVoiceTurnResponse {
    pub transcript: String,
    pub reply: String,
    /// Ordered base64 WAV clips. Each TTS input is at most 200 characters.
    pub audio: Vec<String>,
}

fn validate_request(request: &GroqVoiceTurnRequest) -> Result<(), ApiError> {
    if request.model != GROQ_CHAT_MODEL {
        return Err(ApiError::Validation("Choose a supported Groq Call model."));
    }
    if request.transcript.len() > 8000 || !request.transcript.chars().any(char::is_alphanumeric) {
        return Err(ApiError::Validation(
            "Provide a spoken transcript of at most 8000 bytes.",
        ));
    }
    if request.messages.len() > 20
        || request
            .messages
            .iter()
            .any(|m| m.content.trim().is_empty() || m.content.len() > 8000)
        || request
            .messages
            .iter()
            .map(|m| m.content.len())
            .sum::<usize>()
            > 32000
    {
        return Err(ApiError::Validation(
            "The call history is too long. Start a new call.",
        ));
    }
    Ok(())
}

#[utoipa::path(post, operation_id = "create_groq_voice_turn", path = "/playground/groq/voice/turn", request_body = GroqVoiceTurnRequest,
    responses((status = 200, description = "JSON by default; stream=true returns SSE transcript, delta, audio, done or error events. stream_audio=true allows delta and audio to interleave", content((GroqVoiceTurnResponse = "application/json"), (String = "text/event-stream"))), (status = 401, body = crate::ErrorResponse),
        (status = 403, body = crate::ErrorResponse), (status = 422, body = crate::ErrorResponse),
        (status = 429, body = crate::ErrorResponse), (status = 502, body = crate::ErrorResponse)), tag = "playground")]
pub async fn create(
    State(state): State<AppState>,
    Extension(session): Extension<PlaygroundSession>,
    Json(request): Json<GroqVoiceTurnRequest>,
) -> Result<Response, ApiError> {
    validate_request(&request)?;
    gateway::groq_voice_turn_for_user(&state, session.0, request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn call_requires_only_chat_and_speech_models() {
        let call = crate::provider_catalogue::call_profiles(crate::AgentProvider::Groq)
            .next()
            .unwrap();
        let mut models = serde_json::json!({"data":[{"id":GROQ_CHAT_MODEL},{"id":GROQ_TTS_MODEL}]});
        assert!(crate::provider_catalogue::call_available(
            call, &models, false
        ));
        models["data"][1]["active"] = false.into();
        assert!(!crate::provider_catalogue::call_available(
            call, &models, false
        ));
        models["data"].as_array_mut().unwrap().pop();
        assert!(!crate::provider_catalogue::call_available(
            call, &models, false
        ));
    }

    #[test]
    fn validates_local_text_model_and_bounded_history() {
        let mut request = GroqVoiceTurnRequest {
            connection_id: Uuid::new_v4(),
            organization_id: None,
            model: GROQ_CHAT_MODEL.into(),
            transcript: "Hello teacher".into(),
            messages: vec![],
            stream: true,
            stream_audio: true,
        };
        assert!(validate_request(&request).is_ok());
        for text in ["", "   ", ".", "... !", "🎤"] {
            request.transcript = text.into();
            assert!(validate_request(&request).is_err());
        }
        request.transcript = "é".repeat(4001);
        assert!(validate_request(&request).is_err());
        request.transcript = "Xin chào".into();
        assert!(validate_request(&request).is_ok());
        request.model = "whisper-large-v3-turbo".into();
        assert!(validate_request(&request).is_err());
        request.model = GROQ_CHAT_MODEL.into();
        request.messages.push(GroqVoiceMessage {
            role: PlaygroundRole::User,
            content: "x".repeat(8001),
        });
        assert!(validate_request(&request).is_err());
    }

    #[test]
    fn old_audio_requests_are_rejected_without_stt_fallback() {
        let body = serde_json::json!({"connection_id":Uuid::new_v4(), "model":GROQ_CHAT_MODEL, "transcript":"Hello", "audio":"old-audio", "messages":[]});
        assert!(serde_json::from_value::<GroqVoiceTurnRequest>(body).is_err());
    }
}
