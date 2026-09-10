use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{AppState, error::ApiError, telegram::authorize_telegram_service};

const MAXIMUM_PRICE_VND: i64 = 1_000_000_000;
const MAXIMUM_RESTOCK: i32 = 100_000;
const MAXIMUM_STOCK: i32 = 1_000_000;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TelegramProduct {
    pub available: i32,
    pub detail: Option<String>,
    pub hot: bool,
    pub listed: bool,
    pub plan: String,
    pub price_vnd: i64,
    pub provider_name: String,
    pub provider_slug: String,
    pub slug: String,
    pub variant: Option<String>,
    pub warranty: String,
    pub warranty_note_en: String,
    pub warranty_note_vi: String,
}

impl TelegramProduct {
    /// The name every screen and every order record uses, assembled from the
    /// parts a product is actually stored as.
    pub fn title(&self) -> String {
        let mut title = format!("{} {}", self.provider_name, self.plan);
        if let Some(variant) = self.variant.as_deref() {
            title.push_str(" (");
            title.push_str(variant);
            title.push(')');
        }
        if let Some(detail) = self.detail.as_deref() {
            title.push_str(" · ");
            title.push_str(detail);
        }
        title
    }
}

#[derive(Debug, Serialize)]
pub struct TelegramCatalogue {
    pub providers: Vec<TelegramCatalogueProvider>,
}

#[derive(Debug, Serialize)]
pub struct TelegramCatalogueProvider {
    pub name: String,
    pub products: Vec<TelegramProduct>,
    pub slug: String,
}

#[derive(Debug, Deserialize)]
pub struct CreateTelegramProduct {
    pub detail: Option<String>,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    pub available: i32,
    pub variant: Option<String>,
    pub warranty: String,
}

#[derive(Debug, Deserialize)]
pub struct RestockTelegramProduct {
    pub added: i32,
}

/// Every field is optional so one call can change a price, a flag, or both.
#[derive(Debug, Deserialize)]
pub struct AdjustTelegramProduct {
    pub hot: Option<bool>,
    pub listed: Option<bool>,
    pub price_vnd: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct TelegramRestock {
    pub added: i32,
    pub product: TelegramProduct,
}

const PRODUCT_COLUMNS: &str = "product.available, product.detail, product.hot, product.listed, product.plan, product.price_vnd, provider.name AS provider_name, provider.slug AS provider_slug, product.slug, product.variant, product.warranty, product.warranty_note_en, product.warranty_note_vi";

/// What a buyer sees: listed providers, each with its listed products. A
/// provider with nothing listed is left out rather than opening on an empty
/// screen.
pub async fn catalogue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TelegramCatalogue>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    Ok(Json(TelegramCatalogue {
        providers: group_by_provider(fetch_products(&state, true).await?),
    }))
}

/// What the owner sees: everything, including hidden products and providers.
pub async fn full_catalogue(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TelegramCatalogue>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    Ok(Json(TelegramCatalogue {
        providers: group_by_provider(fetch_products(&state, false).await?),
    }))
}

pub async fn get_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
) -> Result<Json<TelegramProduct>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    Ok(Json(load_product(&state, &normalize_slug(&slug)?).await?))
}

