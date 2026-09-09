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

use crate::{AppState, error::ApiError};

const SESSION_COOKIE: &str = "hub_session";
const REFRESH_COOKIE: &str = "hub_refresh";
const ACCESS_HOURS: i64 = 5;
const REFRESH_DAYS: i64 = 7;

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
        (status = 409, description = "Username already exists", body = crate::ErrorResponse),
        (status = 422, description = "Invalid account fields", body = crate::ErrorResponse)
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

    let session_cookies =
        create_session(&mut transaction, user_id, state.config.cookie_secure).await?;
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
        (status = 401, description = "Credentials rejected", body = crate::ErrorResponse),
        (status = 422, description = "Invalid account fields", body = crate::ErrorResponse)
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
    let session_cookies =
        create_session(&mut transaction, user.id, state.config.cookie_secure).await?;
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
        (status = 204, description = "No browser session has been started"),
        (status = 401, description = "No active session", body = crate::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn session(State(state): State<AppState>, jar: CookieJar) -> Result<Response, ApiError> {
    if jar.get(SESSION_COOKIE).is_none() {
        return Ok(StatusCode::NO_CONTENT.into_response());
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
    let Some(token) = jar.get(SESSION_COOKIE).map(|cookie| cookie.value()) else {
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
    let token = jar
        .get(SESSION_COOKIE)
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
    if let Some(cookie) = jar.get(SESSION_COOKIE) {
        let token_hash = hash_token(cookie.value());
        let _ = sqlx::query("DELETE FROM sessions WHERE token_hash = $1")
            .bind(token_hash)
            .execute(&state.pool)
            .await;
    }

    if let Some(cookie) = jar.get(REFRESH_COOKIE) {
        let token_hash = hash_token(cookie.value());
        let _ = sqlx::query("DELETE FROM sessions WHERE refresh_token_hash = $1")
            .bind(token_hash)
            .execute(&state.pool)
            .await;
    }

    let access_removal = removal_cookie(SESSION_COOKIE, state.config.cookie_secure);
    let refresh_removal = removal_cookie(REFRESH_COOKIE, state.config.cookie_secure);

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
        (status = 401, description = "Refresh session missing or expired", body = crate::ErrorResponse)
    ),
    tag = "auth"
)]
pub async fn refresh(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<(CookieJar, Json<SessionResponse>), ApiError> {
    let refresh_token = jar
        .get(REFRESH_COOKIE)
        .map(|cookie| cookie.value())
        .ok_or(ApiError::Unauthorized)?;
    let refresh_token_hash = hash_token(refresh_token);
    let mut transaction = state.pool.begin().await.map_err(internal_error)?;
    let user = sqlx::query_as::<_, RefreshSessionUser>(
        "SELECT sessions.id AS session_id, users.id, users.username, users.recovery_email
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.refresh_token_hash = $1
           AND sessions.refresh_expires_at > NOW()
         FOR UPDATE OF sessions",
    )
    .bind(refresh_token_hash)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(internal_error)?
    .ok_or(ApiError::Unauthorized)?;
    let cookies = rotate_session(
        &mut transaction,
        user.session_id,
        state.config.cookie_secure,
    )
    .await?;
    transaction.commit().await.map_err(internal_error)?;

    Ok((
        jar.add(cookies.access).add(cookies.refresh),
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
    cookie_secure: bool,
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

    Ok(session_cookies(access_token, refresh_token, cookie_secure))
}

async fn rotate_session(
    transaction: &mut Transaction<'_, Postgres>,
    session_id: Uuid,
    cookie_secure: bool,
) -> Result<SessionCookies, ApiError> {
    let (access_token, access_token_hash) = new_token();
    let (refresh_token, refresh_token_hash) = new_token();
    let access_expires_at = Utc::now() + chrono::Duration::hours(ACCESS_HOURS);
    let refresh_expires_at = Utc::now() + chrono::Duration::days(REFRESH_DAYS);

    sqlx::query(
        "UPDATE sessions SET token_hash = $2, expires_at = $3,
         refresh_token_hash = $4, refresh_expires_at = $5 WHERE id = $1",
    )
    .bind(session_id)
    .bind(access_token_hash)
    .bind(access_expires_at)
    .bind(refresh_token_hash)
    .bind(refresh_expires_at)
    .execute(&mut **transaction)
    .await
    .map_err(internal_error)?;

    Ok(session_cookies(access_token, refresh_token, cookie_secure))
}

fn session_cookies(
    access_token: String,
    refresh_token: String,
    cookie_secure: bool,
) -> SessionCookies {
    SessionCookies {
        access: session_cookie(
            SESSION_COOKIE,
            access_token,
            Duration::hours(ACCESS_HOURS),
            cookie_secure,
        ),
        refresh: session_cookie(
            REFRESH_COOKIE,
            refresh_token,
            Duration::days(REFRESH_DAYS),
            cookie_secure,
        ),
    }
}

fn session_cookie(
    name: &'static str,
    value: String,
    max_age: Duration,
    cookie_secure: bool,
) -> Cookie<'static> {
    Cookie::build((name, value))
        .path("/")
        .http_only(true)
        .same_site(SameSite::Lax)
        .secure(cookie_secure)
        .max_age(max_age)
        .build()
}

fn removal_cookie(name: &'static str, cookie_secure: bool) -> Cookie<'static> {
    session_cookie(name, String::new(), Duration::seconds(0), cookie_secure)
}

fn new_token() -> (String, String) {
    let mut token_bytes = [0_u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut token_bytes);
    let token = URL_SAFE_NO_PAD.encode(token_bytes);
    let token_hash = hash_token(&token);

    (token, token_hash)
}

fn normalize_username(username: &str) -> Result<String, ApiError> {
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

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|_| ApiError::Internal)
}

fn verify_password(password: &str, password_hash: &str) -> Result<(), ApiError> {
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
mod tests {
    use super::{
        hash_password, new_token, normalize_recovery_email, normalize_username, session_cookies,
        verify_password,
    };

    #[test]
    fn username_is_normalized_and_restricted() {
        assert_eq!(normalize_username(" Synasapmob ").unwrap(), "synasapmob");
        assert!(normalize_username("no spaces").is_err());
        assert!(normalize_username("ab").is_err());
    }

    #[test]
    fn recovery_email_is_optional_but_valid_when_present() {
        assert_eq!(
            normalize_recovery_email(Some("  ".to_owned())).unwrap(),
            None
        );
        assert_eq!(
            normalize_recovery_email(Some("USER@GMAIL.COM".to_owned())).unwrap(),
            Some("user@gmail.com".to_owned())
        );
        assert!(normalize_recovery_email(Some("not-an-email".to_owned())).is_err());
    }

    #[test]
    fn passwords_are_hashed_and_verified() {
        let hash = hash_password("correct horse battery staple").unwrap();

        assert_ne!(hash, "correct horse battery staple");
        assert!(verify_password("correct horse battery staple", &hash).is_ok());
        assert!(verify_password("wrong password", &hash).is_err());
    }

    #[test]
    fn browser_sessions_use_five_hour_access_and_seven_day_refresh_windows() {
        let cookies = session_cookies("access".to_owned(), "refresh".to_owned(), false);

        assert_eq!(cookies.access.max_age().unwrap().whole_hours(), 5);
        assert_eq!(cookies.refresh.max_age().unwrap().whole_days(), 7);
        assert!(cookies.access.http_only().unwrap());
        assert!(cookies.refresh.http_only().unwrap());
    }

    #[test]
    fn rotated_session_tokens_are_new_opaque_values() {
        let first = new_token();
        let second = new_token();

        assert_ne!(first.0, second.0);
        assert_ne!(first.1, second.1);
        assert_ne!(first.0, first.1);
    }
}
