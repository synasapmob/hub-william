use axum::{
    Json,
    extract::{Extension, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{AgentProvider, AppState, error::ApiError, gateway, playground::PlaygroundSession};

pub(crate) use crate::provider_catalogue_generated::CALL_CODEX_REALTIME_MODEL as CODEX_VOICE_MODEL;

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct PlaygroundVoiceRequest {
    pub connection_id: Uuid,
    pub organization_id: Option<Uuid>,
    pub provider: AgentProvider,
    pub model: String,
    pub sdp: String,
}

#[derive(Serialize, ToSchema)]
pub struct PlaygroundVoiceSession {
    pub sdp: String,
}

#[utoipa::path(post, path = "/playground/voice", request_body = PlaygroundVoiceRequest, responses(
    (status = 200, body = PlaygroundVoiceSession),
    (status = 401, body = crate::ErrorResponse),
    (status = 403, body = crate::ErrorResponse),
    (status = 422, body = crate::ErrorResponse),
    (status = 429, body = crate::ErrorResponse),
    (status = 502, body = crate::ErrorResponse)
), tag = "playground")]
pub async fn create(
    State(state): State<AppState>,
    Extension(session): Extension<PlaygroundSession>,
    Json(request): Json<PlaygroundVoiceRequest>,
) -> Result<Json<PlaygroundVoiceSession>, ApiError> {
    let body = request_body(&request)?;
    let sdp = gateway::create_voice_session_for_user(
        &state,
        session.0,
        request.connection_id,
        request.organization_id,
        body,
    )
    .await?;
    Ok(Json(PlaygroundVoiceSession { sdp }))
}

fn request_body(request: &PlaygroundVoiceRequest) -> Result<Value, ApiError> {
    if request.provider != AgentProvider::Chatgpt || request.model != CODEX_VOICE_MODEL {
        return Err(ApiError::Validation(
            "This model does not support Voice. Choose Codex Voice.",
        ));
    }
    if request.sdp.len() > 64 * 1024
        || !request.sdp.starts_with("v=0")
        || !request.sdp.lines().any(|line| line.starts_with("m=audio "))
        || request.sdp.lines().any(|line| line.starts_with("m=video "))
    {
        return Err(ApiError::Validation(
            "Provide a valid audio-only session offer up to 64 KiB.",
        ));
    }
    Ok(json!({
        "sdp": request.sdp,
        "session": {
            "model": CODEX_VOICE_MODEL,
            "instructions": "You are a friendly conversational assistant in Hub William Playground. Listen to the user and respond aloud naturally and briefly. Help with English conversation when asked. You have no camera access and no tools. Do not delegate tasks or request tools.",
            "audio": { "output": { "voice": "cove" } },
            "delegation": { "type": "client" }
        }
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn offer() -> PlaygroundVoiceRequest {
        PlaygroundVoiceRequest {
            connection_id: Uuid::new_v4(),
            organization_id: None,
            provider: AgentProvider::Chatgpt,
            model: CODEX_VOICE_MODEL.into(),
            sdp: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n".into(),
        }
    }

    #[test]
    fn only_verified_model_accepts_audio_offers() {
        let mut input = offer();
        let body = request_body(&input).unwrap();
        assert_eq!(body["session"]["model"], CODEX_VOICE_MODEL);
        assert_eq!(body["session"]["audio"]["output"]["voice"], "cove");
        assert!(body.get("connection_id").is_none());
        input.model = "gpt-6-astra".into();
        assert!(request_body(&input).is_err());
        input.model = CODEX_VOICE_MODEL.into();
        input.provider = AgentProvider::Gemini;
        assert!(request_body(&input).is_err());
    }

    #[test]
    fn camera_is_local_only_and_invalid_or_oversized_offers_are_rejected() {
        let mut input = offer();
        input.sdp.push_str("m=video 9 UDP/TLS/RTP/SAVPF 96\r\n");
        assert!(request_body(&input).is_err());
        input.sdp = "v=0\r\n".into();
        assert!(request_body(&input).is_err());
        input.sdp = offer().sdp + &" ".repeat(64 * 1024);
        assert!(request_body(&input).is_err());
    }
}
