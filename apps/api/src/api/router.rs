use axum::{
    Router,
    http::{HeaderName, header::RETRY_AFTER},
};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::core::{AppState, cors};

use super::{
    ApiDoc, agent, auth, dashboard, gateway, health, organizations, partner, playground, reel,
    service, telegram, tts,
};

pub fn app(state: AppState) -> Router {
    let cors = cors::layer(
        &state.config,
        [
            HeaderName::from_static(gateway::SERVED_CONNECTION_HEADER),
            RETRY_AFTER,
        ],
    );

    Router::new()
        .merge(health::routes())
        .merge(tts::routes(&state))
        .merge(reel::routes(&state))
        .merge(auth::routes(&state))
        .merge(telegram::routes())
        .merge(partner::routes(&state))
        .merge(organizations::routes(&state))
        .merge(agent::routes(&state))
        .merge(gateway::routes(&state))
        .merge(playground::routes(&state))
        .merge(service::routes(&state))
        .merge(dashboard::routes(&state))
        .merge(SwaggerUi::new("/docs").url("/api-docs/openapi.json", ApiDoc::openapi()))
        .layer(cors)
        .with_state(state)
}
