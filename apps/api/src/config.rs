use std::{env, fmt};

use axum::http::HeaderValue;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};

#[derive(Clone)]
pub struct AppConfig {
    pub cookie_secure: bool,
    pub credential_encryption_key: [u8; 32],
    pub frontend_origin: HeaderValue,
    pub codex_issuer: String,
    pub claude_authorize_url: String,
    pub claude_redirect_url: String,
    pub claude_token_url: String,
    pub grok_issuer: String,
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
            codex_issuer: env::var("CODEX_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://auth.openai.com".to_owned()),
            claude_authorize_url: env::var("CLAUDE_AUTHORIZE_URL")
                .unwrap_or_else(|_| "https://claude.com/cai/oauth/authorize".to_owned()),
            claude_redirect_url: env::var("CLAUDE_REDIRECT_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/oauth/code/callback".to_owned()),
            claude_token_url: env::var("CLAUDE_TOKEN_URL")
                .unwrap_or_else(|_| "https://platform.claude.com/v1/oauth/token".to_owned()),
            grok_issuer: env::var("GROK_AUTH_ISSUER")
                .unwrap_or_else(|_| "https://accounts.x.ai".to_owned()),
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
            codex_issuer: "https://auth.openai.com".to_owned(),
            claude_authorize_url: "https://claude.com/cai/oauth/authorize".to_owned(),
            claude_redirect_url: "https://platform.claude.com/oauth/code/callback".to_owned(),
            claude_token_url: "https://platform.claude.com/v1/oauth/token".to_owned(),
            grok_issuer: "https://accounts.x.ai".to_owned(),
        }
    }
}
