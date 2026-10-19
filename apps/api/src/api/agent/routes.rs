use axum::{
    Router,
    routing::{delete, get, post},
};
use utoipa::OpenApi;

use crate::core::AppState;

use super::{
    connections::{
        complete_authorization, connect_deepseek, connect_groq, disconnect, get_connection,
        list_connections, refresh_connection, reset_connection_credits, start,
    },
    pools::{create_request, decide_request, invite_member, list, remove_member},
};

pub(crate) fn routes() -> Router<AppState> {
    Router::new()
        .route("/agent-pools", get(list))
        .route(
            "/agent-pools/{connection_id}/requests",
            post(create_request),
        )
        .route("/agent-pools/{connection_id}/members", post(invite_member))
        .route(
            "/agent-pools/{connection_id}/members/{username}",
            delete(remove_member),
        )
        .route(
            "/agent-pool-requests/{request_id}/decision",
            post(decide_request),
        )
        .route("/agent-connections", get(list_connections))
        .route("/agent-connections/deepseek", post(connect_deepseek))
        .route("/agent-connections/groq", post(connect_groq))
        .route("/agent-connections/start", post(start))
        .route(
            "/agent-connections/{connection_id}",
            get(get_connection).delete(disconnect),
        )
        .route(
            "/agent-connections/{connection_id}/complete",
            post(complete_authorization),
        )
        .route(
            "/agent-connections/{connection_id}/refresh",
            post(refresh_connection),
        )
        .route(
            "/agent-connections/{connection_id}/reset-credits",
            post(reset_connection_credits),
        )
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::pools::list,
        super::pools::create_request,
        super::pools::decide_request,
        super::pools::invite_member,
        super::pools::remove_member,
        super::connections::list_connections,
        super::connections::start,
        super::connections::connect_deepseek,
        super::connections::connect_groq,
        super::connections::get_connection,
        super::connections::refresh_connection,
        super::connections::reset_connection_credits,
        super::connections::complete_authorization,
        super::connections::disconnect
    ),
    components(schemas(
        crate::utils::provider_catalogue::AgentProvider,
        super::connections::AgentConnection,
        super::connections::AgentConnectionStatus,
        super::connections::CompleteAuthorizationRequest,
        super::connections::ConnectDeepseekRequest,
        super::connections::ConnectGroqRequest,
        super::connections::StartAgentConnectionRequest,
        super::pools::AgentPool,
        super::pools::AgentPoolAvailability,
        super::pools::AgentPoolAvailabilityStatus,
        super::pools::AgentPoolJoinRequest,
        super::pools::AgentPoolPerson,
        super::pools::AgentPoolRequestStatus,
        super::pools::AgentPoolShareEvidence,
        super::pools::AgentPoolUsageMetric,
        super::pools::CreateAgentPoolJoinRequest,
        super::pools::DecideAgentPoolJoinRequest,
        super::pools::InviteAgentPoolMember
    )),
    tags(
        (name = "agent connections", description = "Encrypted upstream provider connection lifecycle"),
        (name = "agent pools", description = "Public connected account pools and authenticated membership requests")
    )
)]
pub(crate) struct AgentApi;
