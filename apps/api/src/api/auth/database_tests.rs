//! Signing in at two places: the cookies of one API are not another's, and two
//! requests that refresh together do not sign the person out.

use axum::{Json, extract::State, http::StatusCode};
use axum_extra::extract::CookieJar;
use sqlx::PgPool;

use super::{
    LoginRequest, REFRESH_COOKIE, RegisterRequest, SESSION_COOKIE, login, logout, refresh,
    register, session,
};
use crate::core::{ApiError, AppConfig, AppState};

const PASSWORD: &str = "a-fake-password-for-tests";

fn api(pool: &PgPool, cookie_name_suffix: &str) -> AppState {
    AppState {
        config: AppConfig {
            cookie_name_suffix: cookie_name_suffix.to_owned(),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: pool.clone(),
    }
}

/// Makes the account and returns the cookies of the session that makes it.
async fn sign_up(state: &AppState, username: &str) -> CookieJar {
    let (jar, _) = register(
        State(state.clone()),
        CookieJar::new(),
        Json(RegisterRequest {
            username: username.to_owned(),
            password: PASSWORD.to_owned(),
            recovery_email: None,
        }),
    )
    .await
    .unwrap();

    jar
}

async fn sign_in(state: &AppState, username: &str) -> CookieJar {
    let (jar, _) = login(
        State(state.clone()),
        CookieJar::new(),
        Json(LoginRequest {
            username: username.to_owned(),
            password: PASSWORD.to_owned(),
        }),
    )
    .await
    .unwrap();

    jar
}

/// What `/auth/session` says for these cookies: the status it answers.
async fn session_status(state: &AppState, jar: &CookieJar) -> StatusCode {
    match session(State(state.clone()), jar.clone()).await {
        Ok(response) => response.status(),
        Err(error) => axum::response::IntoResponse::into_response(error).status(),
    }
}

fn cookie(jar: &CookieJar, name: &str) -> String {
    jar.get(name)
        .unwrap_or_else(|| panic!("no cookie {name}"))
        .value()
        .to_owned()
}

#[sqlx::test]
async fn a_session_cookie_is_named_by_the_api_that_made_it(pool: PgPool) {
    let jar = sign_up(&api(&pool, "_8099"), "ann").await;

    assert!(jar.get("hub_session_8099").is_some());
    assert!(jar.get("hub_refresh_8099").is_some());
    assert!(jar.get(SESSION_COOKIE).is_none());
    assert!(jar.get(REFRESH_COOKIE).is_none());
}

#[sqlx::test]
async fn behind_https_the_names_stay_plain(pool: PgPool) {
    let jar = sign_up(&api(&pool, ""), "ann").await;

    assert!(jar.get(SESSION_COOKIE).is_some());
    assert!(jar.get(REFRESH_COOKIE).is_some());
}

#[sqlx::test]
async fn an_api_does_not_read_the_cookies_of_another_on_the_same_host(pool: PgPool) {
    // Two APIs on localhost, ports 8080 and 8099. The browser sends both cookies to
    // both, since it does not tell ports apart.
    let first = api(&pool, "_8080");
    let second = api(&pool, "_8099");
    let _ = sign_up(&first, "ann").await;
    let on_first = sign_in(&first, "ann").await;
    let on_second = sign_in(&second, "ann").await;
    let browser = on_first.add(on_second.get("hub_session_8099").unwrap().clone());
    let browser = browser.add(on_second.get("hub_refresh_8099").unwrap().clone());

    // Signing in at the second did not sign the person out of the first.
    assert_eq!(session_status(&first, &browser).await, StatusCode::OK);
    assert_eq!(session_status(&second, &browser).await, StatusCode::OK);
    // Each sees only its own cookie, so each keeps its own session.
    let only_second = CookieJar::new().add(on_second.get("hub_session_8099").unwrap().clone());
    assert_eq!(
        session_status(&first, &only_second).await,
        StatusCode::NO_CONTENT
    );
}

#[sqlx::test]
async fn signing_in_again_does_not_end_the_session_that_is_open(pool: PgPool) {
    let state = api(&pool, "");
    let _ = sign_up(&state, "ann").await;
    let here = sign_in(&state, "ann").await;
    let there = sign_in(&state, "ann").await;

    assert_eq!(session_status(&state, &here).await, StatusCode::OK);
    assert_eq!(session_status(&state, &there).await, StatusCode::OK);
    let (jar, _) = logout(State(state.clone()), there.clone()).await;
    drop(jar);
    assert_eq!(session_status(&state, &here).await, StatusCode::OK);
    assert_eq!(
        session_status(&state, &there).await,
        StatusCode::UNAUTHORIZED,
        "signing out ends that session only"
    );
}

#[sqlx::test]
async fn a_refresh_replaces_both_tokens(pool: PgPool) {
    let state = api(&pool, "");
    let old = sign_up(&state, "ann").await;

    let (new, _) = refresh(State(state.clone()), old.clone()).await.unwrap();

    assert_ne!(cookie(&new, SESSION_COOKIE), cookie(&old, SESSION_COOKIE));
    assert_ne!(cookie(&new, REFRESH_COOKIE), cookie(&old, REFRESH_COOKIE));
    assert_eq!(session_status(&state, &new).await, StatusCode::OK);
    assert_eq!(
        session_status(&state, &old).await,
        StatusCode::UNAUTHORIZED,
        "the access token it replaced no longer opens anything"
    );
}

#[sqlx::test]
async fn a_refresh_token_that_was_just_replaced_still_gets_an_access_session(pool: PgPool) {
    let state = api(&pool, "");
    let old = sign_up(&state, "ann").await;
    let (winner, _) = refresh(State(state.clone()), old.clone()).await.unwrap();

    // The request that came in second, carrying the token the first replaced.
    let (loser, body) = refresh(State(state.clone()), old.clone()).await.unwrap();

    assert_eq!(body.0.user.username, "ann");
    assert!(loser.get(SESSION_COOKIE).is_some(), "a new access session");
    // It is not given a refresh token of its own: the one in the winner's answer is
    // the session's, and is left as it is.
    assert_eq!(
        cookie(&loser, REFRESH_COOKIE),
        cookie(&old, REFRESH_COOKIE),
        "the refresh cookie the request came with is left alone"
    );
    assert_eq!(session_status(&state, &loser).await, StatusCode::OK);
    // And the session carries on with the winner's refresh token.
    let next = winner.add(loser.get(SESSION_COOKIE).unwrap().clone());
    assert_eq!(session_status(&state, &next).await, StatusCode::OK);
    let _ = refresh(State(state.clone()), next).await.unwrap();
}

#[sqlx::test]
async fn the_refresh_token_that_was_replaced_is_known_only_for_a_moment(pool: PgPool) {
    let state = api(&pool, "");
    let old = sign_up(&state, "ann").await;
    let _ = refresh(State(state.clone()), old.clone()).await.unwrap();

    sqlx::query("UPDATE sessions SET previous_refresh_valid_until = NOW() - INTERVAL '1 second'")
        .execute(&pool)
        .await
        .unwrap();

    assert!(matches!(
        refresh(State(state.clone()), old).await,
        Err(ApiError::Unauthorized)
    ));
}

#[sqlx::test]
async fn only_the_one_refresh_token_before_is_known(pool: PgPool) {
    let state = api(&pool, "");
    let first = sign_up(&state, "ann").await;
    let (second, _) = refresh(State(state.clone()), first.clone()).await.unwrap();
    let (third, _) = refresh(State(state.clone()), second.clone()).await.unwrap();

    // The token before the last is known; the one before that is not.
    let _ = refresh(State(state.clone()), second).await.unwrap();
    assert!(matches!(
        refresh(State(state.clone()), first).await,
        Err(ApiError::Unauthorized)
    ));
    // The newest still works.
    let _ = refresh(State(state), third).await.unwrap();
}

#[sqlx::test]
async fn many_refreshes_at_once_do_not_sign_anyone_out(pool: PgPool) {
    let state = api(&pool, "");
    let jar = sign_up(&state, "ann").await;
    let old_refresh = cookie(&jar, REFRESH_COOKIE);

    let refreshes = (0..8).map(|_| {
        let state = state.clone();
        let jar = jar.clone();
        tokio::spawn(async move { refresh(State(state), jar).await })
    });
    let mut answered = Vec::new();
    for refresh in refreshes.collect::<Vec<_>>() {
        let (jar, _) = refresh.await.unwrap().expect("no refresh is refused");
        answered.push(jar);
    }

    // One of them replaced the refresh token; the others were let through on the
    // one it replaced and were left with the refresh cookie they came with.
    let winners: Vec<&CookieJar> = answered
        .iter()
        .filter(|jar| cookie(jar, REFRESH_COOKIE) != old_refresh)
        .collect();
    assert_eq!(winners.len(), 1);
    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 1, "refreshing never adds a session");
    // Whatever order the answers reach the browser in, the person can go on: the
    // refresh token of the one that replaced it is the session's.
    let _ = refresh(State(state), winners[0].clone()).await.unwrap();
}

#[sqlx::test]
async fn signing_out_with_a_refresh_token_that_was_just_replaced_ends_the_session(pool: PgPool) {
    let state = api(&pool, "");
    let old = sign_up(&state, "ann").await;
    let (new, _) = refresh(State(state.clone()), old.clone()).await.unwrap();

    // The tab that still holds the old refresh cookie signs out.
    let only_old_refresh = CookieJar::new().add(old.get(REFRESH_COOKIE).unwrap().clone());
    let _ = logout(State(state.clone()), only_old_refresh).await;

    let sessions: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(sessions, 0, "the session is gone");
    assert_eq!(session_status(&state, &new).await, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn an_unknown_refresh_token_is_refused(pool: PgPool) {
    let state = api(&pool, "");
    let jar = CookieJar::new().add(axum_extra::extract::cookie::Cookie::new(
        REFRESH_COOKIE,
        "not-a-token",
    ));

    assert!(matches!(
        refresh(State(state), jar).await,
        Err(ApiError::Unauthorized)
    ));
}