pub async fn create_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<CreateTelegramProduct>,
) -> Result<Json<TelegramProduct>, ApiError> {
    authorize_telegram_service(&state, &headers)?;

    let provider_name = normalize_text(payload.provider, 64)
        .ok_or(ApiError::Validation("A product needs a provider."))?;
    let provider_slug = slugify(&provider_name).ok_or(ApiError::Validation(
        "That provider name has no letters or digits.",
    ))?;
    let plan =
        normalize_text(payload.plan, 64).ok_or(ApiError::Validation("A product needs a plan."))?;
    let variant = payload.variant.and_then(|value| normalize_text(value, 32));
    let detail = payload.detail.and_then(|value| normalize_text(value, 32));
    let warranty = normalize_warranty(&payload.warranty)?;
    let price_vnd = normalize_price(payload.price_vnd)?;
    let available = normalize_stock(payload.available)?;

    let slug = slugify(&format!(
        "{provider_slug} {plan} {}",
        variant.as_deref().unwrap_or_default()
    ))
    .ok_or(ApiError::Validation(
        "That plan name has no letters or digits.",
    ))?;

    let mut database = state.pool.begin().await.map_err(database_error)?;

    // An unknown provider is created rather than refused, so a brand new line
    // of products needs one command instead of two.
    let provider_id: Uuid = sqlx::query_scalar(
        "WITH created AS (
             INSERT INTO telegram_providers (id, slug, name, position)
             VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), 0) + 1 FROM telegram_providers))
             ON CONFLICT (slug) DO NOTHING
             RETURNING id
         )
         SELECT id FROM created
         UNION ALL
         SELECT id FROM telegram_providers WHERE slug = $2
         LIMIT 1",
    )
    .bind(Uuid::new_v4())
    .bind(&provider_slug)
    .bind(&provider_name)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)?;

    let created = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO telegram_products
            (id, provider_id, slug, plan, variant, detail, warranty,
             warranty_note_en, warranty_note_vi, price_vnd, available, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM telegram_products WHERE provider_id = $2))
         ON CONFLICT (slug) DO NOTHING
         RETURNING id",
    )
    .bind(Uuid::new_v4())
    .bind(provider_id)
    .bind(&slug)
    .bind(&plan)
    .bind(&variant)
    .bind(&detail)
    .bind(warranty)
    .bind(default_warranty_note_en(warranty))
    .bind(default_warranty_note_vi(warranty))
    .bind(price_vnd)
    .bind(available)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    if created.is_none() {
        return Err(ApiError::Conflict);
    }

    database.commit().await.map_err(database_error)?;
    Ok(Json(load_product(&state, &slug).await?))
}

/// Adding stock is recorded as its own row, so the announcement can quote both
/// what arrived and what the shelf holds now.
pub async fn restock_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(payload): Json<RestockTelegramProduct>,
) -> Result<Json<TelegramRestock>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    let slug = normalize_slug(&slug)?;
    if !(1..=MAXIMUM_RESTOCK).contains(&payload.added) {
        return Err(ApiError::Validation(
            "A restock must add between 1 and 100000 units.",
        ));
    }

    let mut database = state.pool.begin().await.map_err(database_error)?;
    let available_after = sqlx::query_scalar::<_, i32>(
        "UPDATE telegram_products
         SET available = available + $2, updated_at = NOW()
         WHERE slug = $1
         RETURNING available",
    )
    .bind(&slug)
    .bind(payload.added)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;

    sqlx::query(
        "INSERT INTO telegram_restocks (id, product_id, added, available_after)
         SELECT $1, id, $3, $4 FROM telegram_products WHERE slug = $2",
    )
    .bind(Uuid::new_v4())
    .bind(&slug)
    .bind(payload.added)
    .bind(available_after)
    .execute(&mut *database)
    .await
    .map_err(database_error)?;

    database.commit().await.map_err(database_error)?;
    Ok(Json(TelegramRestock {
        added: payload.added,
        product: load_product(&state, &slug).await?,
    }))
}

pub async fn adjust_product(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(slug): Path<String>,
    Json(payload): Json<AdjustTelegramProduct>,
) -> Result<Json<TelegramProduct>, ApiError> {
    authorize_telegram_service(&state, &headers)?;
    let slug = normalize_slug(&slug)?;
    let price_vnd = payload.price_vnd.map(normalize_price).transpose()?;

    let updated = sqlx::query_scalar::<_, Uuid>(
        "UPDATE telegram_products
         SET hot = COALESCE($2, hot),
             listed = COALESCE($3, listed),
             price_vnd = COALESCE($4, price_vnd),
             updated_at = NOW()
         WHERE slug = $1
         RETURNING id",
    )
    .bind(&slug)
    .bind(payload.hot)
    .bind(payload.listed)
    .bind(price_vnd)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?;

    if updated.is_none() {
        return Err(ApiError::NotFound);
    }
    Ok(Json(load_product(&state, &slug).await?))
}

