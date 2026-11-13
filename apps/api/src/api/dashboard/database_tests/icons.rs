//! The icons beside the providers: that a picture reaches the bucket as it should,
//! that only stock staff may change them, and that a provider shows what it was given.

use axum::{body::Body, http::StatusCode};
use serde_json::{Value, json};
use sqlx::PgPool;

use crate::{
    core::{AppConfig, AppState, IconStorage},
    utils::object_storage::tests::FakeBucket,
};

use super::{PNG, account, call, send};

fn state_with_icons(pool: PgPool, storage: Option<IconStorage>) -> AppState {
    AppState {
        config: AppConfig {
            icon_storage: storage,
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

async fn upload(state: &AppState, cookie: &str, name: &str, bytes: Vec<u8>) -> (StatusCode, Value) {
    let (status, body, _) = send(
        state,
        "POST",
        &format!("/dashboard/icons?name={name}"),
        Some(cookie),
        "application/octet-stream",
        Body::from(bytes),
    )
    .await;

    (status, serde_json::from_slice(&body).unwrap_or(Value::Null))
}

#[sqlx::test]
async fn a_picture_is_stored_under_a_name_made_from_the_provider_and_the_bytes(pool: PgPool) {
    let (bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("stock-keeper", true))).await;
    let state = state_with_icons(pool, Some(storage));

    let (status, body) = upload(&state, &owner.cookie, "ChatGPT", PNG.to_vec()).await;

    assert_eq!(status, StatusCode::CREATED);
    let key = body["key"].as_str().unwrap();
    assert!(
        key.starts_with("icons/chatgpt-") && key.ends_with(".png"),
        "{key}"
    );
    assert_eq!(body["url"], format!("https://cdn.test/{key}"));

    let (content_type, cache_control, bytes) = bucket.object(key).unwrap();
    assert_eq!(content_type, "image/png");
    assert_eq!(cache_control, "public, max-age=31536000, immutable");
    assert_eq!(bytes, PNG);

    // Sent again, it is the same object and not a second one.
    let (_, again) = upload(&state, &owner.cookie, "ChatGPT", PNG.to_vec()).await;
    assert_eq!(again["key"], body["key"]);
    assert_eq!(bucket.keys().len(), 1);
}

#[sqlx::test]
async fn what_is_not_a_picture_or_is_too_big_is_refused_and_nothing_is_stored(pool: PgPool) {
    let (bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_icons(pool, Some(storage));

    // An SVG says it is an image and is not one of the kinds allowed: it can carry a script.
    let svg = br#"<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>"#;
    let (status, _) = upload(&state, &owner.cookie, "x", svg.to_vec()).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Just over the limit, and well over it.
    let mut just_over = PNG.to_vec();
    just_over.resize(256 * 1024 + 1, 0);
    let (status, _) = upload(&state, &owner.cookie, "x", just_over).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let mut huge = PNG.to_vec();
    huge.resize(300 * 1024, 0);
    let (status, _) = upload(&state, &owner.cookie, "x", huge).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);

    assert!(bucket.keys().is_empty());
}

#[sqlx::test]
async fn only_staff_who_manage_stock_may_change_icons_and_any_staff_may_see_them(pool: PgPool) {
    let (bucket, storage) = FakeBucket::start().await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    let stranger = account(&pool, None).await;
    let removed = account(&pool, Some(("owner", false))).await;
    let state = state_with_icons(pool, Some(storage));

    for who in [&cashier, &stranger, &removed] {
        let (status, _) = upload(&state, &who.cookie, "x", PNG.to_vec()).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/icons/library",
            Some(&who.cookie),
            None,
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
        let (status, _) = call(
            &state,
            "PUT",
            "/dashboard/icons/providers/claude",
            Some(&who.cookie),
            Some(json!({ "key": "icons/claude-1.png" })),
        )
        .await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }
    assert!(bucket.keys().is_empty());

    // A cashier sees the provider cards, so reads which icons they show.
    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/icons",
        Some(&cashier.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    for who in [&stranger, &removed] {
        let (status, _) = call(&state, "GET", "/dashboard/icons", Some(&who.cookie), None).await;
        assert_eq!(status, StatusCode::FORBIDDEN);
    }

    // Nobody signed in gets nothing, whatever they ask.
    let (status, _) = call(&state, "GET", "/dashboard/icons", None, None).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _, _) = send(
        &state,
        "POST",
        "/dashboard/icons",
        None,
        "application/octet-stream",
        Body::from(PNG.to_vec()),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[sqlx::test]
async fn the_library_is_what_the_bucket_holds_under_icons(pool: PgPool) {
    let (bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_icons(pool, Some(storage));
    let (_, claude) = upload(&state, &owner.cookie, "Claude", PNG.to_vec()).await;
    let (_, groq) = upload(&state, &owner.cookie, "Groq", [PNG, &[1]].concat()).await;
    // Something put in by hand that is not under `icons/`, and a name no icon has.
    crate::utils::object_storage::put_object(
        &reqwest::Client::new(),
        state.config.icon_storage.as_ref().unwrap(),
        "other/readme.png",
        "image/png",
        "no-cache",
        vec![1],
    )
    .await
    .unwrap();
    assert_eq!(bucket.keys().len(), 3);

    let (status, body) = call(
        &state,
        "GET",
        "/dashboard/icons/library",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let keys: Vec<&str> = body["icons"]
        .as_array()
        .unwrap()
        .iter()
        .map(|icon| icon["key"].as_str().unwrap())
        .collect();
    assert_eq!(
        keys,
        [
            claude["key"].as_str().unwrap(),
            groq["key"].as_str().unwrap()
        ]
    );
    assert_eq!(body["icons"][0]["size"], PNG.len());
    assert_eq!(
        body["icons"][0]["url"],
        format!("https://cdn.test/{}", keys[0])
    );
}

#[sqlx::test]
async fn a_provider_shows_the_icon_it_was_given_until_it_is_given_another_or_none(pool: PgPool) {
    let (_bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("manager", true))).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    let state = state_with_icons(pool, Some(storage));
    let assign = |provider: &'static str, key: Value| {
        let (state, cookie) = (state.clone(), owner.cookie.clone());
        async move {
            call(
                &state,
                "PUT",
                &format!("/dashboard/icons/providers/{provider}"),
                Some(&cookie),
                Some(json!({ "key": key })),
            )
            .await
        }
    };

    let (status, body) = call(
        &state,
        "GET",
        "/dashboard/icons",
        Some(&cashier.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": true, "assignments": [] }));

    let (status, body) = assign("chatgpt", json!("icons/chatgpt-1.png")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "provider": "chatgpt", "key": "icons/chatgpt-1.png", "url": "https://cdn.test/icons/chatgpt-1.png" })
    );
    assign("claude", json!("icons/claude-1.png")).await;
    assign("chatgpt", json!("icons/chatgpt-2.png")).await;

    let (_, body) = call(
        &state,
        "GET",
        "/dashboard/icons",
        Some(&cashier.cookie),
        None,
    )
    .await;
    assert_eq!(
        body,
        json!({ "enabled": true, "assignments": [
            { "provider": "chatgpt", "key": "icons/chatgpt-2.png", "url": "https://cdn.test/icons/chatgpt-2.png" },
            { "provider": "claude", "key": "icons/claude-1.png", "url": "https://cdn.test/icons/claude-1.png" },
        ] })
    );

    let (status, body) = assign("chatgpt", Value::Null).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body,
        json!({ "provider": "chatgpt", "key": null, "url": null })
    );
    let (_, body) = call(
        &state,
        "GET",
        "/dashboard/icons",
        Some(&cashier.cookie),
        None,
    )
    .await;
    assert_eq!(body["assignments"].as_array().unwrap().len(), 1);
}

#[sqlx::test]
async fn a_provider_or_an_icon_that_is_not_a_name_is_refused(pool: PgPool) {
    let (_bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_icons(pool.clone(), Some(storage));

    for (provider, key) in [
        ("ChatGPT", "icons/a.png"),
        ("a%20b", "icons/a.png"),
        ("claude", "icons/../a.png"),
        ("claude", "other/a.png"),
        ("claude", "icons/A.png"),
        ("claude", "https://evil.example/a.png"),
    ] {
        let (status, _) = call(
            &state,
            "PUT",
            &format!("/dashboard/icons/providers/{provider}"),
            Some(&owner.cookie),
            Some(json!({ "key": key })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{provider} {key}");
    }
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dashboard_provider_icons")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}

#[sqlx::test]
async fn without_a_bucket_nothing_is_shown_and_nothing_can_be_changed(pool: PgPool) {
    let owner = account(&pool, Some(("owner", true))).await;
    // An assignment made while the bucket was set up must not leak an address now.
    sqlx::query("INSERT INTO dashboard_provider_icons (provider, icon) VALUES ('claude', 'icons/claude-1.png')")
        .execute(&pool)
        .await
        .unwrap();
    let state = state_with_icons(pool, None);

    let (status, body) = call(&state, "GET", "/dashboard/icons", Some(&owner.cookie), None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": false, "assignments": [] }));

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/icons/library",
        Some(&owner.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, _) = upload(&state, &owner.cookie, "x", PNG.to_vec()).await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/icons/providers/claude",
        Some(&owner.cookie),
        Some(json!({ "key": "icons/claude-2.png" })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
}

#[sqlx::test]
async fn a_bucket_that_does_not_answer_is_a_bad_gateway_and_leaves_the_shop_as_it_was(
    pool: PgPool,
) {
    let (bucket, storage) = FakeBucket::start().await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_icons(pool, Some(storage));
    bucket.refuse_with(StatusCode::SERVICE_UNAVAILABLE);

    let (status, body) = upload(&state, &owner.cookie, "x", PNG.to_vec()).await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    // What the bucket said is not passed on.
    assert!(!body.to_string().contains("503"));
    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/icons/library",
        Some(&owner.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);

    // The pictures shown so far are in the database, which does not depend on it.
    let (status, _) = call(&state, "GET", "/dashboard/icons", Some(&owner.cookie), None).await;
    assert_eq!(status, StatusCode::OK);
}
