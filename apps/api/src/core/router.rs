use axum::{Router, http::HeaderName};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::{agent, auth, gateway, organizations, playground, telegram, tts};

use super::{ApiDoc, AppState, cors, health};

/// Composition root of the HTTP surface. A feature adds its endpoints by
/// exposing `routes()` from its own `routes.rs`; this is the only place that
/// lists the features.
pub fn app(state: AppState) -> Router {
    let cors = cors::layer(
        &state.config,
        [HeaderName::from_static(gateway::SERVED_CONNECTION_HEADER)],
    );

    Router::new()
        .merge(health::routes())
        .merge(tts::routes())
        .merge(auth::routes())
        .merge(telegram::routes())
        .merge(organizations::routes())
        .merge(agent::routes())
        .merge(gateway::routes())
        .merge(playground::routes(&state))
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(cors)
        .with_state(state)
}