async fn fetch_products(
    state: &AppState,
    listed_only: bool,
) -> Result<Vec<TelegramProduct>, ApiError> {
    sqlx::query_as::<_, TelegramProduct>(&format!(
        "SELECT {PRODUCT_COLUMNS}
         FROM telegram_products AS product
         JOIN telegram_providers AS provider ON provider.id = product.provider_id
         WHERE ($1 = FALSE OR (product.listed AND provider.listed))
         ORDER BY provider.position, provider.slug, product.position, product.created_at"
    ))
    .bind(listed_only)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)
}

pub(crate) async fn load_product(
    state: &AppState,
    slug: &str,
) -> Result<TelegramProduct, ApiError> {
    sqlx::query_as::<_, TelegramProduct>(&format!(
        "SELECT {PRODUCT_COLUMNS}
         FROM telegram_products AS product
         JOIN telegram_providers AS provider ON provider.id = product.provider_id
         WHERE product.slug = $1"
    ))
    .bind(slug)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)
}

/// The query already orders by provider then product, so grouping only has to
/// watch for the slug changing.
fn group_by_provider(products: Vec<TelegramProduct>) -> Vec<TelegramCatalogueProvider> {
    let mut providers: Vec<TelegramCatalogueProvider> = Vec::new();

    for product in products {
        match providers.last_mut() {
            Some(provider) if provider.slug == product.provider_slug => {
                provider.products.push(product);
            }
            _ => providers.push(TelegramCatalogueProvider {
                name: product.provider_name.clone(),
                slug: product.provider_slug.clone(),
                products: vec![product],
            }),
        }
    }

    providers
}

pub fn normalize_slug(value: &str) -> Result<String, ApiError> {
    let slug = value.trim().to_lowercase();
    if slug.is_empty()
        || slug.chars().count() > 64
        || !slug.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
    {
        return Err(ApiError::Validation(
            "A product slug is 1-64 lowercase letters, digits, or hyphens.",
        ));
    }
    Ok(slug)
}

/// Turns a human name into a slug, dropping accents so "Capcut Pro 30D" and
/// "CapCut  Pro 30d" reach the same identifier.
fn slugify(value: &str) -> Option<String> {
    let mut slug = String::new();
    for character in value.to_lowercase().chars() {
        if character.is_ascii_lowercase() || character.is_ascii_digit() {
            slug.push(character);
        } else if let Some(folded) = fold_vietnamese(character) {
            slug.push(folded);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }

    let slug = slug.trim_matches('-');
    (!slug.is_empty()).then(|| slug.chars().take(64).collect())
}

fn fold_vietnamese(character: char) -> Option<char> {
    const FOLDED: [(&str, char); 12] = [
        ("àáâãăạảấầẩẫậắằẳẵặ", 'a'),
        ("èéêẹẻẽếềểễệ", 'e'),
        ("ìíĩỉị", 'i'),
        ("òóôõơọỏốồổỗộớờởỡợ", 'o'),
        ("ùúũưụủứừửữự", 'u'),
        ("ỳýỹỷỵ", 'y'),
        ("đ", 'd'),
        ("ç", 'c'),
        ("ñ", 'n'),
        ("ß", 's'),
        ("æ", 'a'),
        ("ø", 'o'),
    ];

    FOLDED
        .into_iter()
        .find(|(source, _)| source.contains(character))
        .map(|(_, folded)| folded)
}

fn normalize_warranty(value: &str) -> Result<&'static str, ApiError> {
    match value.trim().to_uppercase().as_str() {
        "WF" => Ok("WF"),
        "NW" => Ok("NW"),
        "W7D" => Ok("W7D"),
        _ => Err(ApiError::Validation(
            "A warranty code must be WF, NW, or W7D.",
        )),
    }
}

fn normalize_price(price_vnd: i64) -> Result<i64, ApiError> {
    (0..=MAXIMUM_PRICE_VND)
        .contains(&price_vnd)
        .then_some(price_vnd)
        .ok_or(ApiError::Validation(
            "A price must be between 0 and 1000000000 đồng.",
        ))
}

