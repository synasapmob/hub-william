use axum::http::{HeaderMap, HeaderValue};

use super::{GRANTS, Permission, identify, presented_key, secrets_match};
use crate::core::{AppConfig, ShopKey, TELEGRAM_KEY_NAME};

const BOT_KEY: &[u8] = b"bot-key-bot-key-bot-key-bot-key-00";
const SHOP_KEY: &[u8] = b"shop-key-shop-key-shop-key-shop-key";

fn config() -> AppConfig {
    AppConfig {
        shop_keys: vec![
            ShopKey {
                name: TELEGRAM_KEY_NAME.to_owned(),
                key: BOT_KEY.to_vec(),
            },
            ShopKey {
                name: "shopwatcher.org".to_owned(),
                key: SHOP_KEY.to_vec(),
            },
            ShopKey {
                name: "stranger".to_owned(),
                key: b"stranger-key-stranger-key-stranger".to_vec(),
            },
        ],
        ..AppConfig::default()
    }
}

fn headers(name: &'static str, value: &[u8]) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(name, HeaderValue::from_bytes(value).unwrap());
    headers
}

#[test]
fn secrets_require_an_exact_match() {
    assert!(secrets_match(b"shared-secret", b"shared-secret"));
    assert!(!secrets_match(b"shared-secret", b"shared-secrex"));
    assert!(!secrets_match(b"shared-secret", b"shared-secret-more"));
}

#[test]
fn a_key_is_read_from_a_bearer_token_or_the_bot_header() {
    assert_eq!(
        presented_key(&headers("authorization", b"Bearer abc")),
        Some(&b"abc"[..])
    );
    assert_eq!(
        presented_key(&headers("authorization", b"bearer  abc ")),
        Some(&b"abc"[..])
    );
    assert_eq!(
        presented_key(&headers("x-hub-william-telegram-token", b"abc")),
        Some(&b"abc"[..])
    );
}

#[test]
fn a_blank_or_other_kind_of_credential_is_no_key() {
    assert_eq!(presented_key(&HeaderMap::new()), None);
    assert_eq!(presented_key(&headers("authorization", b"Bearer ")), None);
    assert_eq!(presented_key(&headers("authorization", b"Basic abc")), None);
    assert_eq!(presented_key(&headers("authorization", b"Bearer")), None);
}

#[test]
fn a_key_identifies_the_name_it_was_issued_to() {
    let config = config();

    let bot = identify(
        &config,
        &headers("authorization", &[b"Bearer ", BOT_KEY].concat()),
    );
    let shop = identify(&config, &headers("x-hub-william-telegram-token", SHOP_KEY));

    assert_eq!(bot.unwrap().name(), "telegram");
    assert_eq!(shop.unwrap().name(), "shopwatcher.org");
}

#[test]
fn an_unknown_key_identifies_nobody() {
    let config = config();

    assert!(identify(&config, &headers("authorization", b"Bearer nobody")).is_none());
    assert!(identify(&config, &HeaderMap::new()).is_none());
    assert!(
        identify(
            &AppConfig::default(),
            &headers("authorization", b"Bearer x")
        )
        .is_none()
    );
}

#[test]
fn with_no_telegram_key_issued_nothing_opens_the_bots_routes() {
    let config = AppConfig {
        shop_keys: vec![ShopKey {
            name: "shopwatcher.org".to_owned(),
            key: SHOP_KEY.to_vec(),
        }],
        ..AppConfig::default()
    };

    let shop = identify(&config, &headers("x-hub-william-telegram-token", SHOP_KEY));

    assert!(!shop.unwrap().can(Permission::Internal));
}

#[test]
fn each_name_may_do_only_what_the_table_gives_it() {
    let config = config();
    let caller = |key: &[u8]| {
        identify(
            &config,
            &headers("authorization", &[b"Bearer ", key].concat()),
        )
        .unwrap()
    };

    let bot = caller(BOT_KEY);
    let shop = caller(SHOP_KEY);

    assert!(bot.can(Permission::Internal));
    assert!(!bot.can(Permission::ProductsRead));
    assert!(shop.can(Permission::ProductsRead));
    assert!(!shop.can(Permission::Internal));
    assert!(shop.require(Permission::Internal).is_err());
}

#[test]
fn a_key_whose_name_has_no_line_in_the_table_may_do_nothing() {
    let config = config();
    let stranger = identify(
        &config,
        &headers(
            "authorization",
            b"Bearer stranger-key-stranger-key-stranger",
        ),
    )
    .unwrap();

    assert!(!stranger.can(Permission::Internal));
    assert!(!stranger.can(Permission::ProductsRead));
}

#[test]
fn only_the_bot_may_hold_the_internal_permission() {
    for (name, granted) in GRANTS {
        assert_eq!(
            granted.contains(&Permission::Internal),
            *name == TELEGRAM_KEY_NAME,
            "{name}"
        );
    }
}
