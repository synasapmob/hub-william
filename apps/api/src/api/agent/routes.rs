use axum::{
    Router,
    middleware::from_fn_with_state,
    routing::{delete, get, post},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{Limit, UserLimit, limit_by_user},
    core::AppState,
};

use super::{
    connections::{
        complete_authorization, connect_deepseek, connect_groq, disconnect, get_connection,
        list_connections, refresh_connection, reset_connection_credits, start,
    },
    pools::{create_request, decide_request, invite_member, list, remove_member},
};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    let pool_request = UserLimit::new(state, Limit::PoolRequest);
    let pool_invite = UserLimit::new(state, Limit::PoolInvite);
    // Accepting a request and removing a member are both owner moderation.
    let pool_decision = UserLimit::new(state, Limit::PoolDecision);
    let key_connect = UserLimit::new(state, Limit::AgentKeyConnect);
    // Starting and completing the OAuth flow are one connection attempt.
    let oauth = UserLimit::new(state, Limit::AgentOAuth);
    let refresh = UserLimit::new(state, Limit::AgentRefresh);
    let reset_credits = UserLimit::new(state, Limit::AgentResetCredits);

    Router::new()
        .route("/agent-pools", get(list))
        .route(
            "/agent-pools/{connection_id}/requests",
            post(create_request).layer(from_fn_with_state(pool_request, limit_by_user)),
        )
        .route(
            "/agent-pools/{connection_id}/members",
            post(invite_member).layer(from_fn_with_state(pool_invite, limit_by_user)),
        )
        .route(
            "/agent-pools/{connection_id}/members/{username}",
            delete(remove_member).layer(from_fn_with_state(pool_decision.clone(), limit_by_user)),
        )
        .route(
            "/agent-pool-requests/{request_id}/decision",
            post(decide_request).layer(from_fn_with_state(pool_decision, limit_by_user)),
        )
        .route("/agent-connections", get(list_connections))
        .route(
            "/agent-connections/deepseek",
            post(connect_deepseek).layer(from_fn_with_state(key_connect.clone(), limit_by_user)),
        )
        .route(
            "/agent-connections/groq",
            post(connect_groq).layer(from_fn_with_state(key_connect, limit_by_user)),
        )
        .route(
            "/agent-connections/start",
            post(start).layer(from_fn_with_state(oauth.clone(), limit_by_user)),
        )
        .route(
            "/agent-connections/{connection_id}",
            get(get_connection).delete(disconnect),
        )
        .route(
            "/agent-connections/{connection_id}/complete",
            post(complete_authorization).layer(from_fn_with_state(oauth, limit_by_user)),
        )
        .route(
            "/agent-connections/{connection_id}/refresh",
            post(refresh_connection).layer(from_fn_with_state(refresh, limit_by_user)),
        )
        .route(
            "/agent-connections/{connection_id}/reset-credits",
            post(reset_connection_credits).layer(from_fn_with_state(reset_credits, limit_by_user)),
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