fn normalize_stock(available: i32) -> Result<i32, ApiError> {
    (0..=MAXIMUM_STOCK)
        .contains(&available)
        .then_some(available)
        .ok_or(ApiError::Validation(
            "Stock must be between 0 and 1000000 units.",
        ))
}

fn normalize_text(value: String, maximum_characters: usize) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then(|| value.chars().take(maximum_characters).collect())
}

fn default_warranty_note_en(warranty: &str) -> &'static str {
    match warranty {
        "WF" => "Activated straight on your own account, with a full warranty for the whole term.",
        "W7D" => "Warranty covers the first 7 days after purchase.",
        _ => {
            "Warranty is a login check within 1 hour (after that hour there is no warranty under any circumstance)."
        }
    }
}

fn default_warranty_note_vi(warranty: &str) -> &'static str {
    match warranty {
        "WF" => "Active trực tiếp trên tài khoản chính chủ của bạn, bảo hành đầy đủ trọn thời hạn.",
        "W7D" => "Bảo hành trong 7 ngày kể từ khi mua.",
        _ => {
            "Bảo hành login check 1 tiếng (sau 1 tiếng kể từ khi mua không bảo hành mọi trường hợp)"
        }
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("telegram catalogue database operation failed: {error}");
    ApiError::Internal
}

#[cfg(test)]
mod tests {
    use super::{
        TelegramProduct, group_by_provider, normalize_price, normalize_slug, normalize_stock,
        normalize_warranty, slugify,
    };

    #[test]
    fn a_slug_folds_accents_and_collapses_separators() {
        assert_eq!(slugify("Capcut Pro 30D"), Some("capcut-pro-30d".to_owned()));
        assert_eq!(slugify("  Cốc  Cốc   Pro "), Some("coc-coc-pro".to_owned()));
        assert_eq!(slugify("Đăng Ký"), Some("dang-ky".to_owned()));
        assert_eq!(slugify("!!!"), None);
    }

    #[test]
    fn a_slug_is_validated_against_the_column_constraint() {
        assert_eq!(normalize_slug(" Claude-Pro ").unwrap(), "claude-pro");
        assert!(normalize_slug("").is_err());
        assert!(normalize_slug("claude pro").is_err());
        assert!(normalize_slug(&"a".repeat(65)).is_err());
    }

    #[test]
    fn a_warranty_code_is_one_of_three() {
        assert_eq!(normalize_warranty(" wf ").unwrap(), "WF");
        assert_eq!(normalize_warranty("w7d").unwrap(), "W7D");
        assert_eq!(normalize_warranty("NW").unwrap(), "NW");
        assert!(normalize_warranty("30D").is_err());
    }

    #[test]
    fn a_price_and_a_stock_count_are_bounded() {
        assert!(normalize_price(0).is_ok());
        assert!(normalize_price(-1).is_err());
        assert!(normalize_price(1_000_000_001).is_err());
        assert!(normalize_stock(0).is_ok());
        assert!(normalize_stock(-1).is_err());
    }

    #[test]
    fn products_group_into_the_providers_the_query_ordered_them_by() {
        let grouped = group_by_provider(vec![
            product("claude", "claude-max-x20"),
            product("claude", "claude-pro"),
            product("grok", "grok-supergrok"),
        ]);

        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped[0].slug, "claude");
        assert_eq!(grouped[0].products.len(), 2);
        assert_eq!(grouped[1].slug, "grok");
        assert_eq!(grouped[1].products.len(), 1);
    }

    fn product(provider_slug: &str, slug: &str) -> TelegramProduct {
        TelegramProduct {
            available: 1,
            detail: None,
            hot: false,
            listed: true,
            plan: "Pro".to_owned(),
            price_vnd: 49_000,
            provider_name: provider_slug.to_owned(),
            provider_slug: provider_slug.to_owned(),
            slug: slug.to_owned(),
            variant: None,
            warranty: "NW".to_owned(),
            warranty_note_en: "note".to_owned(),
            warranty_note_vi: "ghi chú".to_owned(),
        }
    }
}
