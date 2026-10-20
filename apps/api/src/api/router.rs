use axum::{Router, http::HeaderName};
use utoipa::OpenApi;
use utoipa_swagger_ui::SwaggerUi;

use crate::core::{AppState, cors};

use super::{ApiDoc, agent, auth, gateway, health, organizations, playground, reel, telegram, tts};

pub fn app(state: AppState) -> Router {
    let cors = cors::layer(
        &state.config,
        [HeaderName::from_static(gateway::SERVED_CONNECTION_HEADER)],
    );

    Router::new()
        .merge(health::routes())
        .merge(tts::routes())
        .merge(reel::routes())
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
