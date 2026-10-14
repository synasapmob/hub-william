use axum::{
    Json,
    body::Body,
    http::{HeaderValue, StatusCode, header},
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio_tungstenite::{connect_async, tungstenite::client::IntoClientRequest};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::error::ApiError;

const WINDOWS_FILE_TIME_EPOCH: u64 = 11_644_473_600;
const TRUSTED_CLIENT_TOKEN: &str = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const CHROMIUM_VERSION: &str = "143.0.3650.75";

#[derive(Debug, Deserialize, Serialize, ToSchema)]
pub struct TtsRequest {
    pub text: String,
    #[serde(default = "default_voice")]
    pub voice: String,
    #[serde(default = "default_rate")]
    pub rate: String,
    #[serde(default = "default_pitch")]
    pub pitch: String,
}

fn default_voice() -> String {
    "en-US-AriaNeural".to_string()
}

fn default_rate() -> String {
    "0%".to_string()
}

fn default_pitch() -> String {
    "0Hz".to_string()
}

fn generate_sec_ms_gec_token() -> String {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let ticks = (now_secs + WINDOWS_FILE_TIME_EPOCH) * 10_000_000;
    let rounded_ticks = ticks - (ticks % 3_000_000_000);
    let str_to_hash = format!("{}{}", rounded_ticks, TRUSTED_CLIENT_TOKEN);
    let mut hasher = Sha256::new();
    hasher.update(str_to_hash.as_bytes());
    format!("{:X}", hasher.finalize())
}

fn escape_xml(input: &str) -> String {
    input
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub async fn synthesize_speech(request: &TtsRequest) -> Result<Vec<u8>, ApiError> {
    if request.text.trim().is_empty() {
        return Err(ApiError::Validation("Text content is required."));
    }

    let sec_gec = generate_sec_ms_gec_token();
    let connection_id = Uuid::new_v4().simple().to_string();
    let ws_url = format!(
        "wss://speech.platform.bing.com/consumer/speech/synthesize/readaheadedge/v1?TrustedClientToken={}&Sec-MS-GEC={}&Sec-MS-GEC-Version=1-{}&ConnectionId={}",
        TRUSTED_CLIENT_TOKEN, sec_gec, CHROMIUM_VERSION, connection_id
    );

    let mut client_req = ws_url
        .into_client_request()
        .map_err(|_| ApiError::Internal)?;

    let headers = client_req.headers_mut();
    let user_agent = format!(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/{} Safari/537.36 Edg/{}",
        CHROMIUM_VERSION, CHROMIUM_VERSION
    );

    headers.insert(
        header::USER_AGENT,
        HeaderValue::from_str(&user_agent).map_err(|_| ApiError::Internal)?,
    );
    headers.insert(header::PRAGMA, HeaderValue::from_static("no-cache"));
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    headers.insert(
        header::ORIGIN,
        HeaderValue::from_static("chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold"),
    );

    let (mut ws_stream, _) = connect_async(client_req)
        .await
        .map_err(|err| ApiError::Provider(format!("Failed to connect to speech service: {err}")))?;

    // 1. Send speech configuration
    let config_msg = "Content-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n{\"context\":{\"synthesis\":{\"audio\":{\"metadataoptions\":{\"sentenceBoundaryEnabled\":\"false\",\"wordBoundaryEnabled\":\"false\"},\"outputFormat\":\"audio-24khz-48kbitrate-mono-mp3\"}}}}";
    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            config_msg.into(),
        ))
        .await
        .map_err(|err| ApiError::Provider(format!("Failed to send speech config: {err}")))?;

    // 2. Send SSML payload
    let lang = if request.voice.len() >= 5 {
        &request.voice[..5]
    } else {
        "en-US"
    };

    let escaped_text = escape_xml(&request.text);
    let request_id = Uuid::new_v4().simple().to_string();
    let ssml = format!(
        "X-RequestId:{request_id}\r\nContent-Type:application/ssml+xml\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'><voice name='{}'><prosody pitch='{}' rate='{}'>{escaped_text}</prosody></voice></speak>",
        request.voice, request.pitch, request.rate
    );

    ws_stream
        .send(tokio_tungstenite::tungstenite::Message::Text(ssml.into()))
        .await
        .map_err(|err| ApiError::Provider(format!("Failed to send SSML request: {err}")))?;

    let mut audio_chunks = Vec::new();

    // 3. Receive binary audio until turn.end
    while let Some(msg_result) = ws_stream.next().await {
        let msg = msg_result
            .map_err(|err| ApiError::Provider(format!("WebSocket communication error: {err}")))?;

        match msg {
            tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                if bytes.len() >= 2 {
                    let header_len = u16::from_be_bytes([bytes[0], bytes[1]]) as usize;
                    if bytes.len() > 2 + header_len {
                        let header_str = String::from_utf8_lossy(&bytes[2..2 + header_len]);
                        if header_str.contains("Path:audio") {
                            audio_chunks.extend_from_slice(&bytes[2 + header_len..]);
                        }
                    }
                }
            }
            tokio_tungstenite::tungstenite::Message::Text(text_msg) => {
                if text_msg.contains("Path:turn.end") {
                    break;
                }
            }
            tokio_tungstenite::tungstenite::Message::Close(_) => {
                break;
            }
            _ => {}
        }
    }

    if audio_chunks.is_empty() {
        return Err(ApiError::Provider(
            "Speech service completed without returning audio chunks.".to_string(),
        ));
    }

    Ok(audio_chunks)
}

#[utoipa::path(
    post,
    path = "/tts",
    request_body = TtsRequest,
    responses(
        (status = 200, description = "Generated MP3 audio", content_type = "audio/mpeg"),
        (status = 400, body = crate::ErrorResponse),
        (status = 502, body = crate::ErrorResponse)
    ),
    tag = "tools"
)]
pub async fn synthesize(Json(request): Json<TtsRequest>) -> Result<Response, ApiError> {
    let audio_bytes = synthesize_speech(&request).await?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "audio/mpeg")
        .header(header::CONTENT_LENGTH, audio_bytes.len().to_string())
        .header(header::CACHE_CONTROL, "no-cache")
        .body(Body::from(audio_bytes))
        .map_err(|_| ApiError::Internal)?;

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sec_gec_token_generates_hex_string() {
        let token = generate_sec_ms_gec_token();
        assert_eq!(token.len(), 64);
        assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn escape_xml_escapes_special_characters() {
        assert_eq!(
            escape_xml("<hello & 'world'> \"test\""),
            "&lt;hello &amp; &apos;world&apos;&gt; &quot;test&quot;"
        );
    }
}
