use std::sync::Arc;

use axum::{Extension, Router, middleware::from_fn_with_state, routing::get};
use utoipa::OpenApi;

use crate::{
    api::limits::{PartnerLimit, limit_partner},
    core::AppState,
};

use super::{ProductCache, list_partner_products};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    // The limiter is added last so it runs first: a request without a key is
    // refused before it can reach the cache or the database.
    Router::new()
        .route("/partner/products", get(list_partner_products))
        .layer(Extension(Arc::new(ProductCache::default())))
        .layer(from_fn_with_state(PartnerLimit::new(state), limit_partner))
}

#[derive(OpenApi)]
#[openapi(
    paths(super::list_partner_products),
    components(schemas(
        super::PartnerCatalogue,
        super::PartnerProduct,
        super::PartnerProvider
    )),
    tags((name = "partner", description = "Read-only product list for shops that sell on our behalf, called with a key issued to the shop"))
)]
pub(crate) struct PartnerApi;
