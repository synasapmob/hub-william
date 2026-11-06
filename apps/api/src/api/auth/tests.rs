use axum::{extract::State, http::StatusCode, response::IntoResponse};
use axum_extra::extract::{CookieJar, cookie::Cookie};

use super::{
    REFRESH_COOKIE, hash_password, new_token, normalize_recovery_email, normalize_username,
    session, session_cookies, verify_password,
};
use crate::core::{AppConfig, AppState};

fn state_without_database() -> AppState {
    AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://localhost/hub_william_test")
            .unwrap(),
    }
}

#[tokio::test]
async fn session_without_any_cookie_has_nothing_to_refresh() {
    let response = session(State(state_without_database()), CookieJar::new())
        .await
        .unwrap();

    assert_eq!(response.status(), StatusCode::NO_CONTENT);
}

#[tokio::test]
async fn session_with_only_a_refresh_cookie_asks_the_client_to_refresh() {
    let jar = CookieJar::new().add(Cookie::new(REFRESH_COOKIE, "refresh"));
    let error = session(State(state_without_database()), jar)
        .await
        .unwrap_err();

    assert_eq!(error.into_response().status(), StatusCode::UNAUTHORIZED);
}

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
    let cookies = session_cookies(
        "access".to_owned(),
        "refresh".to_owned(),
        &AppConfig::default(),
    );

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
