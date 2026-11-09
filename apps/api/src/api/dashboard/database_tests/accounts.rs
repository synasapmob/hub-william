//! Accounts a package hands to a buyer: loaded encrypted, counted, and never
//! shown again. Every account in these tests is made up.

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use super::{account, call, new_product, owner_and_state, product_in, state};
use crate::{
    api::{app, telegram::accounts},
    core::AppState,
};

pub(super) const SLUG: &str = "acme-pro";

pub(super) fn delivering_product(plan: &str) -> Value {
    let mut product = new_product(plan);
    product["available"] = json!(0);
    product["delivers_accounts"] = json!(true);
    product
}

fn accounts_block(lines: &[&str]) -> Value {
    json!({ "accounts": lines.join("\n") })
}

pub(super) async fn make_package(state: &AppState, cookie: Option<&str>) {
    let (status, created) = call(
        state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(delivering_product("Pro")),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["delivers_accounts"], true);
}

pub(super) async fn load(
    state: &AppState,
    cookie: Option<&str>,
    lines: &[&str],
) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        &format!("/dashboard/telegram/products/{SLUG}/accounts"),
        cookie,
        Some(accounts_block(lines)),
    )
    .await
}

pub(super) async fn stored(pool: &PgPool) -> Vec<(Uuid, Vec<u8>, Vec<u8>, Vec<u8>)> {
    sqlx::query_as(
        "SELECT account.id, account.nonce, account.ciphertext, account.fingerprint
         FROM telegram_stock_accounts AS account
         JOIN telegram_products AS product ON product.id = account.product_id
         WHERE product.slug = $1
         ORDER BY account.created_at",
    )
    .bind(SLUG)
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test]
async fn a_package_that_hands_out_accounts_starts_empty_and_counts_what_is_loaded(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());

    // It starts with none: its count is the accounts loaded, not a number typed in.
    let mut with_count = delivering_product("Pro");
    with_count["available"] = json!(5);
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(with_count),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    make_package(&state, cookie).await;

    let (status, first) = load(
        &state,
        cookie,
        &[
            "one@example.test|first",
            "two@example.test|second",
            "three@example.test|third",
        ],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        first,
        json!({ "added": 3, "available": 3, "duplicates": 0 })
    );

    // A line it already has, even typed with other spaces, is left alone.
    let (status, second) = load(
        &state,
        cookie,
        &["two@example.test | second", "four@example.test|fourth"],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        second,
        json!({ "added": 1, "available": 4, "duplicates": 1 })
    );

    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    let product = product_in(&listing, SLUG);
    assert_eq!(product["delivers_accounts"], true);
    assert_eq!(product["on_hand"], 4);
    assert_eq!(product["available"], 4);

    // Each load is on the record, with who made it.
    let changes: Vec<(i32, i32, Uuid)> = sqlx::query_as(
        "SELECT delta, available_after, changed_by FROM telegram_stock_changes
         WHERE product_id = (SELECT id FROM telegram_products WHERE slug = $1)
         ORDER BY created_at",
    )
    .bind(SLUG)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(changes, [(3, 3, owner.id), (1, 4, owner.id)]);
}

#[sqlx::test]
async fn nothing_readable_is_stored_and_no_response_returns_an_account(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;

    let lines = [
        "someone@example.test|pa55word-one",
        "another@example.test|pa55word-two",
    ];
    let (_, loaded) = load(&state, cookie, &lines).await;
    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;

    // What comes back is counts and nothing else.
    for response in [loaded.to_string(), listing.to_string()] {
        for needle in ["someone", "another", "pa55word", "example.test"] {
            assert!(!response.contains(needle), "{needle} in {response}");
        }
    }

    let rows = stored(&pool).await;
    assert_eq!(rows.len(), 2);
    let key = state.config.stock_encryption_key.unwrap();
    let mut opened = Vec::new();
    for (id, nonce, ciphertext, fingerprint) in &rows {
        let bytes = [
            nonce.as_slice(),
            ciphertext.as_slice(),
            fingerprint.as_slice(),
        ]
        .concat();
        for needle in ["someone", "another", "pa55word", "example"] {
            assert!(
                !bytes
                    .windows(needle.len())
                    .any(|window| window == needle.as_bytes()),
                "{needle}"
            );
        }
        // The ciphertext is the account, for its own row and its own key only.
        opened.push(accounts::open(&key, *id, nonce, ciphertext).unwrap());
        assert!(accounts::open(&key, Uuid::new_v4(), nonce, ciphertext).is_err());
        assert!(accounts::open(&[1; 32], *id, nonce, ciphertext).is_err());
    }
    opened.sort();
    assert_eq!(
        opened,
        [
            "another@example.test|pa55word-two",
            "someone@example.test|pa55word-one"
        ]
    );
}

#[sqlx::test]
async fn a_bad_line_stores_nothing_and_is_not_quoted_back(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;

    let (status, body) = load(
        &state,
        cookie,
        &["good@example.test|fine", "secret-line-without-a-bar"],
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!body.to_string().contains("secret-line"), "{body}");
    assert!(stored(&pool).await.is_empty());
    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    assert_eq!(product_in(&listing, SLUG)["available"], 0);
}

