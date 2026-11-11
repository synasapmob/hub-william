use axum::{
    Json,
    extract::{Path, State},
    http::HeaderMap,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    api::telegram::authorize_telegram_service,
    core::{ApiError, AppState},
};

const MAXIMUM_PRICE_VND: i64 = 1_000_000_000;
pub(crate) const MAXIMUM_RESTOCK: i32 = 100_000;
pub(crate) const MAXIMUM_STOCK: i32 = 1_000_000;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct TelegramProduct {
    /// What a buyer may still order: the count on hand less anything held by
    /// an order that is awaiting payment and has not expired.
    pub available: i32,
    pub category: Option<String>,
    pub detail: Option<String>,
    /// Hands the buyer an account when they have paid. Its count is the number
    /// of accounts not yet sold, so it is never set by hand.
    pub delivers_accounts: bool,
    pub hot: bool,
    pub listed: bool,
    /// The physical count the owner set, before reservations.
    pub on_hand: i32,
    pub plan: String,
    pub price_vnd: i64,
    pub provider_name: String,
    pub provider_slug: String,
    pub slug: String,
    pub reserved: i32,
    pub variant: Option<String>,
    pub warranty: String,
    pub warranty_note_en: String,
    pub warranty_note_vi: String,
}

impl TelegramProduct {
    /// The name every screen and every order record uses, assembled from the
    /// parts a product is actually stored as. It is the plan as the shop wrote it,
    /// with its variant in brackets: the provider groups packages and is not put in
    /// front of the name, so a package is called what the shop called it.
    pub fn title(&self) -> String {
        let mut title = self.plan.clone();
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
    pub category: Option<String>,
    pub detail: Option<String>,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    pub available: i32,
    // Accepted in the request body but never read: reservations are derived
    // from open orders in SQL.
    #[allow(dead_code)]
    pub reserved: i32,
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

pub(crate) const PRODUCT_COLUMNS: &str = "GREATEST(product.available - reserved.quantity, 0)::INT AS available, product.category, product.detail, product.delivers_accounts, product.hot, product.listed, product.available AS on_hand, product.plan, product.price_vnd, provider.name AS provider_name, provider.slug AS provider_slug, reserved.quantity::INT AS reserved, product.slug, product.variant, product.warranty, product.warranty_note_en, product.warranty_note_vi";

/// Joined into every product read so `available` always means "sellable".
pub(crate) const RESERVED_JOIN: &str =
    "JOIN telegram_providers AS provider ON provider.id = product.provider_id
         LEFT JOIN LATERAL (
             SELECT COALESCE(SUM(quantity), 0) AS quantity
             FROM telegram_orders
             WHERE item_id = product.slug
               AND status = 'awaiting_payment'
               AND expires_at > NOW()
         ) AS reserved ON TRUE";

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

    Ok(Json(
        insert_product(
            &state,
            NewProduct {
                available: payload.available,
                category: payload.category,
                delivers_accounts: false,
                detail: payload.detail,
                hot: false,
                image_id: None,
                listed: true,
                plan: payload.plan,
                price_vnd: payload.price_vnd,
                provider: payload.provider,
                variant: payload.variant,
                warranty: payload.warranty,
                warranty_note: None,
            },
        )
        .await?,
    ))
}

/// What a new product is made of. The internal endpoint and the dashboard both
/// build one, so a product is normalised and stored the same way from either.
pub(crate) struct NewProduct {
    pub available: i32,
    pub category: Option<String>,
    pub delivers_accounts: bool,
    pub detail: Option<String>,
    pub hot: bool,
    pub image_id: Option<Uuid>,
    pub listed: bool,
    pub plan: String,
    pub price_vnd: i64,
    pub provider: String,
    pub variant: Option<String>,
    pub warranty: String,
    /// The package note the buyer reads when they open the package, as the shop
    /// wrote it. Blank or absent means none.
    pub warranty_note: Option<String>,
}

/// A slug that is already taken answers `Conflict`.
pub(crate) async fn insert_product(
    state: &AppState,
    product: NewProduct,
) -> Result<TelegramProduct, ApiError> {
    let provider_name = normalize_text(product.provider, 64)
        .ok_or(ApiError::Validation("A product needs a provider."))?;
    let provider_slug = slugify(&provider_name).ok_or(ApiError::Validation(
        "That provider name has no letters or digits.",
    ))?;
    let plan =
        normalize_text(product.plan, 64).ok_or(ApiError::Validation("A product needs a plan."))?;
    let variant = product.variant.and_then(|value| normalize_text(value, 32));
    let detail = product.detail.and_then(|value| normalize_text(value, 32));
    let category = product.category.and_then(|value| normalize_text(value, 64));
    let warranty = normalize_warranty(&product.warranty)?;
    let (note_en, note_vi) = notes(product.warranty_note)?;
    let price_vnd = normalize_price(product.price_vnd)?;
    let available = normalize_stock(product.available)?;
    if product.delivers_accounts && available != 0 {
        return Err(ApiError::Validation(
            "A package that hands out accounts starts with none: its count is the accounts loaded.",
        ));
    }

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
    let provider_id = ensure_provider(&mut database, &provider_name, &provider_slug).await?;

    let created = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO telegram_products
            (id, provider_id, slug, plan, variant, detail, warranty,
             warranty_note_en, warranty_note_vi, price_vnd, available, category, position,
             hot, listed, image_id, delivers_accounts)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 (SELECT COALESCE(MAX(position), 0) + 1 FROM telegram_products WHERE provider_id = $2),
                 $13, $14, $15, $16)
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
    .bind(&note_en)
    .bind(&note_vi)
    .bind(price_vnd)
    .bind(available)
    .bind(&category)
    .bind(product.hot)
    .bind(product.listed)
    .bind(product.image_id)
    .bind(product.delivers_accounts)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;

