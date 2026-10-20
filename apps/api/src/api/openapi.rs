use utoipa::OpenApi;

use crate::core::ErrorResponse;

use super::{agent, auth, gateway, health, organizations, playground, reel, tts};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Hub William API",
        description = "Control-plane and gateway API for Hub William agent pools",
        version = "0.1.0"
    ),
    components(schemas(ErrorResponse))
)]
struct Info;

/// The published OpenAPI document, assembled from each feature's fragment.
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
            reel::ReelApi::openapi(),
            health::HealthApi::openapi(),
        ] {
            document.merge(fragment);
        }
        document
    }
}
