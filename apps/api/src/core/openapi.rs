use utoipa::OpenApi;

use crate::{agent, auth, gateway, organizations, playground, tts};

use super::{ErrorResponse, health};

#[derive(OpenApi)]
#[openapi(info(
    title = "Hub William API",
    description = "Control-plane and gateway API for Hub William agent pools",
    version = "0.1.0"
))]
struct Info;

#[derive(OpenApi)]
#[openapi(
    paths(super::health::health),
    components(schemas(ErrorResponse, health::HealthResponse)),
    tags((name = "system", description = "Runtime health and diagnostics"))
)]
struct SystemApi;

/// The published OpenAPI document. Each feature contributes its own fragment
/// from its `routes.rs`; this is the only place that lists them.
pub struct ApiDoc;

impl OpenApi for ApiDoc {
    fn openapi() -> utoipa::openapi::OpenApi {
        let mut document = Info::openapi();
        for fragment in [
            auth::AuthApi::openapi(),
            agent::AgentApi::openapi(),
            organizations::OrganizationsApi::openapi(),
            gateway::GatewayApi::openapi(),
            playground::PlaygroundApi::openapi(),
            tts::TtsApi::openapi(),
            SystemApi::openapi(),
        ] {
            document.merge(fragment);
        }
        document
    }
}
