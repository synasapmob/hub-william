//! What the gateway asks of the service: whether a service key's request may
//! start, and what the request cost once it has ended.

use sqlx::PgPool;
use uuid::Uuid;

use super::{
    money::{Tokens, request_cost_micro},
    wallet,
};
use crate::{core::ApiError, utils::provider_catalogue::AgentProvider};

/// A request starts only when the wallet holds at least this much, $0.05. What
/// it costs is known only when it ends, so this much has to be there to pay for
/// it.
pub(crate) const MIN_BALANCE_MICRO: i64 = 50_000;

/// Run before a request is sent to the provider. `service_owner` is the owner of
/// the service key that sent it, and none for any other request, which is let
/// through untouched. A service key's request must name a model the service
/// sells, and the owner's wallet must hold the minimum.
pub(crate) async fn authorize_request(
    pool: &PgPool,
    service_owner: Option<Uuid>,
    provider: AgentProvider,
    model: Option<&str>,
) -> Result<(), ApiError> {
    let Some(user_id) = service_owner else {
        return Ok(());
    };
    let Some(model) = model else {
        return Err(ApiError::Validation("Name the model the request is for."));
    };
    if wallet::sold_model(pool, &provider.to_string(), model)
        .await?
        .is_none()
    {
        return Err(ApiError::Validation("This model is not on the price list."));
    }
    if wallet::read(pool, user_id).await? < MIN_BALANCE_MICRO {
        return Err(ApiError::InsufficientBalance);
    }

    Ok(())
}

/// One service request that has ended, as the usage event recorded it.
pub(crate) struct ChargedRequest<'a> {
    pub(crate) usage_event_id: Uuid,
    /// The owner of the service key, who pays.
    pub(crate) user_id: Uuid,
    pub(crate) provider: AgentProvider,
    pub(crate) model: Option<&'a str>,
    pub(crate) tokens: Tokens,
}

/// Charges the owner of a service key for a request that has ended, at the price
/// of the model it named, and returns what was taken. A request with no token
/// counts costs nothing.
pub(crate) async fn charge_request(
    pool: &PgPool,
    request: ChargedRequest<'_>,
) -> Result<i64, ApiError> {
    let prices = wallet::price_book(pool).await?;
    let price = prices.price(&request.provider.to_string(), request.model);
    let Some(cost) = request_cost_micro(request.tokens, price) else {
        eprintln!(
            "service charge does not fit for usage event {}",
            request.usage_event_id
        );

        return Ok(0);
    };
    if cost == 0 {
        return Ok(0);
    }
    let charged = wallet::charge(pool, request.user_id, request.usage_event_id, cost).await?;
    if charged < cost {
        eprintln!(
            "service charge of usage event {} was short by {} micro-dollars",
            request.usage_event_id,
            cost - charged
        );
    }

    Ok(charged)
}
