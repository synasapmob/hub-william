//! What a buyer is told about using a package once they have paid: written once,
//! stored as typed, optional, and changed or cleared only when the form says so.

use axum::http::StatusCode;
use serde_json::{Value, json};
use sqlx::PgPool;

use super::{call, edit_of, new_product, owner_and_state, product_in};

async fn stored_guide(pool: &PgPool, slug: &str) -> String {
    sqlx::query_scalar("SELECT guide FROM telegram_products WHERE slug = $1")
        .bind(slug)
        .fetch_one(pool)
        .await
        .unwrap()
}

fn edit_with_guide(product: &Value, guide: Value) -> Value {
    let mut edit = edit_of(product);
    edit["guide"] = guide;
    edit
}

#[sqlx::test]
async fn a_guide_is_stored_as_written_and_listed(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());

    let mut written = new_product("Pro");
    written["guide"] = json!("  Đăng nhập bằng email được gửi,\r\n\r\n  không đổi mật khẩu.  ");
    let (status, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(written),
    )
    .await;

    // With its line breaks and spacing; only the ends are trimmed.
    let as_stored = "Đăng nhập bằng email được gửi,\n\n  không đổi mật khẩu.";
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(created["guide"], as_stored);
    assert_eq!(stored_guide(&pool, "acme-pro").await, as_stored);

    let (_, plain) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(new_product("Plus")),
    )
    .await;
    assert!(plain["guide"].is_null(), "a package without one has none");

    let (_, listing) = call(&state, "GET", "/dashboard/telegram/products", cookie, None).await;
    assert_eq!(product_in(&listing, "acme-pro")["guide"], as_stored);
    assert!(product_in(&listing, "acme-plus")["guide"].is_null());
}

#[sqlx::test]
async fn editing_changes_clears_or_leaves_the_guide_as_the_form_says(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let mut written = new_product("Pro");
    written["guide"] = json!("Bước một");
    let (_, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(written),
    )
    .await;
    let put = |body: Value| {
        let state = state.clone();
        async move {
            call(
                &state,
                "PUT",
                "/dashboard/telegram/products/acme-pro",
                cookie,
                Some(body),
            )
            .await
        }
    };

    // Absent: the guide stays, whatever else changes.
    let mut renamed = edit_of(&created);
    renamed["price_vnd"] = json!(59000);
    let (status, kept) = put(renamed).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(kept["guide"], "Bước một");
    assert_eq!(stored_guide(&pool, "acme-pro").await, "Bước một");

    // Sent: written.
    let (_, changed) = put(edit_with_guide(&created, json!("Bước hai"))).await;
    assert_eq!(changed["guide"], "Bước hai");

    // Blank: cleared, and the package reads as having none.
    let (_, cleared) = put(edit_with_guide(&created, json!("   "))).await;
    assert!(cleared["guide"].is_null());
    assert_eq!(stored_guide(&pool, "acme-pro").await, "");
}

#[sqlx::test]
async fn a_guide_longer_than_1000_characters_is_refused_and_nothing_changes(pool: PgPool) {
    let (state, owner) = owner_and_state(pool.clone()).await;
    let cookie = Some(owner.cookie.as_str());
    let mut written = new_product("Pro");
    written["guide"] = json!("Bước một");
    let (_, created) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(written),
    )
    .await;
    let too_long = "ă".repeat(1001);

    let (status, _) = call(
        &state,
        "PUT",
        "/dashboard/telegram/products/acme-pro",
        cookie,
        Some(edit_with_guide(&created, json!(too_long))),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(stored_guide(&pool, "acme-pro").await, "Bước một");

    let mut rejected = new_product("Plus");
    rejected["guide"] = json!(too_long);
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(rejected),
    )
    .await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Exactly 1000 is allowed.
    let mut limit = new_product("Max");
    limit["guide"] = json!("ă".repeat(1000));
    let (status, _) = call(
        &state,
        "POST",
        "/dashboard/telegram/products",
        cookie,
        Some(limit),
    )
    .await;
    assert_eq!(status, StatusCode::CREATED);
}
