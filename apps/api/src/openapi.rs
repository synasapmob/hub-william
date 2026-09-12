use utoipa::OpenApi;

use crate::{
    AgentConnection, AgentConnectionStatus, AgentPool, AgentPoolAvailability,
    AgentPoolAvailabilityStatus, AgentPoolJoinRequest, AgentPoolPerson, AgentPoolRequestStatus,
    AgentPoolShareEvidence, AgentPoolUsageMetric, AgentProvider, AuthenticatedUser,
    CompleteAuthorizationRequest, CreateAgentPoolJoinRequest, CreatedGatewayKey,
    DecideAgentPoolJoinRequest, ErrorResponse, GatewayKey, HealthResponse, InviteAgentPoolMember,
    LoginRequest, RegisterRequest, SessionResponse, StartAgentConnectionRequest,
};

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Hub William API",
        description = "Control-plane and gateway API for Hub William agent pools",
        version = "0.1.0"
    ),
    paths(
        crate::health::health,
        crate::auth::register,
        crate::auth::login,
        crate::auth::session,
        crate::auth::logout,
        crate::auth::refresh,
        crate::agent_pools::list,
        crate::agent_pools::create_request,
        crate::agent_pools::decide_request,
        crate::agent_pools::invite_member,
        crate::agent_pools::remove_member,
        crate::agent_pools::retry_pool,
        crate::connections::list_connections,
        crate::connections::start,
        crate::connections::get_connection,
        crate::connections::complete_authorization,
        crate::connections::disconnect,
        crate::gateway::create_key,
        crate::gateway::list_keys,
        crate::gateway::revoke_key
    ),
    components(schemas(
        AuthenticatedUser,
        AgentConnection,
        AgentConnectionStatus,
        AgentPool,
        AgentPoolAvailability,
        AgentPoolAvailabilityStatus,
        AgentPoolJoinRequest,
        AgentPoolPerson,
        AgentPoolRequestStatus,
        AgentPoolShareEvidence,
        AgentPoolUsageMetric,
        AgentProvider,
        CompleteAuthorizationRequest,
        CreateAgentPoolJoinRequest,
        CreatedGatewayKey,
        DecideAgentPoolJoinRequest,
        ErrorResponse,
        GatewayKey,
        HealthResponse,
        LoginRequest,
        InviteAgentPoolMember,
        RegisterRequest,
        SessionResponse,
        StartAgentConnectionRequest
    )),
    tags(
        (name = "auth", description = "Browser account sessions"),
        (name = "agent connections", description = "Encrypted upstream provider connection lifecycle"),
        (name = "agent pools", description = "Public connected account pools and authenticated membership requests"),
        (name = "gateway keys", description = "Revocable keys for provider-specific gateway access"),
        (name = "system", description = "Runtime health and diagnostics")
    )
)]
pub struct ApiDoc;