#[sqlx::test]
async fn a_package_that_does_not_hand_out_accounts_takes_none(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Pro")),
    )
    .await;

    let (status, _) = load(&state, cookie, &["a@example.test|x"]).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(stored(&pool).await.is_empty());

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products/no-such-package/accounts",
        cookie,
        Some(accounts_block(&["a@example.test|x"])),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn without_the_key_nothing_is_loaded(pool: PgPool) {
    let (mut state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    state.config.stock_encryption_key = None;

    let (status, body) = load(&state, cookie, &["a@example.test|x"]).await;

    assert_eq!(status, StatusCode::NOT_IMPLEMENTED);
    assert_eq!(body["code"], "not_available");
    assert!(stored(&pool).await.is_empty());
}

#[sqlx::test]
async fn only_roles_that_manage_stock_may_load_accounts(pool: PgPool) {
    let state = state(pool.clone());
    let owner = account(&pool, Some(("owner", true))).await;
    make_package(&state, Some(owner.cookie.as_str())).await;

    for (role, expected) in [
        ("manager", StatusCode::OK),
        ("stock-keeper", StatusCode::OK),
        ("cashier", StatusCode::FORBIDDEN),
    ] {
        let member = account(&pool, Some((role, true))).await;
        let line = format!("{role}@example.test|x");
        let (status, _) = load(&state, Some(member.cookie.as_str()), &[line.as_str()]).await;

        assert_eq!(status, expected, "{role}");
    }
    let stranger = account(&pool, None).await;
    let (status, _) = load(
        &state,
        Some(stranger.cookie.as_str()),
        &["a@example.test|x"],
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = load(&state, None, &["a@example.test|x"]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    assert_eq!(stored(&pool).await.len(), 2);
}

#[sqlx::test]
async fn the_count_of_such_a_package_cannot_be_set_by_hand(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|x", "b@example.test|y"]).await;

    // From the dashboard, up or down.
    for delta in [5, -1] {
        let (status, _) = call(
            &state,
            "POST",
            &format!("/dashboard/telegram/products/{SLUG}/stock"),
            cookie,
            Some(json!({ "delta": delta })),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{delta}");
    }

    // From the bot's side, where the owner adds stock by typing a number.
    let restock = app(state.clone())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri(format!("/internal/telegram/products/{SLUG}/restock"))
                .header("content-type", "application/json")
                .header("x-hub-william-telegram-token", "test-service-token")
                .body(Body::from(json!({ "added": 5 }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = restock.status();
    let _ = to_bytes(restock.into_body(), usize::MAX).await.unwrap();
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    assert_eq!(product_in(&listing, SLUG)["on_hand"], 2);
}

#[sqlx::test]
async fn deleting_the_package_takes_its_accounts_with_it(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|x"]).await;
    assert_eq!(stored(&pool).await.len(), 1);

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/telegram/products/{SLUG}"),
        cookie,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NO_CONTENT);
    let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(left, 0);
}

#[sqlx::test]
async fn packages_that_do_not_hand_out_accounts_are_untouched(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let (_, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Plus")),
    )
    .await;

    assert_eq!(created["delivers_accounts"], false);
    let (status, after) = call(
        &state,
        "POST",
        "/dashboard/telegram/products/acme-plus/stock",
        cookie,
        Some(json!({ "delta": 5 })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(after["on_hand"], 15);
}

// -------------------------------------------- who loaded what, and changing it

async fn list(state: &AppState, cookie: Option<&str>) -> (StatusCode, Value) {
    call(
        state,
        "GET",
        &format!("/dashboard/telegram/products/{SLUG}/accounts"),
        cookie,
        None,
    )
    .await
}

/// The password the account's owner can be asked for, as a real hash.
async fn give_password(pool: &PgPool, user: Uuid, password: &str) {
    sqlx::query("UPDATE users SET password_hash = $2 WHERE id = $1")
        .bind(user)
        .bind(crate::api::auth::hash_password(password).unwrap())
        .execute(pool)
        .await
        .unwrap();
}

async fn reveal(
    state: &AppState,
    cookie: Option<&str>,
    id: &str,
    password: &str,
) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/dashboard/telegram/accounts/reveal",
        cookie,
        Some(json!({ "ids": [id], "password": password })),
    )
    .await
}

async fn views(pool: &PgPool) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM telegram_stock_account_views")
        .fetch_one(pool)
        .await
        .unwrap()
}

fn emails(list: &Value) -> Vec<String> {
    let mut hints: Vec<String> = list["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|account| account["email_hint"].as_str().unwrap().to_owned())
        .collect();
    hints.sort();
    hints
}

#[sqlx::test]
async fn the_list_names_who_loaded_each_account_and_shows_no_email_in_full_and_no_password(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(
        &state,
        cookie,
        &[
            "someone@example.test|pa55word-one",
            "plain-login|pa55word-two",
        ],
    )
    .await;

    let (status, body) = list(&state, cookie).await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(emails(&body), ["p***", "s***@example.test"]);
    for account in body["accounts"].as_array().unwrap() {
        assert_eq!(account["loaded_by"], owner.username);
        assert!(account["order_reference"].is_null());
        assert!(account["sold_at"].is_null());
    }
    let text = body.to_string();
    for needle in ["someone@", "pa55word", "plain-login"] {
        assert!(!text.contains(needle), "{needle} in {text}");
    }
}

#[sqlx::test]
async fn a_collaborator_who_only_loads_stock_sees_only_what_they_loaded(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(
        &state,
        Some(owner.cookie.as_str()),
        &["owner-one@example.test|x", "owner-two@example.test|x"],
    )
    .await;
    load(
        &state,
        Some(keeper.cookie.as_str()),
        &["keeper@example.test|x"],
    )
    .await;

    let (_, theirs) = list(&state, Some(keeper.cookie.as_str())).await;
    let (_, all) = list(&state, Some(owner.cookie.as_str())).await;

    assert_eq!(emails(&theirs), ["k***@example.test"]);
    assert_eq!(all["accounts"].as_array().unwrap().len(), 3);
    // Nobody signed in, and a role with no stock access, see nothing.
    assert_eq!(list(&state, None).await.0, StatusCode::UNAUTHORIZED);
    let cashier = account(&pool, Some(("cashier", true))).await;
    assert_eq!(
        list(&state, Some(cashier.cookie.as_str())).await.0,
        StatusCode::FORBIDDEN
    );
}

#[sqlx::test]
async fn a_line_is_an_account_whatever_its_email_and_only_the_same_line_twice_is_a_repeat(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;

    // One email with three passwords is three accounts; the first line typed
    // again, with the email in another case, is the same account twice.
    let (status, body) = load(
        &state,
        cookie,
        &[
            "Someone@Example.test|pass-1",
            "someone@example.test|pass-2",
            "someone@example.test|pass-3",
            "someone@example.TEST|pass-1",
        ],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "added": 3, "available": 3, "duplicates": 1 }));
    let key = state.config.stock_encryption_key.unwrap();
    let mut lines: Vec<String> = stored(&pool)
        .await
        .iter()
        .map(|(id, nonce, ciphertext, _)| accounts::open(&key, *id, nonce, ciphertext).unwrap())
        .collect();
    lines.sort();
    assert_eq!(
        lines,
        [
            "Someone@Example.test|pass-1",
            "someone@example.test|pass-2",
            "someone@example.test|pass-3"
        ]
    );

    // Loading some of it again adds only what is new.
    let (_, again) = load(
        &state,
        cookie,
        &["someone@example.test|pass-2", "someone@example.test|pass-4"],
    )
    .await;
    assert_eq!(
        again,
        json!({ "added": 1, "available": 4, "duplicates": 1 })
    );
}

#[sqlx::test]
async fn an_email_that_was_already_sold_is_loaded_again_as_a_new_account(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["reused@example.test|first-life"]).await;
    sqlx::query(
        "UPDATE telegram_stock_accounts SET order_reference = 'SOLD00000001', sold_at = NOW()",
    )
    .execute(&pool)
    .await
    .unwrap();

    let (_, body) = load(&state, cookie, &["reused@example.test|second-life"]).await;

    assert_eq!(body["added"], 1);
    assert_eq!(stored(&pool).await.len(), 2);
}

#[sqlx::test]
async fn an_unsold_account_can_be_taken_out_and_the_count_follows(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(
        &state,
        Some(owner.cookie.as_str()),
        &["a@example.test|1", "b@example.test|2"],
    )
    .await;
    load(&state, Some(keeper.cookie.as_str()), &["c@example.test|3"]).await;
    let ids: Vec<(Uuid, Option<String>)> = sqlx::query_as(
        "SELECT account.id, loader.username FROM telegram_stock_accounts AS account
         LEFT JOIN users AS loader ON loader.id = account.loaded_by ORDER BY account.created_at, account.id",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let theirs = ids
        .iter()
        .find(|(_, who)| who.as_deref() == Some(keeper.username.as_str()))
        .unwrap()
        .0;
    let owners = ids
        .iter()
        .find(|(_, who)| who.as_deref() == Some(owner.username.as_str()))
        .unwrap()
        .0;
    let delete = |cookie: String, id: Uuid| {
        let state = state.clone();
        async move {
            call(
                &state,
                "DELETE",
                &format!("/dashboard/telegram/accounts/{id}"),
                Some(cookie.as_str()),
                None,
            )
            .await
        }
    };

    // The collaborator cannot touch the owner's account, and sees no difference
    // between that and one that is not there.
    assert_eq!(
        delete(keeper.cookie.clone(), owners).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        delete(keeper.cookie.clone(), Uuid::new_v4()).await.0,
        StatusCode::NOT_FOUND
    );
    // They can take out their own, and the owner any.
    let (status, removed) = delete(keeper.cookie.clone(), theirs).await;
    assert_eq!(
        (status, removed),
        (StatusCode::OK, json!({ "available": 2 }))
    );
    assert_eq!(
        delete(owner.cookie.clone(), owners).await.1,
        json!({ "available": 1 })
    );

    let changes: Vec<(i32, i32)> = sqlx::query_as(
        "SELECT delta, available_after FROM telegram_stock_changes ORDER BY created_at, available_after DESC",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(
        changes.contains(&(-1, 2)) && changes.contains(&(-1, 1)),
        "{changes:?}"
    );
    assert_eq!(stored(&pool).await.len(), 1);
}

#[sqlx::test]
async fn a_sold_account_cannot_be_taken_out(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1"]).await;
    sqlx::query(
        "UPDATE telegram_stock_accounts SET order_reference = 'SOLD00000002', sold_at = NOW()",
    )
    .execute(&pool)
    .await
    .unwrap();
    let id: Uuid = sqlx::query_scalar("SELECT id FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, _) = call(
        &state,
        "DELETE",
        &format!("/dashboard/telegram/accounts/{id}"),
        cookie,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(stored(&pool).await.len(), 1);
}

#[sqlx::test]
async fn only_the_owner_can_look_at_an_account_and_only_with_their_password(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    give_password(&pool, owner.id, "the-owners-password").await;
    let manager = account(&pool, Some(("manager", true))).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(
        &state,
        Some(owner.cookie.as_str()),
        &["someone@example.test|secret-pass"],
    )
    .await;
    let id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap()
        .to_string();

    // Not the owner: refused whatever password they give.
    for who in [&manager, &keeper] {
        assert_eq!(
            reveal(
                &state,
                Some(who.cookie.as_str()),
                &id,
                "the-owners-password"
            )
            .await
            .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        reveal(&state, None, &id, "x").await.0,
        StatusCode::UNAUTHORIZED
    );
    // The owner with the wrong password: refused, and nothing is recorded.
    let (status, wrong) = reveal(&state, Some(owner.cookie.as_str()), &id, "not-it").await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!wrong.to_string().contains("secret-pass"));
    assert_eq!(views(&pool).await, 0);

    // The owner with the right one: the account, and a record that they looked.
    let (status, shown) = reveal(
        &state,
        Some(owner.cookie.as_str()),
        &id,
        "the-owners-password",
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shown,
        json!({ "accounts": [{ "id": id, "account": "someone@example.test|secret-pass" }] })
    );
    let (viewer, account_id): (Uuid, Uuid) =
        sqlx::query_as("SELECT viewed_by, account_id FROM telegram_stock_account_views")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!((viewer, account_id.to_string()), (owner.id, id));
}

#[sqlx::test]
async fn what_the_owner_is_shown_is_not_to_be_cached_and_an_unknown_account_is_not_found(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    give_password(&pool, owner.id, "the-owners-password").await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(&state, Some(owner.cookie.as_str()), &["a@example.test|1"]).await;
    let id: Uuid = sqlx::query_scalar("SELECT id FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, _, headers) = super::send(
        &state,
        "POST",
        "/dashboard/telegram/accounts/reveal",
        Some(owner.cookie.as_str()),
        "application/json",
        Body::from(json!({ "ids": [id], "password": "the-owners-password" }).to_string()),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["cache-control"], "no-store");

    let missing = Uuid::new_v4().to_string();
    assert_eq!(
        reveal(
            &state,
            Some(owner.cookie.as_str()),
            &missing,
            "the-owners-password"
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test]
async fn an_account_sold_to_a_buyer_can_be_looked_at_too(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    give_password(&pool, owner.id, "the-owners-password").await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["delivered@example.test|was-sent"]).await;
    sqlx::query(
        "UPDATE telegram_stock_accounts SET order_reference = 'SOLD00000003', sold_at = NOW()",
    )
    .execute(&pool)
    .await
    .unwrap();
    let id: Uuid = sqlx::query_scalar("SELECT id FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();

    let (status, shown) = reveal(&state, cookie, &id.to_string(), "the-owners-password").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shown["accounts"][0]["account"],
        "delivered@example.test|was-sent"
    );
    // And the list says which order it went to.
    let (_, body) = list(&state, cookie).await;
    assert_eq!(body["accounts"][0]["order_reference"], "SOLD00000003");
}

#[sqlx::test]
async fn guessing_the_owners_password_through_the_reveal_is_slowed_to_five_tries_a_minute(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    give_password(&pool, owner.id, "the-owners-password").await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(&state, Some(owner.cookie.as_str()), &["a@example.test|1"]).await;
    let id: Uuid = sqlx::query_scalar("SELECT id FROM telegram_stock_accounts")
        .fetch_one(&pool)
        .await
        .unwrap();

    // One router for every try: a limiter lives in the router, and the tests'
    // usual one-router-per-request would give each try a fresh budget.
    let router = app(state.clone());
    let try_password = |password: String| {
        let router = router.clone();
        let cookie = owner.cookie.clone();
        async move {
            let request = Request::builder()
                .method("POST")
                .uri("/dashboard/telegram/accounts/reveal")
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .body(Body::from(
                    json!({ "ids": [id], "password": password }).to_string(),
                ))
                .unwrap();

            router.oneshot(request).await.unwrap().status()
        }
    };
    let mut statuses = Vec::new();
    for guess in 0..7 {
        statuses.push(try_password(format!("guess-{guess}")).await);
    }

    assert_eq!(statuses[..5], [StatusCode::UNPROCESSABLE_ENTITY; 5]);
    assert_eq!(statuses[5..], [StatusCode::TOO_MANY_REQUESTS; 2]);
    // Even the right password waits its turn once the tries are spent.
    assert_eq!(
        try_password("the-owners-password".to_owned()).await,
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(views(&pool).await, 0);
}

// ------------------------------------------------ all the accounts, across packages

async fn overview(state: &AppState, cookie: Option<&str>, query: &str) -> (StatusCode, Value) {
    call(
        state,
        "GET",
        &format!("/dashboard/telegram/accounts{query}"),
        cookie,
        None,
    )
    .await
}

async fn load_into(state: &AppState, cookie: Option<&str>, slug: &str, lines: &[&str]) {
    let (status, _) = call(
        state,
        "POST",
        &format!("/dashboard/telegram/products/{slug}/accounts"),
        cookie,
        Some(accounts_block(lines)),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
}

async fn sell(pool: &PgPool, email: &str, reference: &str) {
    let key = [9_u8; 32];
    let rows: Vec<(Uuid, Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT id, nonce, ciphertext FROM telegram_stock_accounts")
            .fetch_all(pool)
            .await
            .unwrap();
    let id = rows
        .iter()
        .find(|(id, nonce, ciphertext)| {
            accounts::open(&key, *id, nonce, ciphertext)
                .unwrap()
                .starts_with(&format!("{email}|"))
        })
        .unwrap()
        .0;

    sqlx::query(
        "UPDATE telegram_stock_accounts SET order_reference = $2, sold_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(reference)
    .execute(pool)
    .await
    .unwrap();
}

/// Two packages that hand out accounts, five accounts between them, one sold.
async fn two_packages(pool: &PgPool) -> (AppState, super::Account) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(delivering_product("Plus")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    load(
        &state,
        cookie,
        &[
            "one@example.test|p1",
            "two@example.test|p2",
            "three@example.test|p3",
        ],
    )
    .await;
    load_into(
        &state,
        cookie,
        "acme-plus",
        &["four@example.test|p4", "five@example.test|p5"],
    )
    .await;
    sell(pool, "two@example.test", "SOLD00000001").await;

    (state, owner)
}

fn titles(body: &Value) -> Vec<String> {
    let mut titles: Vec<String> = body["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["product_title"].as_str().unwrap().to_owned())
        .collect();
    titles.sort();
    titles
}

#[sqlx::test]
async fn the_overview_lists_every_package_and_counts_each_standing(pool: PgPool) {
    let (state, owner) = two_packages(&pool).await;
    let cookie = Some(owner.cookie.as_str());

    let (status, all) = overview(&state, cookie, "").await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(all["counts"], json!({ "all": 5, "sold": 1, "unsold": 4 }));
    assert_eq!(all["total"], 5);
    assert_eq!(
        titles(&all),
        ["Acme Plus", "Acme Plus", "Acme Pro", "Acme Pro", "Acme Pro"]
    );
    assert!(
        all["accounts"]
            .as_array()
            .unwrap()
            .iter()
            .all(|a| a["product_slug"].is_string())
    );

    // A standing narrows the rows and the total, not the counts.
    let (_, sold) = overview(&state, cookie, "?status=sold").await;
    assert_eq!(
        (
            sold["accounts"].as_array().unwrap().len(),
            sold["total"].clone()
        ),
        (1, json!(1))
    );
    assert_eq!(sold["accounts"][0]["order_reference"], "SOLD00000001");
    assert_eq!(sold["counts"], all["counts"]);
    let (_, unsold) = overview(&state, cookie, "?status=unsold").await;
    assert_eq!(unsold["total"], 4);
    // A package narrows both.
    let (_, plus) = overview(&state, cookie, "?product=acme-plus").await;
    assert_eq!(plus["counts"], json!({ "all": 2, "sold": 0, "unsold": 2 }));
    assert_eq!(titles(&plus), ["Acme Plus", "Acme Plus"]);

    assert_eq!(
        overview(&state, cookie, "?status=nonsense").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        overview(&state, cookie, "?page=0").await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    // A package that does not hand out accounts has none to list.
    call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Basic")),
    )
    .await;
    assert_eq!(
        overview(&state, cookie, "?product=acme-basic").await.0,
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test]
async fn an_account_is_found_by_its_full_email_an_order_a_package_or_a_loader(pool: PgPool) {
    let (state, owner) = two_packages(&pool).await;
    let cookie = Some(owner.cookie.as_str());
    let count = |body: &Value| body["accounts"].as_array().unwrap().len();

    // The full email, in any case, finds that account; the hidden version cannot
    // be searched, and a part of an email finds nothing, because it is not read.
    assert_eq!(
        count(&overview(&state, cookie, "?q=Three@Example.TEST").await.1),
        1
    );
    assert_eq!(count(&overview(&state, cookie, "?q=three").await.1), 0);
    // An order, part of a package's name, and part of a loader's username.
    assert_eq!(count(&overview(&state, cookie, "?q=sold0000").await.1), 1);
    assert_eq!(
        count(&overview(&state, cookie, "?q=acme%20plus").await.1),
        2
    );
    let loader = &owner.username[..6];
    assert_eq!(
        count(&overview(&state, cookie, &format!("?q={loader}")).await.1),
        5
    );
    // The counts follow the search.
    let (_, found) = overview(&state, cookie, "?q=acme%20plus").await;
    assert_eq!(found["counts"], json!({ "all": 2, "sold": 0, "unsold": 2 }));
    // A wildcard is text, not a pattern.
    assert_eq!(count(&overview(&state, cookie, "?q=%25").await.1), 0);
    assert_eq!(count(&overview(&state, cookie, "?q=_").await.1), 0);
}

#[sqlx::test]
async fn the_overview_pages_and_never_shows_a_full_email_or_a_password(pool: PgPool) {
    let (state, owner) = two_packages(&pool).await;
    let cookie = Some(owner.cookie.as_str());

    let (_, first) = overview(&state, cookie, "?page=1&page_size=2").await;
    let (_, last) = overview(&state, cookie, "?page=3&page_size=2").await;

    assert_eq!(first["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(last["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(
        (first["total"].clone(), last["total"].clone()),
        (json!(5), json!(5))
    );
    let text = format!("{first}{last}");
    for needle in ["p1", "p5", "one@", "five@", "|"] {
        assert!(!text.contains(needle), "{needle} in {text}");
    }
}

#[sqlx::test]
async fn a_collaborators_overview_holds_only_what_they_loaded_and_counts_only_that(pool: PgPool) {
    let (state, owner) = two_packages(&pool).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    load_into(
        &state,
        Some(keeper.cookie.as_str()),
        "acme-plus",
        &["keeper@example.test|kp"],
    )
    .await;

    let (_, theirs) = overview(&state, Some(keeper.cookie.as_str()), "").await;
    let (_, everything) = overview(&state, Some(owner.cookie.as_str()), "").await;

    assert_eq!(
        theirs["counts"],
        json!({ "all": 1, "sold": 0, "unsold": 1 })
    );
    assert_eq!(theirs["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(everything["counts"]["all"], 6);
    // And what they did not load cannot be found by searching for it.
    let (_, probe) = overview(
        &state,
        Some(keeper.cookie.as_str()),
        "?q=one%40example.test",
    )
    .await;
    assert_eq!(probe["accounts"].as_array().unwrap().len(), 0);
}

#[sqlx::test]
async fn the_overview_needs_stock_access_and_the_key(pool: PgPool) {
    let (mut state, owner) = two_packages(&pool).await;
    let cashier = account(&pool, Some(("cashier", true))).await;

    assert_eq!(overview(&state, None, "").await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        overview(&state, Some(cashier.cookie.as_str()), "").await.0,
        StatusCode::FORBIDDEN
    );
    state.config.stock_encryption_key = None;
    assert_eq!(
        overview(&state, Some(owner.cookie.as_str()), "").await.0,
        StatusCode::NOT_IMPLEMENTED
    );
}

// ------------------------------------------------------- changing an account

async fn update(
    state: &AppState,
    cookie: Option<&str>,
    id: Uuid,
    body: Value,
) -> (StatusCode, Value) {
    call(
        state,
        "PUT",
        &format!("/dashboard/telegram/accounts/{id}"),
        cookie,
        Some(body),
    )
    .await
}

/// The id of the one account with this email, by reading what is stored.
async fn id_of(pool: &PgPool, state: &AppState, email: &str) -> Uuid {
    let key = state.config.stock_encryption_key.unwrap();
    let rows: Vec<(Uuid, Vec<u8>, Vec<u8>)> =
        sqlx::query_as("SELECT id, nonce, ciphertext FROM telegram_stock_accounts")
            .fetch_all(pool)
            .await
            .unwrap();

    rows.iter()
        .find(|(id, nonce, ciphertext)| {
            accounts::open(&key, *id, nonce, ciphertext)
                .unwrap()
                .starts_with(&format!("{email}|"))
        })
        .unwrap()
        .0
}

async fn line_of(pool: &PgPool, state: &AppState, id: Uuid) -> String {
    let key = state.config.stock_encryption_key.unwrap();
    let (nonce, ciphertext): (Vec<u8>, Vec<u8>) =
        sqlx::query_as("SELECT nonce, ciphertext FROM telegram_stock_accounts WHERE id = $1")
            .bind(id)
            .fetch_one(pool)
            .await
            .unwrap();

    accounts::open(&key, id, &nonce, &ciphertext).unwrap()
}

#[sqlx::test]
async fn an_accounts_password_or_email_can_be_changed_and_what_is_left_out_is_kept(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(
        &state,
        cookie,
        &[
            "first@example.test|old-pass",
            "second@example.test|other-pass",
        ],
    )
    .await;
    let id = id_of(&pool, &state, "first@example.test").await;

    // A new password keeps the email.
    let (status, body) = update(&state, cookie, id, json!({ "password": "  new-pass  " })).await;
    assert_eq!(
        (status, body),
        (StatusCode::OK, json!({ "email_hint": "f***@example.test" }))
    );
    assert_eq!(
        line_of(&pool, &state, id).await,
        "first@example.test|new-pass"
    );

    // A new email keeps the password, and the hint follows it.
    let (_, body) = update(
        &state,
        cookie,
        id,
        json!({ "email": "renamed@example.test" }),
    )
    .await;
    assert_eq!(body, json!({ "email_hint": "r***@example.test" }));
    assert_eq!(
        line_of(&pool, &state, id).await,
        "renamed@example.test|new-pass"
    );

    // Both at once; a blank counts as left out.
    update(
        &state,
        cookie,
        id,
        json!({ "email": "both@example.test", "password": "both-pass" }),
    )
    .await;
    assert_eq!(
        line_of(&pool, &state, id).await,
        "both@example.test|both-pass"
    );
    update(
        &state,
        cookie,
        id,
        json!({ "email": "   ", "password": "kept-email-pass" }),
    )
    .await;
    assert_eq!(
        line_of(&pool, &state, id).await,
        "both@example.test|kept-email-pass"
    );

    // The count is not touched, and the old email is free to be loaded again.
    let (_, listing) = list(&state, cookie).await;
    assert_eq!(listing["accounts"].as_array().unwrap().len(), 2);
    let (_, again) = load(&state, cookie, &["first@example.test|brand-new"]).await;
    assert_eq!(again["added"], 1);
}

#[sqlx::test]
async fn a_change_that_is_empty_unchanged_or_malformed_is_refused_and_nothing_is_stored(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["only@example.test|its-pass"]).await;
    let id = id_of(&pool, &state, "only@example.test").await;

    for body in [
        json!({}),
        json!({ "email": " ", "password": "" }),
        json!({ "password": "its-pass" }),
        json!({ "email": "a|b@example.test" }),
        json!({ "password": "two\nlines" }),
        json!({ "email": "tab\tbed@example.test" }),
        json!({ "password": "x".repeat(300) }),
    ] {
        let (status, answer) = update(&state, cookie, id, body.clone()).await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{body}");
        assert!(!answer.to_string().contains("its-pass"), "{answer}");
    }
    assert_eq!(
        line_of(&pool, &state, id).await,
        "only@example.test|its-pass"
    );
}

#[sqlx::test]
async fn a_change_that_would_make_two_accounts_the_same_line_is_refused_but_a_shared_email_is_not(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(
        &state,
        cookie,
        &["one@example.test|p1", "two@example.test|p2"],
    )
    .await;
    let two = id_of(&pool, &state, "two@example.test").await;

    // The same account as another of the package, the email in any case.
    let (status, _) = update(
        &state,
        cookie,
        two,
        json!({ "email": "ONE@example.test", "password": "p1" }),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(line_of(&pool, &state, two).await, "two@example.test|p2");

    // The same email with its own password is another account, which is allowed.
    let (status, _) = update(&state, cookie, two, json!({ "email": "one@example.test" })).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(line_of(&pool, &state, two).await, "one@example.test|p2");
}

#[sqlx::test]
async fn only_the_one_who_may_change_an_account_can_and_never_a_sold_one(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let cashier = account(&pool, Some(("cashier", true))).await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(
        &state,
        Some(owner.cookie.as_str()),
        &["owners@example.test|o1"],
    )
    .await;
    load(
        &state,
        Some(keeper.cookie.as_str()),
        &["theirs@example.test|k1"],
    )
    .await;
    let owners = id_of(&pool, &state, "owners@example.test").await;
    let theirs = id_of(&pool, &state, "theirs@example.test").await;
    let body = json!({ "password": "changed" });

    // A collaborator changes their own, and finds the owner's as if it were not there.
    assert_eq!(
        update(&state, Some(keeper.cookie.as_str()), theirs, body.clone())
            .await
            .0,
        StatusCode::OK
    );
    assert_eq!(
        update(&state, Some(keeper.cookie.as_str()), owners, body.clone())
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    // The owner reaches a collaborator's too.
    assert_eq!(
        update(
            &state,
            Some(owner.cookie.as_str()),
            theirs,
            json!({ "password": "changed-by-owner" })
        )
        .await
        .0,
        StatusCode::OK
    );
    // No stock role, no session, and an account that is not there.
    assert_eq!(
        update(&state, Some(cashier.cookie.as_str()), owners, body.clone())
            .await
            .0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        update(&state, None, owners, body.clone()).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        update(
            &state,
            Some(owner.cookie.as_str()),
            Uuid::new_v4(),
            body.clone()
        )
        .await
        .0,
        StatusCode::NOT_FOUND
    );

    // Once sold, it is the buyer's: nobody changes it.
    sqlx::query("UPDATE telegram_stock_accounts SET order_reference = 'SOLD00000009', sold_at = NOW() WHERE id = $1")
        .bind(owners)
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        update(&state, Some(owner.cookie.as_str()), owners, body)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        line_of(&pool, &state, owners).await,
        "owners@example.test|o1"
    );
}

#[sqlx::test]
async fn changing_an_account_needs_the_key(pool: PgPool) {
    let (mut state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    make_package(&state, cookie).await;
    load(&state, cookie, &["a@example.test|1"]).await;
    let id = id_of(&pool, &state, "a@example.test").await;
    state.config.stock_encryption_key = None;

    assert_eq!(
        update(&state, cookie, id, json!({ "password": "x" }))
            .await
            .0,
        StatusCode::NOT_IMPLEMENTED
    );
}

// ----------------------------------------- opening and editing accounts as a block

const OWNER_PASSWORD: &str = "the-owners-password";

async fn reveal_many(
    state: &AppState,
    cookie: Option<&str>,
    ids: &[Uuid],
    password: &str,
) -> (StatusCode, Value) {
    call(
        state,
        "POST",
        "/dashboard/telegram/accounts/reveal",
        cookie,
        Some(json!({ "ids": ids, "password": password })),
    )
    .await
}

async fn edit(
    state: &AppState,
    cookie: Option<&str>,
    slug: &str,
    ids: &[Uuid],
    block: &[&str],
    dry_run: bool,
) -> (StatusCode, Value) {
    call(
        state,
        "PUT",
        &format!("/dashboard/telegram/products/{slug}/accounts"),
        cookie,
        Some(json!({ "ids": ids, "accounts": block.join("\n"), "dry_run": dry_run })),
    )
    .await
}

/// Every account of a package, sold or not, as the lines they hold.
async fn lines_in(pool: &PgPool, state: &AppState, slug: &str) -> Vec<String> {
    let key = state.config.stock_encryption_key.unwrap();
    let rows: Vec<(Uuid, Vec<u8>, Vec<u8>)> = sqlx::query_as(
        "SELECT account.id, account.nonce, account.ciphertext
         FROM telegram_stock_accounts AS account
         JOIN telegram_products AS product ON product.id = account.product_id
         WHERE product.slug = $1",
    )
    .bind(slug)
    .fetch_all(pool)
    .await
    .unwrap();
    let mut lines: Vec<String> = rows
        .iter()
        .map(|(id, nonce, ciphertext)| accounts::open(&key, *id, nonce, ciphertext).unwrap())
        .collect();
    lines.sort();

    lines
}

async fn available_of(pool: &PgPool, slug: &str) -> i32 {
    sqlx::query_scalar("SELECT available FROM telegram_products WHERE slug = $1")
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn stock_changes(pool: &PgPool) -> Vec<(i32, i32)> {
    sqlx::query_as("SELECT delta, available_after FROM telegram_stock_changes ORDER BY created_at")
        .fetch_all(pool)
        .await
        .unwrap()
}

/// A package with `a`, `b`, `c` and `d` @example.test loaded, p1 to p4 their
/// passwords, and the owner's password set. Returns their ids in that order.
async fn four_accounts(pool: &PgPool) -> (AppState, super::Account, Vec<Uuid>) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    give_password(pool, owner.id, OWNER_PASSWORD).await;
    make_package(&state, Some(owner.cookie.as_str())).await;
    load(
        &state,
        Some(owner.cookie.as_str()),
        &[
            "a@example.test|p1",
            "b@example.test|p2",
            "c@example.test|p3",
            "d@example.test|p4",
        ],
    )
    .await;
    let mut ids = Vec::new();
    for email in ["a", "b", "c", "d"] {
        ids.push(id_of(pool, &state, &format!("{email}@example.test")).await);
    }

    (state, owner, ids)
}

#[sqlx::test]
async fn several_accounts_open_together_in_the_order_asked_and_each_look_is_recorded(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());

    // Asked for out of order, one of them twice: each once, as asked.
    let (status, shown) = reveal_many(
        &state,
        cookie,
        &[ids[2], ids[0], ids[2], ids[3]],
        OWNER_PASSWORD,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        shown,
        json!({ "accounts": [
            { "id": ids[2], "account": "c@example.test|p3" },
            { "id": ids[0], "account": "a@example.test|p1" },
            { "id": ids[3], "account": "d@example.test|p4" },
        ] })
    );
    assert_eq!(views(&pool).await, 3);

    // Nothing named, or one that is not there, opens nothing and records nothing.
    let (status, _) = reveal_many(&state, cookie, &[], OWNER_PASSWORD).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, body) =
        reveal_many(&state, cookie, &[ids[0], Uuid::new_v4()], OWNER_PASSWORD).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert!(!body.to_string().contains("p1"));
    assert_eq!(views(&pool).await, 3);
}

#[sqlx::test]
async fn editing_shows_what_it_would_do_and_writes_nothing_when_asked_only_to_show(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());
    let before = lines_in(&pool, &state, SLUG).await;

    // b gets a new password, c and d are left out.
    let (status, plan) = edit(
        &state,
        cookie,
        SLUG,
        &ids,
        &["a@example.test|p1", "b@example.test|p2-new"],
        true,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        plan,
        json!({ "added": 0, "available": 2, "changed": 1, "duplicates": 0, "removed": 2 })
    );
    assert_eq!(lines_in(&pool, &state, SLUG).await, before);
    assert_eq!(available_of(&pool, SLUG).await, 4);
    assert!(
        stock_changes(&pool)
            .await
            .iter()
            .all(|(delta, _)| *delta > 0)
    );
}

#[sqlx::test]
async fn editing_changes_a_password_in_place_takes_out_the_lines_left_out_and_the_count_follows(
    pool: PgPool,
) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());

    // c gets a new password; a and d are left out. The line that changed is not
    // the first one gone, yet it is the account of that email that is kept.
    let (status, done) = edit(
        &state,
        cookie,
        SLUG,
        &ids,
        &["b@example.test|p2", "c@example.test|p3-new"],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        done,
        json!({ "added": 0, "available": 2, "changed": 1, "duplicates": 0, "removed": 2 })
    );
    assert_eq!(
        lines_in(&pool, &state, SLUG).await,
        ["b@example.test|p2", "c@example.test|p3-new"]
    );
    // c is the same account with another password, not another one.
    assert_eq!(
        line_of(&pool, &state, ids[2]).await,
        "c@example.test|p3-new"
    );
    assert_eq!(available_of(&pool, SLUG).await, 2);
    // And the stock record says what was taken out, and by whom.
    let removed: (i32, i32, Uuid) = sqlx::query_as(
        "SELECT delta, available_after, changed_by FROM telegram_stock_changes
         ORDER BY created_at DESC LIMIT 1",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(removed, (-2, 2, owner.id));
}

#[sqlx::test]
async fn editing_rewrites_lines_that_are_gone_into_the_new_ones_and_adds_the_rest(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());

    // b's password changes; c and d become two other accounts; g is one more.
    let (status, done) = edit(
        &state,
        cookie,
        SLUG,
        &ids,
        &[
            "a@example.test|p1",
            "b@example.test|p2-new",
            "e@example.test|p5",
            "f@example.test|p6",
            "g@example.test|p7",
        ],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        done,
        json!({ "added": 1, "available": 5, "changed": 3, "duplicates": 0, "removed": 0 })
    );
    assert_eq!(
        lines_in(&pool, &state, SLUG).await,
        [
            "a@example.test|p1",
            "b@example.test|p2-new",
            "e@example.test|p5",
            "f@example.test|p6",
            "g@example.test|p7",
        ]
    );
    // The accounts that were rewritten kept their ids.
    assert_eq!(line_of(&pool, &state, ids[2]).await, "e@example.test|p5");
    assert_eq!(line_of(&pool, &state, ids[3]).await, "f@example.test|p6");
    assert_eq!(available_of(&pool, SLUG).await, 5);
    assert_eq!(stock_changes(&pool).await.last(), Some(&(1, 5)));
}

#[sqlx::test]
async fn editing_lets_one_email_hold_several_accounts(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;

    let (status, done) = edit(
        &state,
        Some(owner.cookie.as_str()),
        SLUG,
        &ids[..1],
        &[
            "a@example.test|p1",
            "a@example.test|p1b",
            "A@example.test|p1c",
        ],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["added"], 2);
    assert_eq!(done["available"], 6);
    assert_eq!(
        lines_in(&pool, &state, SLUG)
            .await
            .iter()
            .filter(|line| line.to_lowercase().starts_with("a@example.test|"))
            .count(),
        3
    );
}

#[sqlx::test]
async fn editing_leaves_alone_what_it_did_not_open_and_a_line_the_package_already_holds(
    pool: PgPool,
) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    // Opened: a and b. Loaded since by someone else: z. Never opened: c and d.
    load(
        &state,
        Some(keeper.cookie.as_str()),
        &["z@example.test|late"],
    )
    .await;

    // b is left out, and a line c already has is added again.
    let (status, done) = edit(
        &state,
        cookie,
        SLUG,
        &ids[..2],
        &["a@example.test|p1", "c@example.test|p3"],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    // b would be rewritten to a copy of c, which the package already holds: so it
    // is just taken out.
    assert_eq!(
        done,
        json!({ "added": 0, "available": 4, "changed": 0, "duplicates": 1, "removed": 1 })
    );
    assert_eq!(
        lines_in(&pool, &state, SLUG).await,
        [
            "a@example.test|p1",
            "c@example.test|p3",
            "d@example.test|p4",
            "z@example.test|late"
        ]
    );
    assert_eq!(available_of(&pool, SLUG).await, 4);

    // A line the package holds is never added a second time.
    let (_, again) = edit(
        &state,
        cookie,
        SLUG,
        &ids[..1],
        &["a@example.test|p1", "d@example.test|p4"],
        false,
    )
    .await;
    assert_eq!(
        again,
        json!({ "added": 0, "available": 4, "changed": 0, "duplicates": 1, "removed": 0 })
    );
}

#[sqlx::test]
async fn a_block_whose_accounts_were_sold_or_removed_meanwhile_is_refused_whole(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());
    sell(&pool, "d@example.test", "SOLD00000007").await;
    let before = lines_in(&pool, &state, SLUG).await;

    // d was sold since the block was opened.
    for dry_run in [true, false] {
        let (status, body) = edit(
            &state,
            cookie,
            SLUG,
            &ids,
            &["a@example.test|changed"],
            dry_run,
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
        assert!(!body.to_string().contains("p1"));
    }
    // One that is not there at all.
    let (status, _) = edit(
        &state,
        cookie,
        SLUG,
        &[ids[0], Uuid::new_v4()],
        &["a@example.test|changed"],
        false,
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(lines_in(&pool, &state, SLUG).await, before);
    assert_eq!(available_of(&pool, SLUG).await, 4);
}

#[sqlx::test]
async fn accounts_of_another_package_cannot_be_edited_through_this_one(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;
    let cookie = Some(owner.cookie.as_str());
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(delivering_product("Plus")),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);

    let (status, _) = edit(
        &state,
        cookie,
        "acme-plus",
        &ids,
        &["x@example.test|y"],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(lines_in(&pool, &state, SLUG).await.len(), 4);
}

#[sqlx::test]
async fn a_block_left_empty_takes_every_account_opened_out_of_stock(pool: PgPool) {
    let (state, owner, ids) = four_accounts(&pool).await;

    let (status, done) = edit(
        &state,
        Some(owner.cookie.as_str()),
        SLUG,
        &ids[1..],
        &[],
        false,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(done["removed"], 3);
    assert_eq!(lines_in(&pool, &state, SLUG).await, ["a@example.test|p1"]);
    assert_eq!(available_of(&pool, SLUG).await, 1);
}

#[sqlx::test]
async fn only_the_owner_edits_a_block_and_it_needs_valid_lines_and_the_key(pool: PgPool) {
    let (mut state, owner, ids) = four_accounts(&pool).await;
    let manager = account(&pool, Some(("manager", true))).await;
    let keeper = account(&pool, Some(("stock-keeper", true))).await;
    let block = ["a@example.test|p1"];

    for who in [&manager, &keeper] {
        assert_eq!(
            edit(&state, Some(who.cookie.as_str()), SLUG, &ids, &block, false)
                .await
                .0,
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        edit(&state, None, SLUG, &ids, &block, false).await.0,
        StatusCode::UNAUTHORIZED
    );

    let cookie = Some(owner.cookie.as_str());
    // Nothing named; a line that is not an email and a password, not quoted back.
    assert_eq!(
        edit(&state, cookie, SLUG, &[], &block, false).await.0,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let (status, body) = edit(&state, cookie, SLUG, &ids, &["no-bar-secret"], false).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!body.to_string().contains("no-bar-secret"));
    assert_eq!(
        edit(&state, cookie, "no-such-package", &ids, &block, false)
            .await
            .0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(lines_in(&pool, &state, SLUG).await.len(), 4);

    state.config.stock_encryption_key = None;
    assert_eq!(
        edit(&state, cookie, SLUG, &ids, &block, false).await.0,
        StatusCode::NOT_IMPLEMENTED
    );
}
