use utoipa::OpenApi;

use crate::HealthResponse;

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Hub William API",
        description = "Control-plane and gateway API for Hub William agent pools",
        version = "0.1.0"
    ),
    paths(crate::health::health),
    components(schemas(HealthResponse)),
    tags((name = "system", description = "Runtime health and diagnostics"))
)]
pub struct ApiDoc;
