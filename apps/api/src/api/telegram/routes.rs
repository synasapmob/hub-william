use axum::{
    Router,
    routing::{get, post, put},
};

use crate::core::AppState;

use super::{
    block_contact, cancel_order,
    catalogue::{
        adjust_product, catalogue, create_product, full_catalogue, get_product, restock_product,
    },
    create_order, get_contact, get_order, list_audience, list_orders, observe_contact,
    record_sepay_payment, set_contact_language,
};

/// Internal endpoints for the Telegram adapter. They are not part of the
/// published OpenAPI document.
pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/internal/telegram/contacts", post(observe_contact))
        .route(
            "/internal/telegram/contacts/{telegram_user_id}",
            get(get_contact),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/language",
            put(set_contact_language),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders",
            get(list_orders).post(create_order),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}",
            get(get_order),
        )
        .route(
            "/internal/telegram/contacts/{telegram_user_id}/orders/{reference}/cancel",
            post(cancel_order),
        )
        .route(
            "/internal/telegram/payments/sepay",
            post(record_sepay_payment),
        )
        .route("/internal/telegram/audience", get(list_audience))
        .route(
            "/internal/telegram/audience/{chat_id}/block",
            post(block_contact),
        )
        .route("/internal/telegram/catalogue", get(catalogue))
        .route("/internal/telegram/catalogue/full", get(full_catalogue))
        .route("/internal/telegram/products", post(create_product))
        .route(
            "/internal/telegram/products/{slug}",
            get(get_product).patch(adjust_product),
        )
        .route(
            "/internal/telegram/products/{slug}/restock",
            post(restock_product),
        )
}
