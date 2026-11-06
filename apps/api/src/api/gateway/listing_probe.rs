//! Trying an account before it goes on sale, and again before it is sold: the
//! provider must answer a request through that account the way it would answer a
//! customer's. The request is the model list, which costs no tokens.

use uuid::Uuid;

use super::{models::models_for_user, selection::SERVED_CONNECTION_HEADER};
use crate::{core::ApiError, utils::provider_catalogue::AgentProvider};

/// Asks `provider` for its model list through `connection_id`, which belongs to
/// `user_id`. It passes when the provider answers through that very account; the
/// error says why it did not.
pub(crate) async fn probe_connection(
    state: &crate::core::AppState,
    user_id: Uuid,
    connection_id: Uuid,
    provider: AgentProvider,
) -> Result<(), ApiError> {
    let reason = match models_for_user(state, user_id, connection_id, provider).await {
        // The gateway fails over to the owner's other accounts for the same agent, so
        // the account asked must be the one that answered. Gemini's list names no
        // account, so there the answer is taken as it comes.
        Ok(response) if response.status().is_success() => {
            let served = response
                .headers()
                .get(SERVED_CONNECTION_HEADER)
                .and_then(|value| value.to_str().ok());

            if served.is_none_or(|served| served == connection_id.to_string()) {
                return Ok(());
            }

            "the provider only answered through another account".to_owned()
        }
        Ok(response) => format!("the provider answered {}", response.status().as_u16()),
        Err(ApiError::Provider(message)) => message,
        Err(_) => "the account could not be used".to_owned(),
    };

    Err(ApiError::Provider(format!(
        "The {} account did not answer a test request: {}",
        provider.as_str(),
        reason.trim_end_matches('.')
    )))
}
