//! The shop's Telegram stock, as the dashboard manages it. The products, their
//! prices and their counts are the ones the bot sells from; this is only a second
//! door onto them, for staff, with the rules the bot's own owner buttons lack:
//! renaming, taking stock away, and removing a product.

use axum::{
    Json,
    extract::{Path, Query, State},
    http::{StatusCode, header},
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use uuid::Uuid;

use crate::{
    api::auth::verify_password,
    api::telegram::{
        accounts::{
            AccountPage, AccountSearch, Actor, StockAccount,
            delete_account as delete_stock_account, edit_accounts as edit_stock_accounts,
            load_accounts, parse_accounts, reveal_accounts as reveal_stock_accounts,
            search_accounts as search_stock_accounts, set_delivers_accounts,
            update_account as update_stock_account,
        },
        catalogue::{
            MAXIMUM_RESTOCK, MAXIMUM_STOCK, NewProduct, PRODUCT_COLUMNS, RESERVED_JOIN,
            TelegramProduct, default_warranty_note_en, default_warranty_note_vi, ensure_provider,
            has_open_orders, insert_product, normalize_price, normalize_slug, normalize_text,
            normalize_warranty, refusal_to_count_by_hand, slugify, warranty_notes,
        },
    },
    core::{ApiError, AppState},
};

use super::{
    access::{DashboardUser, Permission, Role, authorize},
    database_error,
    orders::page_bounds,
};

/// A product as the dashboard shows it: the catalogue's fields that a page uses,
/// with the count split three ways.
#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardProduct {
    /// What a buyer may still order: `on_hand` less `reserved`.
    pub available: i32,
    /// Hands the buyer an account when they have paid. Its count is the number
    /// of accounts not yet sold, so it cannot be changed by hand.
    pub delivers_accounts: bool,
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
            delivers_accounts: product.delivers_accounts,
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
    /// The count to start from, 0 to 1,000,000. Always 0 for a package that
    /// hands out accounts.
    pub available: i32,
    /// Hands the buyer an account when they have paid, from accounts loaded
    /// with `POST .../accounts`. It can be changed later with `PUT .../{slug}`.
    #[serde(default)]
    pub delivers_accounts: bool,
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
/// in it: the slug is the product's identity, and the count has its own change
/// (a package that hands out accounts counts its accounts instead).
#[derive(Debug, Deserialize, ToSchema)]
pub struct UpdateProduct {
    /// Makes the package hand out accounts, or stop. Absent leaves it as it is.
    /// Turning it on makes the count the number of accounts not sold (0 for a
    /// package that never held any), so the count typed in by hand is gone; it is
    /// refused while buyers have orders open. Turning it off is refused while the
    /// package still holds accounts not sold.
    pub delivers_accounts: Option<bool>,
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
            delivers_accounts: body.delivers_accounts,
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
        (status = 422, description = "A field is out of range, buyers have orders open while the package is made to hand out accounts, or accounts not sold remain while it is made to stop", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn update_product(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<UpdateProduct>,
) -> Result<Json<DashboardProduct>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;
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
    // In the same transaction, so a refusal undoes the rest of the edit too.
    if let Some(delivers) = body.delivers_accounts {
        set_delivers_accounts(&mut database, &slug, delivers, user.id).await?;
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
         WHERE slug = $1 AND available + $2 >= 0 AND NOT delivers_accounts
         RETURNING available",
    )
    .bind(&slug)
    .bind(body.delta)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    let Some(after) = after else {
        let refusal = refusal_to_count_by_hand(&mut database, &slug).await?;

        return Err(match refusal {
            ApiError::NotFound => ApiError::NotFound,
            // It is there and counts by hand, so the guard was what stopped it.
            _ if !delivers_accounts(&mut database, &slug).await? => {
                ApiError::Validation("That takes out more units than there are in stock.")
            }
            other => other,
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

async fn delivers_accounts(
    database: &mut sqlx::PgConnection,
    slug: &str,
) -> Result<bool, ApiError> {
    sqlx::query_scalar::<_, bool>("SELECT delivers_accounts FROM telegram_products WHERE slug = $1")
        .bind(slug)
        .fetch_one(database)
        .await
        .map_err(database_error)
}

/// A block of accounts to load. It is not `Debug` on purpose: a derived
/// `Debug` would print the accounts wherever the request is logged.
#[derive(Deserialize, ToSchema)]
pub struct LoadAccounts {
    /// One account per line, `email|password`: at most 1,000 lines of at most 300
    /// characters. Blank lines are skipped and the spaces around the bar are dropped.
    pub accounts: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AccountsLoaded {
    /// Accounts put in stock.
    pub added: i32,
    /// The count of the package now: the accounts not yet sold.
    pub available: i32,
    /// Lines left out because the package already holds exactly that account.
    pub duplicates: i32,
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/products/{slug}/accounts",
    params(("slug" = String, Path, description = "The product")),
    request_body = LoadAccounts,
    responses(
        (status = 200, description = "The accounts are in stock, encrypted; this never returns them", body = AccountsLoaded),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such product", body = crate::core::ErrorResponse),
        (status = 422, description = "A line is not an email and a password, there are too many, or the package does not hand out accounts", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn add_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<LoadAccounts>,
) -> Result<Json<AccountsLoaded>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;
    let slug = normalize_slug(&slug)?;
    let lines = parse_accounts(&body.accounts)?;
    let loaded = load_accounts(&state, &slug, &lines, &actor_of(&user)).await?;

    Ok(Json(AccountsLoaded {
        added: loaded.added,
        available: loaded.available,
        duplicates: loaded.duplicates,
    }))
}

/// Owners and managers may change any account in stock; a collaborator who only
/// loads stock, only the ones they loaded.
fn actor_of(user: &DashboardUser) -> Actor {
    Actor {
        id: user.id,
        manages_all: matches!(user.role, Role::Owner | Role::Manager),
    }
}

#[derive(Serialize, ToSchema)]
pub struct AccountList {
    /// Newest first, at most 1,000. A collaborator sees the ones they loaded.
    pub accounts: Vec<StockAccount>,
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/products/{slug}/accounts",
    params(("slug" = String, Path, description = "The product")),
    responses(
        (status = 200, description = "The accounts in stock and sold, each with its email hidden and no password", body = AccountList),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such package, or it does not hand out accounts", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
) -> Result<Json<AccountList>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;
    let slug = normalize_slug(&slug)?;

    let page = search_stock_accounts(
        &state,
        &AccountSearch {
            limit: 1000,
            offset: 0,
            product: Some(&slug),
            query: None,
            sold: None,
        },
        &actor_of(&user),
    )
    .await?;

    Ok(Json(AccountList {
        accounts: page.accounts,
    }))
}

#[derive(Deserialize, IntoParams)]
pub struct AccountsQuery {
    /// Only the accounts of this package, by its slug.
    pub product: Option<String>,
    /// An email in full, an order reference, or part of a package's name or of a
    /// loader's username.
    pub q: Option<String>,
    /// Counted from 1.
    pub page: Option<i64>,
    /// 1 to 100; 20 when left out.
    pub page_size: Option<i64>,
    /// Only `unsold` or only `sold`; both when left out.
    pub status: Option<String>,
}

#[utoipa::path(
    get,
    path = "/dashboard/telegram/accounts",
    params(AccountsQuery),
    responses(
        (status = 200, description = "A page of accounts across packages, each with its email hidden and no password, and how many each standing has", body = AccountPage),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "The package named does not hand out accounts", body = crate::core::ErrorResponse),
        (status = 422, description = "A page, a size or a status that is not valid", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn search_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<AccountsQuery>,
) -> Result<Json<AccountPage>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;

    let sold = match query.status.as_deref() {
        None | Some("") | Some("all") => None,
        Some("unsold") => Some(false),
        Some("sold") => Some(true),
        Some(_) => {
            return Err(ApiError::Validation("An account status is unsold or sold."));
        }
    };
    let (limit, offset) = page_bounds(query.page, query.page_size)?;
    let product = query
        .product
        .as_deref()
        .filter(|slug| !slug.is_empty())
        .map(normalize_slug)
        .transpose()?;
    let text = query
        .q
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());

    Ok(Json(
        search_stock_accounts(
            &state,
            &AccountSearch {
                limit,
                offset,
                product: product.as_deref(),
                query: text,
                sold,
            },
            &actor_of(&user),
        )
        .await?,
    ))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AccountRemoved {
    /// The count of the package now.
    pub available: i32,
}

#[utoipa::path(
    delete,
    path = "/dashboard/telegram/accounts/{id}",
    params(("id" = Uuid, Path, description = "The account")),
    responses(
        (status = 200, description = "The account is out of stock", body = AccountRemoved),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such account, it is sold, or it is not this role's to change", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn delete_account(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
) -> Result<Json<AccountRemoved>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;

    Ok(Json(AccountRemoved {
        available: delete_stock_account(&state, id, &actor_of(&user)).await?,
    }))
}

/// A new email and/or password for an account. Not `Debug`, like an account.
#[derive(Deserialize, ToSchema)]
pub struct UpdateAccount {
    /// A new email. Left out or blank keeps the one it has.
    pub email: Option<String>,
    /// A new password. Left out or blank keeps the one it has.
    pub password: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AccountUpdated {
    /// The account as a page lists it now: the email hidden but for its first
    /// letter and its domain.
    pub email_hint: String,
}

#[utoipa::path(
    put,
    path = "/dashboard/telegram/accounts/{id}",
    params(("id" = Uuid, Path, description = "The account")),
    request_body = UpdateAccount,
    responses(
        (status = 200, description = "The account is changed and sealed again", body = AccountUpdated),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 404, description = "No such account, it is sold, or it is not this role's to change", body = crate::core::ErrorResponse),
        (status = 422, description = "Nothing to change, a value that is not valid, or an account the package already has", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn update_account(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(id): Path<Uuid>,
    Json(body): Json<UpdateAccount>,
) -> Result<Json<AccountUpdated>, ApiError> {
    let user = authorize(&state, &jar, Permission::Stock).await?;

    Ok(Json(AccountUpdated {
        email_hint: update_stock_account(
            &state,
            id,
            &actor_of(&user),
            body.email.as_deref(),
            body.password.as_deref(),
        )
        .await?,
    }))
}

/// The owner's password, to show the owner is who they say, and the accounts to
/// open. Not `Debug`, for the same reason as an account.
#[derive(Deserialize, ToSchema)]
pub struct RevealAccounts {
    /// At least one and at most 1,000; each is opened once, in this order.
    pub ids: Vec<Uuid>,
    pub password: String,
}

/// One account, in the clear.
#[derive(Serialize, ToSchema)]
pub struct RevealedAccount {
    /// `email|password`.
    pub account: String,
    pub id: Uuid,
}

/// The accounts asked for, in the clear. Not `Debug`.
#[derive(Serialize, ToSchema)]
pub struct RevealedAccounts {
    pub accounts: Vec<RevealedAccount>,
}

#[utoipa::path(
    post,
    path = "/dashboard/telegram/accounts/reveal",
    request_body = RevealAccounts,
    responses(
        (status = 200, description = "The accounts, opened. Each look is recorded, and the answer is not to be cached", body = RevealedAccounts),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "Only the owner may look at an account", body = crate::core::ErrorResponse),
        (status = 404, description = "One of the accounts is not there", body = crate::core::ErrorResponse),
        (status = 422, description = "That is not the owner's password, or no account or too many were named", body = crate::core::ErrorResponse),
        (status = 429, description = "Too many tries; each needs the password", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn reveal_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(body): Json<RevealAccounts>,
) -> Result<
    (
        [(header::HeaderName, &'static str); 1],
        Json<RevealedAccounts>,
    ),
    ApiError,
> {
    let user = authorize(&state, &jar, Permission::Secrets).await?;

    let password_hash =
        sqlx::query_scalar::<_, String>("SELECT password_hash FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(&state.pool)
            .await
            .map_err(database_error)?;
    // A wrong password is a 422, not the 401 the login answers with: the page
    // reads a 401 as a lost session and signs the owner out.
    verify_password(&body.password, &password_hash).map_err(|error| match error {
        ApiError::InvalidCredentials => ApiError::Validation("That password is not right."),
        other => other,
    })?;

    let accounts = reveal_stock_accounts(&state, &body.ids, user.id)
        .await?
        .into_iter()
        .map(|(id, account)| RevealedAccount { account, id })
        .collect();

    Ok((
        [(header::CACHE_CONTROL, "no-store")],
        Json(RevealedAccounts { accounts }),
    ))
}

/// Accounts the owner opened, and the block they left them as. Not `Debug`.
#[derive(Deserialize, ToSchema)]
pub struct EditAccounts {
    /// One account per line, `email|password`, as the owner left the block; blank
    /// lines are skipped. Empty takes every account in `ids` out of stock.
    pub accounts: String,
    /// Report what would change and change nothing.
    #[serde(default)]
    pub dry_run: bool,
    /// The accounts the block was made from, all unsold and all of this package.
    pub ids: Vec<Uuid>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AccountsEdited {
    /// Lines that were not among `ids`, put in stock.
    pub added: i32,
    /// The count of the package after the edit.
    pub available: i32,
    /// Accounts whose line is not what it was.
    pub changed: i32,
    /// Lines left out because the package already holds exactly that account.
    pub duplicates: i32,
    /// Accounts taken out of stock because their line is gone from the block.
    pub removed: i32,
}

#[utoipa::path(
    put,
    path = "/dashboard/telegram/products/{slug}/accounts",
    params(("slug" = String, Path, description = "The product")),
    request_body = EditAccounts,
    responses(
        (status = 200, description = "What the edit did, or with dry_run what it would do", body = AccountsEdited),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "Only the owner may edit accounts as a block", body = crate::core::ErrorResponse),
        (status = 404, description = "No such product", body = crate::core::ErrorResponse),
        (status = 422, description = "A line is not an email and a password, too many or no accounts were named, or some were sold or removed meanwhile", body = crate::core::ErrorResponse),
        (status = 501, description = "The service has no STOCK_ENCRYPTION_KEY", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn edit_accounts(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(slug): Path<String>,
    Json(body): Json<EditAccounts>,
) -> Result<Json<AccountsEdited>, ApiError> {
    let user = authorize(&state, &jar, Permission::Secrets).await?;
    let slug = normalize_slug(&slug)?;
    let lines = match body.accounts.trim() {
        "" => Vec::new(),
        _ => parse_accounts(&body.accounts)?,
    };
    let edited = edit_stock_accounts(
        &state,
        &slug,
        &body.ids,
        &lines,
        &actor_of(&user),
        !body.dry_run,
    )
    .await?;

    Ok(Json(AccountsEdited {
        added: edited.added,
        available: edited.available,
        changed: edited.changed,
        duplicates: edited.duplicates,
        removed: edited.removed,
    }))
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

    if has_open_orders(&mut database, &slug).await? {
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
