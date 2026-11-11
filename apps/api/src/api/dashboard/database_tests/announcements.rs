//! A message of the shop's own, sent through the bot.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{
    account, call, state, state_with_bot,
    support::{FakeBot, announced},
};
use crate::core::ShopKey;

#[sqlx::test]
async fn the_bot_is_asked_to_send_the_text_and_its_answer_comes_back(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 138 })).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_bot(pool, Some(&url));

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("  Nhập thêm 20 Claude Pro\nCòn 20 suất  ")),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "channel": true, "audience": 138 }));

    let received = bot.received();
    assert_eq!(received.len(), 1);
    let (path, token, sent) = &received[0];
    assert_eq!(path, "/internal/announce");
    // The secret the bot and the API share, and the text trimmed, nothing added.
    assert_eq!(token.as_deref(), Some("test-service-token"));
    assert_eq!(
        sent,
        &json!({ "text": "Nhập thêm 20 Claude Pro\nCòn 20 suất" })
    );
}

#[sqlx::test]
async fn the_bot_is_called_with_the_telegram_key_issued_in_shop_keys(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 1 })).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let mut state = state_with_bot(pool, Some(&url));
    // The former variable is still set, and the issued key wins over it.
    state.config.shop_keys = vec![ShopKey {
        name: "telegram".to_owned(),
        key: b"key-issued-in-shop-keys".to_vec(),
    }];

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("Hello")),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        bot.received()[0].1.as_deref(),
        Some("key-issued-in-shop-keys")
    );
}

#[sqlx::test]
async fn nothing_reaches_the_bot_unless_the_message_is_fit_to_send(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 1 })).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_bot(pool, Some(&url));

    for text in ["", "   ", "\n\t", &"a".repeat(4097)] {
        let (status, _) = call(
            &state,
            "POST",
            "/dashboard/telegram/announcements",
            Some(&owner.cookie),
            Some(announced(text)),
        )
        .await;

        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{} characters",
            text.len()
        );
    }
    assert!(bot.received().is_empty());

    // The limit is in characters, not bytes: 4,096 of a two-byte letter is fine.
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced(&"ă".repeat(4096))),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[sqlx::test]
async fn a_package_is_passed_on_so_the_bot_can_add_its_button(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 3 })).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_bot(pool, Some(&url));

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(json!({
            "text": "20% off up to five ChatGPT Business Standard seats",
            "product": "  ChatGPT-Business  "
        })),
    )
    .await;

    assert_eq!(status, StatusCode::OK);

    // The slug reaches the bot the way the catalogue spells it.
    let received = bot.received();
    assert_eq!(
        received[0].2,
        json!({
            "text": "20% off up to five ChatGPT Business Standard seats",
            "product": "chatgpt-business"
        })
    );
}

#[sqlx::test]
async fn nothing_reaches_the_bot_when_the_package_is_not_a_slug(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 1 })).await;
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state_with_bot(pool, Some(&url));

    for product in ["", "Claude Max", "a&b=c", &"a".repeat(65)] {
        let (status, _) = call(
            &state,
            "POST",
            "/dashboard/telegram/announcements",
            Some(&owner.cookie),
            Some(json!({ "text": "Hello", "product": product })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{product:?}");
    }
    assert!(bot.received().is_empty());
}

#[sqlx::test]
async fn it_says_so_when_the_dashboard_is_not_connected_to_a_bot(pool: PgPool) {
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state(pool);

    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("Hello")),
    )
    .await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["code"], "not_available");
    assert_eq!(
        body["message"],
        "The dashboard is not connected to the Telegram bot."
    );
}

#[sqlx::test]
async fn a_bot_that_is_down_or_refuses_is_reported_for_what_it_is(pool: PgPool) {
    let owner = account(&pool, Some(("owner", true))).await;

    // Nothing is listening.
    let nowhere = reqwest::Url::parse("http://127.0.0.1:1").unwrap();
    let state = state_with_bot(pool.clone(), Some(&nowhere));
    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("Hello")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
    assert_eq!(body["message"], "The Telegram bot did not answer.");

    // It answers with an error of its own.
    let (_, broken) = FakeBot::start(StatusCode::SERVICE_UNAVAILABLE, Value::Null).await;
    drop(broken);
    let (_bot, url) = FakeBot::start(StatusCode::SERVICE_UNAVAILABLE, Value::Null).await;
    let state = state_with_bot(pool.clone(), Some(&url));
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("Hello")),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);

    // It refuses the message itself.
    let (_bot, url) = FakeBot::start(StatusCode::UNPROCESSABLE_ENTITY, Value::Null).await;
    let state = state_with_bot(pool, Some(&url));
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&owner.cookie),
        Some(announced("Hello")),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[sqlx::test]
async fn only_roles_that_manage_stock_may_announce(pool: PgPool) {
    let (bot, url) =
        FakeBot::start(StatusCode::OK, json!({ "channel": true, "audience": 1 })).await;
    let state = state_with_bot(pool.clone(), Some(&url));

    for (role, expected) in [
        ("manager", StatusCode::OK),
        ("stock-keeper", StatusCode::OK),
        ("cashier", StatusCode::FORBIDDEN),
    ] {
        let member = account(&pool, Some((role, true))).await;
        let (status, _) = call(
            &state,
            "POST",
            "/dashboard/telegram/announcements",
            Some(&member.cookie),
            Some(announced("Hello")),
        )
        .await;

        assert_eq!(status, expected, "{role}");
    }

    let stranger = account(&pool, None).await;
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        Some(&stranger.cookie),
        Some(announced("Hello")),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/announcements",
        None,
        Some(announced("Hello")),
    )
    .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    // Two went through; the cashier, the stranger and the anonymous caller did not.
    assert_eq!(bot.received().len(), 2);
}