    if created.is_none() {
        return Err(ApiError::Conflict);
    }

    database.commit().await.map_err(database_error)?;
    load_product(state, &slug).await
}

/// The id of the provider with this slug, made first when there is none.
pub(crate) async fn ensure_provider(
    database: &mut sqlx::PgConnection,
    name: &str,
    slug: &str,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar(
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
    .bind(slug)
    .bind(name)
    .fetch_one(&mut *database)
    .await
    .map_err(database_error)
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
         WHERE slug = $1 AND NOT delivers_accounts
         RETURNING available",
    )
    .bind(&slug)
    .bind(payload.added)
    .fetch_optional(&mut *database)
    .await
    .map_err(database_error)?;
    let Some(available_after) = available_after else {
        return Err(refusal_to_count_by_hand(&mut database, &slug).await?);
    };

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
         {RESERVED_JOIN}
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
         {RESERVED_JOIN}
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
pub(crate) fn slugify(value: &str) -> Option<String> {
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

pub(crate) fn normalize_warranty(value: &str) -> Result<&'static str, ApiError> {
    match value.trim().to_uppercase().as_str() {
        "WF" => Ok("WF"),
        "NW" => Ok("NW"),
        "W7D" => Ok("W7D"),
        _ => Err(ApiError::Validation(
            "A warranty code must be WF, NW, or W7D.",
        )),
    }
}

pub(crate) fn normalize_price(price_vnd: i64) -> Result<i64, ApiError> {
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

pub(crate) fn normalize_text(value: String, maximum_characters: usize) -> Option<String> {
    let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
    (!value.is_empty()).then(|| value.chars().take(maximum_characters).collect())
}

/// The longest package note a shop may write. It is read by the buyer when they
/// open the package in the bot, so it is refused rather than quietly cut short.
pub(crate) const MAXIMUM_NOTE_CHARACTERS: usize = 200;

/// What the shop wrote, as it wrote it; `None` when it wrote nothing. Line breaks,
/// blank lines and the spaces between words are kept, since the buyer is shown
/// the note as typed. Only what cannot be seen is tidied: a Windows or old-Mac
/// line break becomes `\n`, the control characters that would show as boxes are
/// dropped (a tab stays), and the blank space before the first and after the last
/// character is trimmed. Tidied twice, it comes out the same, so a form that sends
/// back the note it was given changes nothing.
pub(crate) fn normalize_note(value: String) -> Result<Option<String>, ApiError> {
    let note = value
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .chars()
        .filter(|character| !character.is_control() || matches!(character, '\n' | '\t'))
        .collect::<String>();
    let note = note.trim();

    if note.chars().count() > MAXIMUM_NOTE_CHARACTERS {
        return Err(ApiError::Validation(
            "A package note is at most 200 characters.",
        ));
    }

    Ok((!note.is_empty()).then(|| note.to_owned()))
}

/// The note to store in English and in Vietnamese: what the shop wrote, the same
/// for a reader of either language, or nothing at all, which the bot shows as
/// nothing. A package has no note of its own making: the warranty is said by its
/// code, and the note is for whatever else the buyer should know.
pub(crate) fn notes(written: Option<String>) -> Result<(String, String), ApiError> {
    let note = written
        .map(normalize_note)
        .transpose()?
        .flatten()
        .unwrap_or_default();

    Ok((note.clone(), note))
}

/// Whether buyers have orders open for a package: awaiting payment and not yet
/// run out. They hold stock, and what they will be handed is decided when they
/// pay, so a package is not removed or changed to hand out accounts meanwhile.
pub(crate) async fn has_open_orders(
    database: &mut sqlx::PgConnection,
    slug: &str,
) -> Result<bool, ApiError> {
    sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS (
             SELECT 1 FROM telegram_orders
             WHERE item_id = $1 AND status = 'awaiting_payment' AND expires_at > NOW()
         )",
    )
    .bind(slug)
    .fetch_one(database)
    .await
    .map_err(database_error)
}

/// Why a hand-set count was not applied: the package is not there, or it counts
/// its own accounts and the count follows them.
pub(crate) async fn refusal_to_count_by_hand(
    database: &mut sqlx::PgConnection,
    slug: &str,
) -> Result<ApiError, ApiError> {
    let delivers = sqlx::query_scalar::<_, bool>(
        "SELECT delivers_accounts FROM telegram_products WHERE slug = $1",
    )
    .bind(slug)
    .fetch_optional(database)
    .await
    .map_err(database_error)?;

    Ok(match delivers {
        None => ApiError::NotFound,
        Some(_) => ApiError::Validation(
            "That package hands out accounts, so its count follows the accounts loaded.",
        ),
    })
}

fn database_error(error: sqlx::Error) -> ApiError {
    crate::utils::database_error("telegram catalogue", error)
}

#[cfg(test)]
mod tests {
    use super::{
        TelegramProduct, group_by_provider, normalize_note, normalize_price, normalize_slug,
        normalize_stock, normalize_warranty, slugify,
    };

    fn note(value: &str) -> Option<String> {
        normalize_note(value.to_owned()).unwrap()
    }

    #[test]
    fn a_package_note_keeps_its_line_breaks_blank_lines_and_spacing() {
        let written = "Bảo hành 30 ngày\n\n  - Đổi tài khoản khác\n- Không hoàn tiền   sau 7 ngày\n\n\nLiên hệ shop";

        assert_eq!(note(written).as_deref(), Some(written));
    }

    #[test]
    fn a_package_note_is_only_trimmed_where_it_begins_and_ends() {
        assert_eq!(
            note("\n  Bảo hành đầy đủ\n\nĐổi trong 7 ngày \n\n").as_deref(),
            Some("Bảo hành đầy đủ\n\nĐổi trong 7 ngày")
        );
        assert_eq!(note(" \n \t \n"), None);
        assert_eq!(note(""), None);
    }

    #[test]
    fn a_package_note_takes_every_kind_of_line_break_as_one() {
        assert_eq!(
            note("một\r\nhai\rba\n\r\nbốn").as_deref(),
            Some("một\nhai\nba\n\nbốn")
        );
    }

    #[test]
    fn a_package_note_loses_only_what_cannot_be_seen() {
        // A bell, a null and an escape would show as boxes; a tab is kept.
        assert_eq!(note("a\u{7}b\u{0}c\u{1b}d\te").as_deref(), Some("abcd\te"));
    }

    #[test]
    fn a_package_note_tidied_twice_comes_out_the_same() {
        let once = note("  một\r\n\r\n  hai   ba \u{7}\n").unwrap();

        assert_eq!(note(&once).as_deref(), Some(once.as_str()));
    }

    #[test]
    fn a_package_note_is_counted_in_characters_with_its_line_breaks() {
        let line = format!("{}\n", "ă".repeat(99));

        // 99 + 1 + 99 + 1 + 1 = 201 once the last letter is added.
        assert!(normalize_note(format!("{line}{line}x")).is_err());
        assert!(normalize_note(format!("{line}{line}")).is_ok());
    }

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
            category: None,
            delivers_accounts: false,
            detail: None,
            hot: false,
            listed: true,
            on_hand: 1,
            plan: "Pro".to_owned(),
            price_vnd: 49_000,
            provider_name: provider_slug.to_owned(),
            provider_slug: provider_slug.to_owned(),
            reserved: 0,
            slug: slug.to_owned(),
            variant: None,
            warranty: "NW".to_owned(),
            warranty_note_en: "note".to_owned(),
            warranty_note_vi: "ghi chú".to_owned(),
        }
    }
}
