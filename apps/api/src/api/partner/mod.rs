//! A read-only product list for the shops that sell on our behalf. A shop is a
//! caller with a key in `SHOP_KEYS`; see [`access`](super::access) for what a key may do.
//! The list is the shop's catalogue without what a reseller has no use for: the count
//! on hand, what is held for unpaid orders, and the notes written for buyers.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{Extension, Json, extract::State, http::header::CACHE_CONTROL, response::IntoResponse};
use serde::Serialize;
use tokio::sync::Mutex;
use utoipa::ToSchema;

use crate::{
    api::{
        access::{Caller, Permission},
        telegram::catalogue::{TelegramCatalogueProvider, fetch_products, group_by_provider},
    },
    core::{ApiError, AppState},
};

mod routes;
pub(crate) use routes::{PartnerApi, routes};

#[cfg(test)]
mod tests;

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;

/// A product list is read from the database at most this often, however many shops
/// ask. It is also how long a shop is told it may keep what it got.
const CACHE_LIFETIME: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PartnerCatalogue {
    /// Only providers with something on sale.
    pub providers: Vec<PartnerProvider>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PartnerProvider {
    pub name: String,
    pub slug: String,
    pub products: Vec<PartnerProduct>,
}

#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PartnerProduct {
    /// Stays the same while the product exists, so a shop can match it across reads.
    pub id: String,
    pub plan: String,
    pub variant: Option<String>,
    pub detail: Option<String>,
    pub category: Option<String>,
    /// `WF` full warranty, `W7D` seven days, `NW` none beyond a one-hour login check.
    pub warranty: String,
    /// The price of one, in Vietnamese dong.
    pub price_vnd: i64,
    /// Whether at least one can be ordered now. The count is not shared.
    pub in_stock: bool,
}

fn present(providers: Vec<TelegramCatalogueProvider>) -> PartnerCatalogue {
    PartnerCatalogue {
        providers: providers
            .into_iter()
            .map(|provider| PartnerProvider {
                name: provider.name,
                slug: provider.slug,
                products: provider
                    .products
                    .into_iter()
                    .map(|product| PartnerProduct {
                        in_stock: product.available > 0,
                        id: product.slug,
                        plan: product.plan,
                        variant: product.variant,
                        detail: product.detail,
                        category: product.category,
                        warranty: product.warranty,
                        price_vnd: product.price_vnd,
                    })
                    .collect(),
            })
            .collect(),
    }
}

/// The product list, kept for [`CACHE_LIFETIME`]. The lock is held while it is
/// read, so shops arriving together after it expires cause one query, not one each.
#[derive(Default)]
pub(crate) struct ProductCache {
    entry: Mutex<Option<(Instant, PartnerCatalogue)>>,
}

impl ProductCache {
    async fn catalogue(&self, state: &AppState) -> Result<PartnerCatalogue, ApiError> {
        let mut entry = self.entry.lock().await;
        if let Some((loaded, catalogue)) = entry.as_ref()
            && loaded.elapsed() < CACHE_LIFETIME
        {
            return Ok(catalogue.clone());
        }

        let fresh = present(group_by_provider(fetch_products(state, true).await?));
        *entry = Some((Instant::now(), fresh.clone()));

        Ok(fresh)
    }
}

#[utoipa::path(
    get,
    path = "/partner/products",
    responses(
        (status = 200, description = "The products on sale, grouped by provider. Keep the answer for the time `Cache-Control` gives; asking more often gets the same list", body = PartnerCatalogue),
        (status = 401, description = "No key, or a key that was not issued", body = crate::core::ErrorResponse),
        (status = 403, description = "The key may not read products", body = crate::core::ErrorResponse),
        (status = 429, description = "Too many requests; `Retry-After` says when to try again", body = crate::core::ErrorResponse)
    ),
    tag = "partner"
)]
/// List the products on sale
///
/// Send the key issued to you as `Authorization: Bearer <key>`.
pub(crate) async fn list_partner_products(
    State(state): State<AppState>,
    Extension(caller): Extension<Caller>,
    Extension(cache): Extension<Arc<ProductCache>>,
) -> Result<impl IntoResponse, ApiError> {
    caller.require(Permission::ProductsRead)?;
    let catalogue = cache.catalogue(&state).await?;

    Ok((
        [(
            CACHE_CONTROL,
            format!("private, max-age={}", CACHE_LIFETIME.as_secs()),
        )],
        Json(catalogue),
    ))
}
