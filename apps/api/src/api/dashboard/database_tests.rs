//! The dashboard against a real database, through the real router: who is let in,
//! what each role may do, and that stock changes exactly as asked.

use axum::{
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use tower::ServiceExt;
use uuid::Uuid;

use crate::{
    api::app,
    core::{AppConfig, AppState},
};

mod announcements;
mod orders;
mod revenue;
mod sales;
mod service;
mod staff;
mod support;

const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];

fn state(pool: PgPool) -> AppState {
    state_with_bot(pool, None)
}

/// A state whose dashboard can reach a bot at `adapter`, when there is one.
fn state_with_bot(pool: PgPool, adapter: Option<&reqwest::Url>) -> AppState {
    AppState {
        config: AppConfig {
            telegram_adapter_url: adapter.cloned(),
            telegram_service_token: Some(b"test-service-token".to_vec()),
            ..AppConfig::default()
        },
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

struct Account {
    id: Uuid,
    username: String,
    cookie: String,
}

/// An account with a live session, and a staff row when `staff` names a role.
async fn account(pool: &PgPool, staff: Option<(&str, bool)>) -> Account {
    let id = Uuid::new_v4();
    let username = id.simple().to_string()[..20].to_owned();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(&username)
        .execute(pool)
        .await
        .unwrap();

    let token = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(format!("{:x}", Sha256::digest(token.as_bytes())))
    .execute(pool)
    .await
    .unwrap();

    if let Some((role, active)) = staff {
        sqlx::query("INSERT INTO dashboard_staff (user_id, role, active) VALUES ($1, $2, $3)")
            .bind(id)
            .bind(role)
            .bind(active)
            .execute(pool)
            .await
            .unwrap();
    }

    Account {
        id,
        username,
        cookie: format!("hub_session={token}"),
    }
}

async fn send(
    state: &AppState,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    content_type: &str,
    body: Body,
) -> (StatusCode, Vec<u8>, axum::http::HeaderMap) {
    let mut request = Request::builder()
        .method(method)
        .uri(uri)
        .header("content-type", content_type);
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    let response = app(state.clone())
        .oneshot(request.body(body).unwrap())
        .await
        .unwrap();
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = to_bytes(response.into_body(), usize::MAX).await.unwrap();

    (status, bytes.to_vec(), headers)
}

async fn call(
    state: &AppState,
    method: &str,
    uri: &str,
    cookie: Option<&str>,
    json: Option<Value>,
) -> (StatusCode, Value) {
    let body = json.map_or_else(Body::empty, |value| Body::from(value.to_string()));
    let (status, bytes, _) = send(state, method, uri, cookie, "application/json", body).await;

    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

fn new_product(plan: &str) -> Value {
    json!({
        "available": 10,
        "hot": false,
        "image_id": null,
        "listed": true,
        "plan": plan,
        "price_vnd": 49000,
        "provider": "Acme",
        "variant": null,
        "warranty": "NW"
    })
}

fn edit_of(product: &Value) -> Value {
    json!({
        "hot": product["hot"],
        "image_id": product["image_id"],
        "listed": product["listed"],
        "plan": product["plan"],
        "price_vnd": product["price_vnd"],
        "provider": product["provider"],
        "variant": product["variant"],
        "warranty": product["warranty"]
    })
}

/// The seeded catalogue is in every listing, so a product is found by its slug.
fn product_in<'a>(listing: &'a Value, slug: &str) -> &'a Value {
    listing["products"]
        .as_array()
        .unwrap()
        .iter()
        .find(|product| product["slug"] == slug)
        .unwrap_or_else(|| panic!("{slug} is not listed"))
}

async fn owner_and_state(pool: PgPool) -> (AppState, Account) {
    let owner = account(&pool, Some(("owner", true))).await;
    let state = state(pool);

    (state, owner)
}

// ---------------------------------------------------------------- who gets in

#[sqlx::test]
async fn an_owner_is_a_row_in_the_database_with_the_role_owner(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;

    let (status, session) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(session["role"], "owner");
    assert_eq!(session["user"]["username"], owner.username);
    assert_eq!(
        session["permissions"],
        json!(["orders", "history", "stock", "revenue", "staff"])
    );
}

#[sqlx::test]
async fn an_account_that_is_not_in_the_table_is_nobody_whatever_its_name(pool: PgPool) {
    let state = state(pool.clone());
    // Nothing in the configuration makes an account an owner: only a row does.
    let named_like_an_owner = account(&pool, None).await;

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&named_like_an_owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn an_owner_whose_row_is_switched_off_has_no_access_at_all(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    // A second owner, so the shop is not left without one.
    account(&pool, Some(("owner", true))).await;
    sqlx::query("UPDATE dashboard_staff SET active = FALSE WHERE user_id = $1")
        .bind(owner.id)
        .execute(&pool)
        .await
        .unwrap();

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn each_stored_role_reports_its_own_permissions(pool: PgPool) {
    let state = state(pool.clone());

    for (role, permissions) in [
        ("manager", json!(["orders", "history", "stock", "revenue"])),
        ("cashier", json!(["orders", "history"])),
        ("stock-keeper", json!(["stock"])),
    ] {
        let member = account(&pool, Some((role, true))).await;
        let (status, session) = call(
            &state,
            "GET",
            "/dashboard/session",
            Some(&member.cookie),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{role}");
        assert_eq!(session["role"], role);
        assert_eq!(session["permissions"], permissions, "{role}");
    }
}

#[sqlx::test]
async fn an_account_that_is_not_staff_is_forbidden_not_unauthorized(pool: PgPool) {
    let state = state(pool.clone());
    let stranger = account(&pool, None).await;

    let (status, body) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&stranger.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["code"], "forbidden");
}

#[sqlx::test]
async fn a_member_whose_access_is_switched_off_is_forbidden(pool: PgPool) {
    let state = state(pool.clone());
    let former = account(&pool, Some(("manager", false))).await;

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&former.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/telegram/products",
        Some(&former.cookie),
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[sqlx::test]
async fn a_stale_session_is_unauthorized(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    sqlx::query("UPDATE sessions SET expires_at = NOW() - INTERVAL '1 minute'")
        .execute(&pool)
        .await
        .unwrap();

    let (status, _) = call(
        &state,
        "GET",
        "/dashboard/session",
        Some(&owner.cookie),
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ------------------------------------------------------------ who may do what

#[sqlx::test]
async fn only_a_role_with_the_stock_permission_manages_stock(pool: PgPool) {
    let state = state(pool.clone());
    let cashier = account(&pool, Some(("cashier", true))).await;

    for (method, uri, body) in [
        ("GET", "/dashboard/telegram/products", None),
        (
            "POST",
            "/dashboard/telegram/products",
            Some(new_product("Pro")),
        ),
        (
            "POST",
            "/dashboard/telegram/products/acme-pro/stock",
            Some(json!({ "delta": 1 })),
        ),
        ("DELETE", "/dashboard/telegram/products/acme-pro", None),
    ] {
        let (status, _) = call(&state, method, uri, Some(&cashier.cookie), body).await;

        assert_eq!(status, StatusCode::FORBIDDEN, "{method} {uri}");
    }

    let (status, _, _) = send(
        &state,
        "POST",
        "/dashboard/images",
        Some(&cashier.cookie),
        "image/png",
        Body::from(PNG.to_vec()),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    for role in ["manager", "stock-keeper"] {
        let member = account(&pool, Some((role, true))).await;
        let (status, _) = call(
            &state,
            "GET",
            "/dashboard/telegram/products",
            Some(&member.cookie),
            None,
        )
        .await;

        assert_eq!(status, StatusCode::OK, "{role}");
    }
}

// ----------------------------------------------------------------- the stock

#[sqlx::test]
async fn a_product_is_made_listed_edited_and_removed(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());

    let (status, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Pro 1 tháng")),
    )
    .await;

    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["slug"], "acme-pro-1-thang");
    assert_eq!(created["provider"], "Acme");
    assert_eq!(created["on_hand"], 10);
    assert_eq!(created["reserved"], 0);
    assert_eq!(created["available"], 10);

    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    assert!(
        listing["products"]
            .as_array()
            .unwrap()
            .iter()
            .any(|product| product["slug"] == "acme-pro-1-thang")
    );

    // Everything but the slug and the count can change, and the slug stays.
    let mut edit = edit_of(&created);
    edit["plan"] = json!("Pro 12 tháng");
    edit["price_vnd"] = json!(399000);
    edit["hot"] = json!(true);
    edit["listed"] = json!(false);
    edit["warranty"] = json!("WF");
    edit["provider"] = json!("Anthropic");
    let (status, edited) = call(
        &state,
        "PUT",
        "/dashboard/telegram/products/acme-pro-1-thang",
        cookie,
        Some(edit),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(edited["slug"], "acme-pro-1-thang");
    assert_eq!(edited["plan"], "Pro 12 tháng");
    assert_eq!(edited["provider"], "Anthropic");
    assert_eq!(edited["price_vnd"], 399000);
    assert_eq!(edited["hot"], true);
    assert_eq!(edited["listed"], false);
    assert_eq!(edited["warranty"], "WF");
    assert_eq!(edited["on_hand"], 10);

    // A changed warranty brings the default note for it; the bot reads both.
    let note: String = sqlx::query_scalar(
        "SELECT warranty_note_en FROM telegram_products WHERE slug = 'acme-pro-1-thang'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(note.contains("full warranty"), "{note}");

    let (status, _) = call(
        &state,
        "DELETE",
        "/dashboard/telegram/products/acme-pro-1-thang",
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/telegram/products/acme-pro-1-thang",
        cookie,
        Some(edit_of(&created)),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn editing_leaves_a_warranty_note_alone_when_the_warranty_is_unchanged(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let (_, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Pro")),
    )
    .await;
    sqlx::query(
        "UPDATE telegram_products SET warranty_note_en = 'Written by hand' WHERE slug = 'acme-pro'",
    )
    .execute(&pool)
    .await
    .unwrap();

    let mut edit = edit_of(&created);
    edit["price_vnd"] = json!(55000);
    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        Some(edit),
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    let note: String = sqlx::query_scalar(
        "SELECT warranty_note_en FROM telegram_products WHERE slug = 'acme-pro'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(note, "Written by hand");
}

#[sqlx::test]
async fn a_product_that_exists_cannot_be_made_again(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;
    let cookie = Some(owner.cookie.as_str());

    call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Pro")),
    )
    .await;
    let (status, body) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("pro")),
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["code"], "already_exists");
    assert_eq!(body["message"], "That product already exists.");
}

#[sqlx::test]
async fn a_product_is_refused_when_a_field_is_out_of_range(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;
    let cookie = Some(owner.cookie.as_str());

    for (field, value) in [
        ("price_vnd", json!(1_000_000_001_i64)),
        ("price_vnd", json!(-1)),
        ("available", json!(1_000_001)),
        ("available", json!(-1)),
        ("warranty", json!("30D")),
        ("plan", json!("   ")),
        ("provider", json!("")),
    ] {
        let mut body = new_product("Pro");
        body[field] = value.clone();
        let (status, _) = call(
            &state,
            "POST",
            "/dashboard/telegram/products",
            cookie,
            Some(body),
        )
        .await;

        assert_eq!(
            status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{field} = {value}"
        );
    }
}

#[sqlx::test]
async fn stock_goes_in_and_out_and_every_change_is_kept_with_who_made_it(pool: PgPool) {
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
    let stock = "/dashboard/telegram/products/acme-pro/stock";

    let (status, product) = call(&state, "POST", stock, cookie, Some(json!({ "delta": 15 }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(product["on_hand"], 25);

    let (status, product) = call(&state, "POST", stock, cookie, Some(json!({ "delta": -5 }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(product["on_hand"], 20);
    assert_eq!(product["available"], 20);

    let changes: Vec<(i32, i32, Option<Uuid>)> = sqlx::query_as(
        "SELECT delta, available_after, changed_by FROM telegram_stock_changes ORDER BY created_at",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        changes,
        vec![(15, 25, Some(owner.id)), (-5, 20, Some(owner.id))]
    );
}

#[sqlx::test]
async fn stock_cannot_go_below_zero_and_a_refused_change_leaves_no_trace(pool: PgPool) {
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
    let stock = "/dashboard/telegram/products/acme-pro/stock";

    // All of it can go, and no more.
    let (status, product) =
        call(&state, "POST", stock, cookie, Some(json!({ "delta": -10 }))).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(product["on_hand"], 0);

    let (status, _) = call(&state, "POST", stock, cookie, Some(json!({ "delta": -1 }))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM telegram_stock_changes")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 1);
}

#[sqlx::test]
async fn a_stock_change_must_be_a_real_amount_for_a_real_product(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;
    let cookie = Some(owner.cookie.as_str());
    call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Pro")),
    )
    .await;
    let stock = "/dashboard/telegram/products/acme-pro/stock";

    for delta in [0, 100_001, -1_000_001] {
        let (status, _) = call(
            &state,
            "POST",
            stock,
            cookie,
            Some(json!({ "delta": delta })),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "delta {delta}");
    }

    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products/no-such-product/stock",
        cookie,
        Some(json!({ "delta": 1 })),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[sqlx::test]
async fn two_changes_made_at_once_cannot_take_more_than_there_is(pool: PgPool) {
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
    let stock = "/dashboard/telegram/products/acme-pro/stock";

    // Ten in stock, two callers each taking eight: only one can have them.
    let (first, second) = tokio::join!(
        call(&state, "POST", stock, cookie, Some(json!({ "delta": -8 }))),
        call(&state, "POST", stock, cookie, Some(json!({ "delta": -8 }))),
    );
    let mut answers = [first.0, second.0];
    answers.sort();

    assert_eq!(answers, [StatusCode::OK, StatusCode::UNPROCESSABLE_ENTITY]);
    let on_hand: i32 =
        sqlx::query_scalar("SELECT available FROM telegram_products WHERE slug = 'acme-pro'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(on_hand, 2);
}

#[sqlx::test]
async fn what_orders_hold_is_reported_apart_from_what_is_on_hand(pool: PgPool) {
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
    open_order(&pool, "acme-pro", 3, "AAAAAAAAAAAA", "1 hour").await;

    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    let product = product_in(&listing, "acme-pro");

    assert_eq!(product["on_hand"], 10);
    assert_eq!(product["reserved"], 3);
    assert_eq!(product["available"], 7);
}

async fn open_order(pool: &PgPool, slug: &str, quantity: i32, reference: &str, lifetime: &str) {
    let buyer = i64::from(quantity) + 100;
    sqlx::query(
        "INSERT INTO telegram_contacts (telegram_user_id, chat_id, first_name)
         VALUES ($1, $1, 'Buyer') ON CONFLICT DO NOTHING",
    )
    .bind(buyer)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(&format!(
        "INSERT INTO telegram_orders
            (id, reference, telegram_user_id, chat_id, item_id, item_title,
             quantity, unit_price_vnd, total_vnd, expires_at)
         VALUES ($1, $2, $3, $3, $4, 'Claude Pro', $5, 49000, 49000 * $5,
                 NOW() + INTERVAL '{lifetime}')"
    ))
    .bind(Uuid::new_v4())
    .bind(reference)
    .bind(buyer)
    .bind(slug)
    .bind(quantity)
    .execute(pool)
    .await
    .unwrap();
}

#[sqlx::test]
async fn a_product_with_a_buyer_waiting_to_pay_is_not_deleted(pool: PgPool) {
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
    open_order(&pool, "acme-pro", 1, "BBBBBBBBBBBB", "1 hour").await;

    let (status, body) = call(
        &state,
        "DELETE",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(
        body["message"]
            .as_str()
            .unwrap()
            .contains("Hide it instead")
    );
    let kept: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM telegram_products WHERE slug = 'acme-pro')",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(kept);

    // Once the order is settled the product can go.
    sqlx::query("UPDATE telegram_orders SET status = 'cancelled'")
        .execute(&pool)
        .await
        .unwrap();
    let (status, _) = call(
        &state,
        "DELETE",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
}

#[sqlx::test]
async fn an_order_that_ran_out_of_time_does_not_hold_a_product_back(pool: PgPool) {
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
    // Past its time it still awaits payment, but it no longer holds any stock.
    open_order(&pool, "acme-pro", 1, "CCCCCCCCCCCC", "-1 hour").await;

    let (status, _) = call(
        &state,
        "DELETE",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        None,
    )
    .await;

    assert_eq!(status, StatusCode::NO_CONTENT);
    // The order keeps its own title and price, so the history survives.
    let title: String = sqlx::query_scalar(
        "SELECT item_title FROM telegram_orders WHERE reference = 'CCCCCCCCCCCC'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(title, "Claude Pro");
}

// --------------------------------------------------------------- the pictures

#[sqlx::test]
async fn a_picture_is_stored_served_back_and_attached_to_a_product(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;
    let cookie = Some(owner.cookie.as_str());

    // The type the uploader claims does not matter; the bytes decide.
    let (status, bytes, _) = send(
        &state,
        "POST",
        "/dashboard/images",
        cookie,
        "application/octet-stream",
        Body::from(PNG.to_vec()),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    let image_id = serde_json::from_slice::<Value>(&bytes).unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();

    let (status, served, headers) = send(
        &state,
        "GET",
        &format!("/dashboard/images/{image_id}"),
        cookie,
        "application/json",
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(served, PNG);
    assert_eq!(headers["content-type"], "image/png");
    assert_eq!(headers["x-content-type-options"], "nosniff");

    let mut body = new_product("Pro");
    body["image_id"] = json!(image_id);
    let (status, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(body),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["image_id"], image_id);

    // An edit can drop the picture again.
    let mut edit = edit_of(&created);
    edit["image_id"] = Value::Null;
    let (_, edited) = call(
        &state,
        "PUT",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        Some(edit),
    )
    .await;
    assert_eq!(edited["image_id"], Value::Null);
}

#[sqlx::test]
async fn only_a_picture_is_accepted_as_one(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());

    for body in [
        b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>".to_vec(),
        b"not a picture".to_vec(),
        Vec::new(),
    ] {
        // Said to be a PNG, but it is not.
        let (status, _, _) = send(
            &state,
            "POST",
            "/dashboard/images",
            cookie,
            "image/png",
            Body::from(body),
        )
        .await;

        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    }

    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM dashboard_images")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(stored, 0);
}

#[sqlx::test]
async fn a_product_cannot_point_at_a_picture_that_does_not_exist(pool: PgPool) {
    let (state, owner) = owner_and_state(pool).await;
    let mut body = new_product("Pro");
    body["image_id"] = json!(Uuid::new_v4());

    let (status, answer) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        Some(&owner.cookie),
        Some(body),
    )
    .await;

    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(answer["message"], "That picture does not exist.");
}

#[sqlx::test]
async fn any_member_of_staff_may_see_a_picture_but_a_stranger_may_not(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let (_, bytes, _) = send(
        &state,
        "POST",
        "/dashboard/images",
        Some(&owner.cookie),
        "image/png",
        Body::from(PNG.to_vec()),
    )
    .await;
    let uri = format!(
        "/dashboard/images/{}",
        serde_json::from_slice::<Value>(&bytes).unwrap()["id"]
            .as_str()
            .unwrap()
    );
    let cashier = account(&pool, Some(("cashier", true))).await;
    let stranger = account(&pool, None).await;

    let (status, _, _) = send(
        &state,
        "GET",
        &uri,
        Some(&cashier.cookie),
        "application/json",
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = send(
        &state,
        "GET",
        &uri,
        Some(&stranger.cookie),
        "application/json",
        Body::empty(),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, _, _) = send(&state, "GET", &uri, None, "application/json", Body::empty()).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

// ------------------------------------------------- the bot keeps working as it did

#[sqlx::test]
async fn a_product_made_through_the_bots_route_is_the_same_product_the_dashboard_lists(
    pool: PgPool,
) {
    let (state, owner) = owner_and_state(pool).await;

    let mut request = Request::builder()
        .method("POST")
        .uri("/internal/telegram/products")
        .header("content-type", "application/json")
        .header("x-hub-william-telegram-token", "test-service-token");
    request = request.header("accept", "application/json");
    let response = app(state.clone())
        .oneshot(
            request
                .body(Body::from(
                    json!({
                        "category": null,
                        "detail": null,
                        "plan": "Pro",
                        "price_vnd": 49000,
                        "provider": "Acme",
                        "available": 4,
                        "reserved": 0,
                        "variant": null,
                        "warranty": "NW"
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);

    let (_, listing) = call(
        &state,
        "GET",
        "/dashboard/telegram/products",
        Some(&owner.cookie),
        None,
    )
    .await;
    let product = product_in(&listing, "acme-pro");

    // The bot's route makes a product that is on sale and not hot, as before.
    assert_eq!(product["listed"], true);
    assert_eq!(product["hot"], false);
    assert_eq!(product["image_id"], Value::Null);
    assert_eq!(product["on_hand"], 4);
}
