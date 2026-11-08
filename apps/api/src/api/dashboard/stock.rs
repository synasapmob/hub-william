//! The shop's Telegram stock, as the dashboard manages it. The products, their
//! prices and their counts are the ones the bot sells from; this is only a second
//! door onto them, for staff, with the rules the bot's own owner buttons lack:
//! renaming, taking stock away, and removing a product.

use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    api::telegram::catalogue::{
        MAXIMUM_RESTOCK, MAXIMUM_STOCK, NewProduct, PRODUCT_COLUMNS, RESERVED_JOIN,
        TelegramProduct, default_warranty_note_en, default_warranty_note_vi, ensure_provider,
        insert_product, normalize_price, normalize_slug, normalize_text, normalize_warranty,
        slugify, warranty_notes,
    },
    core::{ApiError, AppState},
};

use super::{
    access::{Permission, authorize},
    database_error,
};

/// A product as the dashboard shows it: the catalogue's fields that a page uses,
/// with the count split three ways.
#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardProduct {
    /// What a buyer may still order: `on_hand` less `reserved`.
    pub available: i32,
    pub hot: bool,
    /// The picture, served by `GET /dashboard/images/{id}`.
    pub image_id: Option<Uuid>,
    pub listed: bool,
    /// The count the shop set, before reservations.
    pub on_hand: i32,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    /// Held by orders that await payment and have not expired.
    pub reserved: i32,
    /// The identity of the product; it never changes, whatever the name does.
    pub slug: String,
    pub variant: Option<String>,
    /// `WF` full, `W7D` seven days, `NW` none beyond a one-hour login check.
    pub warranty: String,
    /// The shop's own warranty note, in Vietnamese. Absent when the product
    /// carries the standard note for its warranty code.
    pub warranty_note: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardProducts {
    pub products: Vec<DashboardProduct>,
}

#[derive(sqlx::FromRow)]
struct ProductRow {
    #[sqlx(flatten)]
    product: TelegramProduct,
    image_id: Option<Uuid>,
}

impl From<ProductRow> for DashboardProduct {
    fn from(row: ProductRow) -> Self {
        let ProductRow { product, image_id } = row;
        let written = product.warranty_note_vi != default_warranty_note_vi(&product.warranty)
            || product.warranty_note_en != default_warranty_note_en(&product.warranty);

        Self {
            available: product.available,
            hot: product.hot,
            image_id,
            listed: product.listed,
            on_hand: product.on_hand,
            plan: product.plan,
            price_vnd: product.price_vnd,
            provider: product.provider_name,
            reserved: product.reserved,
            slug: product.slug,
            variant: product.variant,
            warranty: product.warranty,
            warranty_note: written.then_some(product.warranty_note_vi),
        }
    }
}

/// What a person types into the form; the slug is made from it, once.
#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateProduct {
    /// The count to start from, 0 to 1,000,000.
    pub available: i32,
    pub hot: bool,
    pub image_id: Option<Uuid>,
    pub listed: bool,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    pub variant: Option<String>,
    /// `WF`, `W7D` or `NW`.
    pub warranty: String,
    /// The warranty note a buyer reads, up to 200 characters. Blank or absent
    /// uses the standard note for the warranty code.
    pub warranty_note: Option<String>,
}

