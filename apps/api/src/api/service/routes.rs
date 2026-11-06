use axum::{
    Router,
    middleware::from_fn_with_state,
    routing::{delete, get, post},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{Limit, UserLimit, limit_by_user},
    core::AppState,
};

use super::{
    keys::{create_service_key, list_service_keys, revoke_service_key},
    listings::{list_owned_tickets, list_ticket_listings, purchase_ticket, reissue_ticket_key},
    pricing, service_usage,
    stripe::stripe_webhook,
    top_up, wallet,
};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    // A top-up moves money and a new key opens a way to spend it, so both have a
    // budget of their own.
    let limited = UserLimit::new(state, Limit::ServiceWallet);

    Router::new()
        .route("/service/pricing", get(pricing))
        .route("/service/listings", get(list_ticket_listings))
        .route("/service/tickets", get(list_owned_tickets))
        .route("/service/wallet", get(wallet))
        // Stripe, not a customer, calls this: it is signed, so it has no session
        // and no budget per user.
        .route("/stripe/webhook", post(stripe_webhook))
        .route("/service/usage", get(service_usage))
        .route("/service/keys/{key_id}", delete(revoke_service_key))
        .route(
            "/service/keys",
            get(list_service_keys).merge(
                post(create_service_key).layer(from_fn_with_state(limited.clone(), limit_by_user)),
            ),
        )
        .merge(
            Router::new()
                .route("/service/top-up", post(top_up))
                .route("/service/listings/{id}/purchase", post(purchase_ticket))
                .route(
                    "/service/tickets/{key_id}/reissue",
                    post(reissue_ticket_key),
                )
                .layer(from_fn_with_state(limited, limit_by_user)),
        )
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::pricing,
        super::wallet,
        super::top_up,
        super::service_usage,
        super::listings::list_ticket_listings,
        super::listings::purchase_ticket,
        super::listings::list_owned_tickets,
        super::listings::reissue_ticket_key,
        super::keys::create_service_key,
        super::keys::list_service_keys,
        super::keys::revoke_service_key
    ),
    components(schemas(
        super::listings::OwnedTicket,
        super::listings::OwnedTickets,
        super::listings::PurchasedTicket,
        super::listings::QuotaMetric,
        super::listings::TicketListing,
        super::listings::TicketListings,
        super::listings::TicketProvider,
        super::ServiceAmount,
        super::ServiceModel,
        super::ServicePrice,
        super::ServiceProvider,
        super::ServicePricing,
        super::ServiceTopUp,
        super::ServiceWallet
    )),
    tags((name = "service", description = "Agents the platform rents, paid for as they are used: pricing, wallet, top-up, keys and usage"))
)]
pub(crate) struct ServiceApi;
