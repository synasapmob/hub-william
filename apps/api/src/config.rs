use std::{env, fmt};

use axum::http::HeaderValue;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Clone)]
pub struct AppConfig {
    pub cookie_secure: bool,
    pub credential_encryption_key: [u8; 32],
    pub frontend_origin: HeaderValue,
    pub telegram_service_token: Option<Vec<u8>>,
    pub codex_client_version: String,
    pub codex_issuer: String,
    pub claude_authorize_url: String,
    pub claude_client_version: String,
    pub claude_profile_url: String,
    pub claude_redirect_url: String,
    pub claude_token_url: String,
    pub gemini_authorize_url: String,
    pub gemini_client_id: String,
    pub gemini_client_secret: String,
    pub gemini_code_assist_url: String,
    pub gemini_redirect_url: String,
    pub gemini_token_url: String,
    pub gemini_userinfo_url: String,
    pub grok_issuer: String,
    pub grok_client_id: String,
    pub grok_client_version: String,
    pub deepseek_api_url: String,
}

#[derive(Debug)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

impl AppConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let frontend_origin =
            env::var("FRONTEND_ORIGIN").unwrap_or_else(|_| "http://localhost:5173".to_owned());
        let frontend_origin = HeaderValue::from_str(&frontend_origin)
            .map_err(|_| ConfigError("FRONTEND_ORIGIN must be a valid HTTP origin".to_owned()))?;
        let cookie_secure = env::var("COOKIE_SECURE")
            .map(|value| value.eq_ignore_ascii_case("true") || value == "1")
            .unwrap_or(false);
        let credential_encryption_key =
            env::var("PROVIDER_CREDENTIAL_ENCRYPTION_KEY").map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key"
                        .to_owned(),
                )
            })?;
        let credential_encryption_key = URL_SAFE_NO_PAD
            .decode(credential_encryption_key)
            .map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must be a base64url-encoded 32-byte key"
                        .to_owned(),
                )
            })?
            .try_into()
            .map_err(|_| {
                ConfigError(
                    "PROVIDER_CREDENTIAL_ENCRYPTION_KEY must decode to exactly 32 bytes".to_owned(),
                )
            })?;

        Ok(Self {
            cookie_secure,
            credential_encryption_key,
            frontend_origin,
            telegram_service_token: env::var("TELEGRAM_SERVICE_TOKEN")
                .ok()
                .filter(|token| !token.trim().is_empty())
                .map(String::into_bytes),
            codex_client_version: env::var("CODEX_CLIENT_VERSION")
                .unwrap_or_else(|_| "0.156.0".to_owned()),
            codex_issuer: env::var("CODEX_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://auth.openai.com".to_owned()),
            claude_authorize_url: env::var("CLAUDE_AUTHORIZE_URL")
                .unwrap_or_else(|_| "https://claude.com/cai/oauth/authorize".to_owned()),
            claude_client_version: env::var("CLAUDE_CLIENT_VERSION")
                .unwrap_or_else(|_| "2.1.223".to_owned()),
            claude_profile_url: env::var("CLAUDE_PROFILE_URL")
                .unwrap_or_else(|_| "https://api.anthropic.com/api/oauth/profile".to_owned()),
            claude_redirect_url: env::var("CLAUDE_REDIRECT_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/oauth/code/callback".to_owned()),
            claude_token_url: env::var("CLAUDE_TOKEN_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/v1/oauth/token".to_owned()),
            gemini_authorize_url: env::var("GEMINI_AUTHORIZE_URL")
                .unwrap_or_else(|_| "https://accounts.google.com/o/oauth2/auth".to_owned()),
            gemini_client_id: env::var("GEMINI_OAUTH_CLIENT_ID").unwrap_or_else(|_| {
                "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
                    .to_owned()
            }),
            gemini_client_secret: env::var("GEMINI_OAUTH_CLIENT_SECRET").map_err(|_| {
                ConfigError(
                    "GEMINI_OAUTH_CLIENT_SECRET must be set for Google subscription authorization"
                        .to_owned(),
                )
            })?,
            gemini_code_assist_url: env::var("GEMINI_CODE_ASSIST_URL")
                .unwrap_or_else(|_| "https://daily-cloudcode-pa.googleapis.com".to_owned()),
            gemini_redirect_url: env::var("GEMINI_REDIRECT_URL")
                .unwrap_or_else(|_| "https://antigravity.google/oauth-callback".to_owned()),
            gemini_token_url: env::var("GEMINI_TOKEN_URL")
                .unwrap_or_else(|_| "https://oauth2.googleapis.com/token".to_owned()),
            gemini_userinfo_url: env::var("GEMINI_USERINFO_URL")
                .unwrap_or_else(|_| "https://www.googleapis.com/oauth2/v2/userinfo".to_owned()),
            grok_issuer: env::var("GROK_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://auth.x.ai".to_owned()),
            grok_client_id: env::var("GROK_AUTH_CLIENT_ID")
                .unwrap_or_else(|_| "b1a00492-073a-47ea-816f-4c329264a828".to_owned()),
            grok_client_version: env::var("GROK_CLIENT_VERSION")
                .unwrap_or_else(|_| "1.0.30".to_owned()),
            deepseek_api_url: env::var("DEEPSEEK_API_URL")
                .unwrap_or_else(|_| "https://api.deepseek.com".to_owned())
                .trim_end_matches('/')
                .to_owned(),
        })
    }
}

#[cfg(test)]
impl Default for AppConfig {
    fn default() -> Self {
        Self {
            cookie_secure: false,
            credential_encryption_key: [7; 32],
            frontend_origin: HeaderValue::from_static("http://localhost:5173"),
            telegram_service_token: None,
            codex_client_version: "0.156.0".to_owned(),
            codex_issuer: "https://auth.openai.com".to_owned(),
            claude_authorize_url: "https://claude.com/cai/oauth/authorize".to_owned(),
            claude_client_version: "2.1.223".to_owned(),
            claude_profile_url: "https://api.anthropic.com/api/oauth/profile".to_owned(),
            claude_redirect_url: "https://platform.claude.com/oauth/code/callback".to_owned(),
            claude_token_url: "https://platform.claude.com/v1/oauth/token".to_owned(),
            gemini_authorize_url: "https://accounts.google.com/o/oauth2/auth".to_owned(),
            gemini_client_id:
                "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
                    .to_owned(),
            gemini_client_secret: "test-gemini-client-secret".to_owned(),
            gemini_code_assist_url: "https://daily-cloudcode-pa.googleapis.com".to_owned(),
            gemini_redirect_url: "https://antigravity.google/oauth-callback".to_owned(),
            gemini_token_url: "https://oauth2.googleapis.com/token".to_owned(),
            gemini_userinfo_url: "https://www.googleapis.com/oauth2/v2/userinfo".to_owned(),
            grok_issuer: "https://auth.x.ai".to_owned(),
            grok_client_id: "b1a00492-073a-47ea-816f-4c329264a828".to_owned(),
            grok_client_version: "1.0.30".to_owned(),
            deepseek_api_url: "https://api.deepseek.com".to_owned(),
        }
    }
}