/// Everything about a product that can be edited. The slug and the count are not
/// in it: the slug is the product's identity, and the count has its own change.
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProduct {
    pub hot: bool,
    pub image_id: Option<Uuid>,
    pub listed: bool,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    pub variant: Option<String>,
    /// `WF`, `W7D` or `NW`.
    pub warranty: String,
    /// The warranty note a buyer reads, up to 200 characters. Blank uses the
    /// standard note for the warranty code. Absent leaves the note as it is,
    /// unless the warranty code changes, which resets it to the standard one.
    pub warranty_note: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct StockChange {
    /// Units to put in (up to 100,000) or take out (up to 1,000,000), never 0.
    pub delta: i32,
}

async fn load(state: &AppState, slug: &str) -> Result<DashboardProduct, ApiError> {
    sqlx::query_as::<_, ProductRow>(&format!(
        "SELECT {PRODUCT_COLUMNS}, product.image_id
         FROM telegram_products AS product
         {RESERVED_JOIN}
         WHERE product.slug = $1"
    ))
    .bind(slug)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .map(DashboardProduct::from)
    .ok_or(ApiError::NotFound)
}

/// A picture that is named must exist, so a bad id is a clear refusal rather
/// than a database error.
async fn ensure_image(state: &AppState, image_id: Option<Uuid>) -> Result<(), ApiError> {
    let Some(image_id) = image_id else {
        return Ok(());
    };

    sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM dashboard_images WHERE id = $1)")
        .bind(image_id)
        .fetch_one(&state.pool)
        .await
        .map_err(database_error)?
        .then_some(())
        .ok_or(ApiError::Validation("That picture does not exist."))
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/products",
    responses(
        (status = 200, description = "Every product, hidden ones included", body = DashboardProducts),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_products(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardProducts>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;

    let products = sqlx::query_as::<_, ProductRow>(&format!(
        "SELECT {PRODUCT_COLUMNS}, product.image_id
         FROM telegram_products AS product
         {RESERVED_JOIN}
         ORDER BY provider.position, provider.slug, product.position, product.created_at"
    ))
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(DashboardProducts {
        products: products.into_iter().map(DashboardProduct::from).collect(),
    }))
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/products",
    request_body = CreateProduct,
    responses(
        (status = 201, description = "The product that was made", body = DashboardProduct),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 409, description = "A product with that provider, plan and variant exists", body = crate::core::ErrorResponse),
        (status = 422, description = "A field is out of range", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn create_product(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<CreateProduct>,
) -> Result<(StatusCode, Json<DashboardProduct>), ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    ensure_image(&state, body.image_id).await?;

    let created = insert_product(
        &state,
        NewProduct {
            available: body.available,
            category: None,
            detail: None,
            hot: body.hot,
            image_id: body.image_id,
            listed: body.listed,
            plan: body.plan,
            price_vnd: body.price_vnd,
            provider: body.provider,
            variant: body.variant,
            warranty: body.warranty,
            warranty_note: body.warranty_note,
        },
    )
    .await
    .map_err(|error| match error {
        ApiError::Conflict => ApiError::Exists("That product already exists."),
        other => other,
    })?;

    Ok((
        StatusCode::CREATED,
        Json(load(&state, &created.slug).await?),
    ))
}

#[utoipa::path(
    put,
    path = "/dashboard/telegram/products/{slug}",
    params(("slug" = String, Path, description = "The product")),
    request_body = UpdateProduct,
    responses(
        (status = 200, description = "The product as it is now", body = DashboardProduct),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such product", body = crate::core::ErrorResponse),
        (status = 422, description = "A field is out of range", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn update_product(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<UpdateProduct>,
) -> Result<Json<DashboardProduct>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let slug = normalize_slug(&slug)?;

    let provider_name = normalize_text(body.provider, 64)
        .ok_or(ApiError::Validation("A product needs a provider."))?;
    let provider_slug = slugify(&provider_name).ok_or(ApiError::Validation(
        "That provider name has no letters or digits.",
    ))?;
    let plan =
        normalize_text(body.plan, 64).ok_or(ApiError::Validation("A product needs a plan."))?;
    let variant = body.variant.and_then(|value| normalize_text(value, 32));
    let warranty = normalize_warranty(&body.warranty)?;
    // A note that is absent leaves the stored one alone (unless the warranty
    // changes). One that is sent is written, and a blank one asks for the
    // standard note back.
    let leave_note = body.warranty_note.is_none();
    let (note_en, note_vi) = warranty_notes(warranty, body.warranty_note)?;
    let price_vnd = normalize_price(body.price_vnd)?;
    ensure_image(&state, body.image_id).await?;

    let mut database = state.pool.begin().await.map_err(database_error)?;
    let provider_id = ensure_provider(&mut database, &provider_name, &provider_slug).await?;

    // The stored notes stay when the warranty is unchanged and the note is
    // absent or is the Vietnamese note already stored. The second case is a form
    // that sends back what it was given, which must not overwrite an English
    // note the form never showed.
    let updated = sqlx::query_scalar::<_, Uuid>(
        "UPDATE telegram_products
         SET provider_id = $2,
             plan = $3,
             variant = $4,
             warranty_note_en = CASE WHEN warranty = $5 AND ($12 OR $7 = warranty_note_vi)
                                     THEN warranty_note_en ELSE $6 END,
             warranty_note_vi = CASE WHEN warranty = $5 AND ($12 OR $7 = warranty_note_vi)
                                     THEN warranty_note_vi ELSE $7 END,
             warranty = $5,
             price_vnd = $8,
             hot = $9,
             listed = $10,
             image_id = $11,
             updated_at = NOW()
         WHERE slug = $1
         RETURNING id",
    )
    .bind(&slug)
    .bind(provider_id)
    .bind(&plan)
    .bind(&variant)
    .bind(warranty)
    .bind(&note_en)
    .bind(&note_vi)
    .bind(price_vnd)
    .bind(body.hot)
    .bind(body.listed)
    .bind(body.image_id)
    .bind(leave_note)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    if updated.is_none() {
        return Err(ApiError::NotFound);
    }
    database.commit().await.map_err(database_error)?;

    Ok(Json(load(&state, &slug).await?))
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/products/{slug}/stock",
    params(("slug" = String, Path, description = "The product")),
    request_body = StockChange,
    responses(
        (status = 200, description = "The product with its new count", body = DashboardProduct),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such product", body = crate::core::ErrorResponse),
        (status = 422, description = "The change is 0, too large, or takes more than is there", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn change_stock(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<StockChange>,
) -> Result<Json<DashboardProduct>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;
    let slug = normalize_slug(&slug)?;
    if body.delta == 0 || !(-MAXIMUM_STOCK..=MAXIMUM_RESTOCK).contains(&body.delta) {
        return Err(ApiError::Validation(
            "A stock change is not 0, and puts in at most 100000 units or takes out at most 1000000.",
        ));
    }

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // The guard lives in the statement, so two changes made together cannot take
    // the count below zero between them.
    let after = sqlx::query_scalar::<_, i32>(
        "UPDATE telegram_products
         SET available = available + $2, updated_at = NOW()
         WHERE slug = $1 AND available + $2 >= 0
         RETURNING available",
    )
    .bind(&slug)
    .bind(body.delta)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    let Some(after) = after else {
        let exists = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS (SELECT 1 FROM telegram_products WHERE slug = $1)",
        )
        .bind(&slug)
        .fetch_one(&mut *database)
        .await
        .map_err(database_error)?;

        return Err(if exists {
            ApiError::Validation("That takes out more units than there are in stock.")
        } else {
            ApiError::NotFound
        });
    };

    sqlx::query(
        "INSERT INTO telegram_stock_changes (id, product_id, delta, available_after, changed_by)
         SELECT $1, id, $3, $4, $5 FROM telegram_products WHERE slug = $2",
    )
    .bind(Uuid::new_v4())
    .bind(&slug)
    .bind(body.delta)
    .bind(after)
    .bind(user.id)
    .execute(&mut *database)
    .await
    .map_err(database_error)?;

    database.commit().await.map_err(database_error)?;
    Ok(Json(load(&state, &slug).await?))
}

#[utoipa::path(
    delete,
    path = "/dashboard/telegram/products/{slug}",
    params(("slug" = String, Path, description = "The product")),
    responses(
        (status = 204, description = "The product is gone; orders already made keep their title and price"),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such product", body = crate::core::ErrorResponse),
        (status = 422, description = "Buyers have orders open for it", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn delete_product(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
) -> Result<StatusCode, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let slug = normalize_slug(&slug)?;

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // Locked, so an order cannot slip in between the check and the delete.
    let id = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM telegram_products WHERE slug = $1 FOR UPDATE",
    )
    .bind(&slug)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    let open_orders = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
             SELECT 1 FROM telegram_orders
             WHERE item_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()
         )",
    )
    .bind(&slug)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;

    if open_orders {
        return Err(ApiError::Validation(
            "Buyers have orders open for this product. Hide it instead, then remove it once they are settled.",
        ));
    }

    sqlx::query("DELETE FROM telegram_products WHERE id = $1")
        .bind(id)
        .execute(&mut *database)
        .await
        .map_err(database_error)?;

    database.commit().await.map_err(database_error)?;
    Ok(StatusCode::NO_CONTENT)
}
