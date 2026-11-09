use argon2::{
    Argon2, PasswordHash, PasswordHasher, PasswordVerifier,
    password_hash::{SaltString, rand_core::OsRng},
};
use axum::{
    Json,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use axum_extra::extract::{
    CookieJar,
    cookie::{Cookie, SameSite},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::Utc;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, Postgres, Transaction};
use time::Duration;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::core::{ApiError, AppConfig, AppState};

mod routes;
pub(crate) use routes::{AuthApi, routes};

const SESSION_COOKIE: &str = "hub_session";
const REFRESH_COOKIE: &str = "hub_refresh";
const ACCESS_HOURS: i64 = 5;
const REFRESH_DAYS: i64 = 7;
/// How long the refresh token a refresh has just replaced is still known. Two
/// requests that refresh together both carry the old one; the second must not be
/// told the session is over.
const REFRESH_GRACE_SECONDS: i64 = 60;

/// The name of the access cookie of this API. A browser keeps cookies per host, not
/// per port, so two APIs on `localhost` would share one cookie and sign each other
/// out; where that can happen each API puts its port in the names (see
/// `AppConfig::cookie_name_suffix`).
fn session_cookie_name(config: &AppConfig) -> String {
    format!("{SESSION_COOKIE}{}", config.cookie_name_suffix)
}

fn refresh_cookie_name(config: &AppConfig) -> String {
    format!("{REFRESH_COOKIE}{}", config.cookie_name_suffix)
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub recovery_email: Option<String>,
}

#[derive(Debug, PartialEq, Serialize, ToSchema)]
pub struct AuthenticatedUser {
    pub id: Uuid,
    pub username: String,
    pub recovery_email: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct SessionResponse {
    pub user: AuthenticatedUser,
}

#[derive(FromRow)]
struct StoredUser {
    id: Uuid,
    username: String,
    password_hash: String,
    recovery_email: Option<String>,
}

#[derive(FromRow)]
struct SessionUser {
    id: Uuid,
    username: String,
    recovery_email: Option<String>,
}

#[derive(FromRow)]
struct RefreshSessionUser {
    session_id: Uuid,
    id: Uuid,
    username: String,
    recovery_email: Option<String>,
    /// Whether the refresh token that was sent is the session's own, and not the one
    /// it replaced a moment ago.
    presented_is_current: bool,
}

struct SessionCookies {
    access: Cookie<'static>,
    refresh: Cookie<'static>,
}

#[utoipa::path(
    post,
    path = "/auth/register",
    request_body = RegisterRequest,
    responses(
        (status = 201, description = "Account created and session started", body = SessionResponse),
        (status = 409, description = "Username already exists", body = crate::core::ErrorResponse),
        (status = 422, description = "Invalid account fields", body = crate::core::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn register(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<RegisterRequest>,
) -> Result<(CookieJar, (StatusCode, Json<SessionResponse>)), ApiError> {
    let username = normalize_username(&payload.username)?;
    validate_password(&payload.password)?;
    let recovery_email = normalize_recovery_email(payload.recovery_email)?;
    let password_hash = hash_password(&payload.password)?;
    let user_id = Uuid::new_v4();
    let mut transaction = state.pool.begin().await.map_err(internal_error)?;

    let insert = sqlx::query(
        "INSERT INTO users (id, username, password_hash, recovery_email) VALUES ($1, $2, $3, $4)",
    )
    .bind(user_id)
    .bind(&username)
    .bind(password_hash)
    .bind(&recovery_email)
    .execute(&mut *transaction)
    .await;

    if let Err(error) = insert {
        if error
            .as_database_error()
            .and_then(|database_error| database_error.code())
            .as_deref()
            == Some("23505")
        {
            return Err(ApiError::Conflict);
        }

        return Err(internal_error(error));
    }

    let session_cookies = create_session(&mut transaction, user_id, &state.config).await?;
    transaction.commit().await.map_err(internal_error)?;

    let response = SessionResponse {
        user: AuthenticatedUser {
            id: user_id,
            username,
            recovery_email,
        },
    };

    Ok((
        jar.add(session_cookies.access).add(session_cookies.refresh),
        (StatusCode::CREATED, Json(response)),
    ))
}

#[utoipa::path(
    post,
    path = "/auth/login",
    request_body = LoginRequest,
    responses(
        (status = 200, description = "Session started", body = SessionResponse),
        (status = 401, description = "Credentials rejected", body = crate::core::ErrorResponse),
        (status = 422, description = "Invalid account fields", body = crate::core::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn login(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<LoginRequest>,
) -> Result<(CookieJar, Json<SessionResponse>), ApiError> {
    let username = normalize_username(&payload.username)?;
    validate_password(&payload.password)?;
    let user = sqlx::query_as::<_, StoredUser>(
        "SELECT id, username, password_hash, recovery_email FROM users WHERE username = $1",
    )
    .bind(username)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?
    .ok_or(ApiError::InvalidCredentials)?;

    verify_password(&payload.password, &user.password_hash)?;

    let mut transaction = state.pool.begin().await.map_err(internal_error)?;
    let session_cookies = create_session(&mut transaction, user.id, &state.config).await?;
    transaction.commit().await.map_err(internal_error)?;

    Ok((
        jar.add(session_cookies.access).add(session_cookies.refresh),
        Json(SessionResponse {
            user: AuthenticatedUser {
                id: user.id,
                username: user.username,
                recovery_email: user.recovery_email,
            },
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/auth/session",
    responses(
        (status = 200, description = "Current authenticated user", body = SessionResponse),
        (status = 204, description = "No access or refresh session cookie: nothing to refresh"),
        (status = 401, description = "Access session missing or expired; a refresh session may restore it", body = crate::core::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn session(State(state): State<AppState>, jar: CookieJar) -> Result<Response, ApiError> {
    if jar.get(&session_cookie_name(&state.config)).is_none() {
        // Both cookies are HttpOnly, so only the server can tell a visitor who never
        // signed in from one whose access cookie has expired. The refresh cookie
        // outlives the access cookie, so 401 tells the client a refresh can succeed
        // and 204 tells it not to try.
        return if jar.get(&refresh_cookie_name(&state.config)).is_some() {
            Err(ApiError::Unauthorized)
        } else {
            Ok(StatusCode::NO_CONTENT.into_response())
        };
    }
    let user = authenticated_user(&state, &jar).await?;

    Ok(Json(SessionResponse {
        user: AuthenticatedUser {
            id: user.id,
            username: user.username,
            recovery_email: user.recovery_email,
        },
    })
    .into_response())
}

pub(crate) async fn authenticated_user_id(
    state: &AppState,
    jar: &CookieJar,
) -> Result<Uuid, ApiError> {
    authenticated_user(state, jar).await.map(|user| user.id)
}

pub(crate) async fn optional_authenticated_user_id(
    state: &AppState,
    jar: &CookieJar,
) -> Result<Option<Uuid>, ApiError> {
    let session_name = session_cookie_name(&state.config);
    let Some(token) = jar.get(&session_name).map(|cookie| cookie.value()) else {
        return Ok(None);
    };
    let token_hash = hash_token(token);

    sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > NOW()",
    )
    .bind(token_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)
}

async fn authenticated_user(state: &AppState, jar: &CookieJar) -> Result<SessionUser, ApiError> {
    let session_name = session_cookie_name(&state.config);
    let token = jar
        .get(&session_name)
        .map(|cookie| cookie.value())
        .ok_or(ApiError::Unauthorized)?;
    let token_hash = hash_token(token);

    sqlx::query_as::<_, SessionUser>(
        "SELECT users.id, users.username, users.recovery_email
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()",
    )
    .bind(token_hash)
    .fetch_optional(&state.pool)
    .await
    .map_err(internal_error)?
    .ok_or(ApiError::Unauthorized)
}

#[utoipa::path(
    post,
    path = "/auth/logout",
    responses((status = 204, description = "Session ended")),
    tag = "auth"
)]
pub async fn logout(State(state): State<AppState>, jar: CookieJar) -> (CookieJar, StatusCode) {
    if let Some(cookie) = jar.get(&session_cookie_name(&state.config)) {
        let token_hash = hash_token(cookie.value());
        let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(&state.pool)
            .await;
    }

    if let Some(cookie) = jar.get(&refresh_cookie_name(&state.config)) {
        let token_hash = hash_token(cookie.value());
        let _ = sqlx::query(
            "DELETE FROM sessions
             WHERE refresh_token_hash = $1 OR previous_refresh_token_hash = $1",
        )
        .bind(token_hash)
        .execute(&state.pool)
        .await;
    }

    let access_removal = removal_cookie(session_cookie_name(&state.config), &state.config);
    let refresh_removal = removal_cookie(refresh_cookie_name(&state.config), &state.config);

    (
        jar.remove(access_removal).remove(refresh_removal),
        StatusCode::NO_CONTENT,
    )
}

#[utoipa::path(
    post,
    path = "/auth/refresh",
    responses(
        (status = 200, description = "Access and refresh sessions rotated", body = SessionResponse),
        (status = 401, description = "Refresh session missing or expired", body = crate::core::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Json<SessionResponse>), ApiError> {
    let refresh_name = refresh_cookie_name(&state.config);
    let refresh_token = jar
        .get(&refresh_name)
        .map(|cookie| cookie.value())
        .ok_or(ApiError::Unauthorized)?;
    let refresh_token_hash = hash_token(refresh_token);
    let mut transaction = state.pool.begin().await.map_err(internal_error)?;
    // The token of the session, or the one it replaced a moment ago. A request that
    // waits for the row lock looks again once the other has committed, and finds
    // its token in the second place.
    let user = sqlx::query_as::<_, RefreshSessionUser>(
        "SELECT sessions.id AS session_id, users.id, users.username, users.recovery_email,
                sessions.refresh_token_hash = $1 AS presented_is_current
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.refresh_expires_at > NOW()
           AND (sessions.refresh_token_hash = $1
                OR (sessions.previous_refresh_token_hash = $1
                    AND sessions.previous_refresh_valid_until > NOW()))
         FOR UPDATE OF sessions",
    )
    .bind(refresh_token_hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal_error)?
    .ok_or(ApiError::Unauthorized)?;
    let jar = if user.presented_is_current {
        let cookies = rotate_session(&mut transaction, user.session_id, &state.config).await?;

        jar.add(cookies.access).add(cookies.refresh)
    } else {
        // The refresh token was replaced a moment ago and the new one is on its way
        // to the browser in the answer of the request that replaced it. This request
        // gets a new access session and leaves the refresh token alone.
        let access = renew_access(&mut transaction, user.session_id, &state.config).await?;

        jar.add(access)
    };
    transaction.commit().await.map_err(internal_error)?;

    Ok((
        jar,
        Json(SessionResponse {
            user: AuthenticatedUser {
                id: user.id,
                username: user.username,
                recovery_email: user.recovery_email,
            },
        }),
    ))
}

async fn create_session(
    transaction: &mut Transaction<'_, Postgres>,
    user_id: Uuid,
    config: &AppConfig,
) -> Result<SessionCookies, ApiError> {
    let (access_token, access_token_hash) = new_token();
    let (refresh_token, refresh_token_hash) = new_token();
    let access_expires_at = Utc::now() + chrono::Duration::hours(ACCESS_HOURS);
    let refresh_expires_at = Utc::now() + chrono::Duration::days(REFRESH_DAYS);

    sqlx::query(
        "INSERT INTO sessions
            (id, user_id, token_hash, expires_at, refresh_token_hash, refresh_expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)",
    )
    .bind(Uuid::new_v4())
    .bind(user_id)
    .bind(access_token_hash)
    .bind(access_expires_at)
    .bind(refresh_token_hash)
    .bind(refresh_expires_at)
    .execute(&mut **transaction)
    .await
    .map_err(internal_error)?;

    Ok(session_cookies(access_token, refresh_token, config))
}

async fn rotate_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    config: &AppConfig,
) -> Result<SessionCookies, ApiError> {
    let (access_token, access_token_hash) = new_token();
    let (refresh_token, refresh_token_hash) = new_token();
    let access_expires_at = Utc::now() + chrono::Duration::hours(ACCESS_HOURS);
    let refresh_expires_at = Utc::now() + chrono::Duration::days(REFRESH_DAYS);
    let previous_valid_until = Utc::now() + chrono::Duration::seconds(REFRESH_GRACE_SECONDS);

    sqlx::query(
        "UPDATE sessions SET token_hash = $2, expires_at = $3,
         previous_refresh_token_hash = refresh_token_hash,
         previous_refresh_valid_until = $6,
         refresh_token_hash = $4, refresh_expires_at = $5 WHERE id = $1",
    )
    .bind(session_id)
    .bind(access_token_hash)
    .bind(access_expires_at)
    .bind(refresh_token_hash)
    .bind(refresh_expires_at)
    .bind(previous_valid_until)
    .execute(&mut **transaction)
    .await
    .map_err(internal_error)?;

    Ok(session_cookies(access_token, refresh_token, config))
}

/// A new access session for a request that came with the refresh token the last
/// refresh replaced; the refresh token itself is not touched.
async fn renew_access(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    config: &AppConfig,
) -> Result<Cookie<'static>, ApiError> {
    let (access_token, access_token_hash) = new_token();
    let access_expires_at = Utc::now() + chrono::Duration::hours(ACCESS_HOURS);

    sqlx::query("UPDATE sessions SET token_hash = $2, expires_at = $3 WHERE id = $1")
        .bind(session_id)
        .bind(access_token_hash)
        .bind(access_expires_at)
        .execute(&mut **transaction)
        .await
        .map_err(internal_error)?;

    Ok(session_cookie(
        session_cookie_name(config),
        access_token,
        Duration::hours(ACCESS_HOURS),
        config,
    ))
}

fn session_cookies(
    access_token: String,
    refresh_token: String,
    config: &AppConfig,
) -> SessionCookies {
    SessionCookies {
        access: session_cookie(
            session_cookie_name(config),
            access_token,
            Duration::hours(ACCESS_HOURS),
            config,
        ),
        refresh: session_cookie(
            refresh_cookie_name(config),
            refresh_token,
            Duration::days(REFRESH_DAYS),
            config,
        ),
    }
}

fn session_cookie(
    name: String,
    value: String,
    max_age: Duration,
    config: &AppConfig,
) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(config.cookie_secure)
        .max_age(max_age)
        .build()
}

fn removal_cookie(name: String, config: &AppConfig) -> Cookie<'static> {
    session_cookie(name, String::new(), Duration::seconds(0), config)
}

fn new_token() -> (String, String) {
    let mut token_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = hash_token(&token);

    (token, token_hash)
}

pub(crate) fn normalize_username(username: &str) -> Result<String, ApiError> {
    let username = username.trim().to_ascii_lowercase();
    let valid = (3..=32).contains(&username.len())
        && username
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'));

    valid.then_some(username).ok_or(ApiError::Validation(
        "Username must be 3-32 letters, numbers, underscores, or hyphens.",
    ))
}

fn validate_password(password: &str) -> Result<(), ApiError> {
    (8..=128)
        .contains(&password.len())
        .then_some(())
        .ok_or(ApiError::Validation(
            "Password must be between 8 and 128 characters.",
        ))
}

fn normalize_recovery_email(email: Option<String>) -> Result<Option<String>, ApiError> {
    let email = email.map(|value| value.trim().to_ascii_lowercase());

    match email {
        Some(value) if value.is_empty() => Ok(None),
        Some(value) if email_address::EmailAddress::is_valid(&value) => Ok(Some(value)),
        Some(_) => Err(ApiError::Validation(
            "Recovery email must be a valid email address.",
        )),
        None => Ok(None),
    }
}

pub(crate) fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::Internal)
}

pub(crate) fn verify_password(password: &str, password_hash: &str) -> Result<(), ApiError> {
    let password_hash = PasswordHash::new(password_hash).map_err(|_| ApiError::Internal)?;
    Argon2::default()
        .verify_password(password.as_bytes(), &password_hash)
        .map_err(|_| ApiError::InvalidCredentials)
}

fn hash_token(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

fn internal_error(error: sqlx::Error) -> ApiError {
    eprintln!("database operation failed: {error}");
    ApiError::Internal
}

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;
