use axum::{
    Router,
    middleware::from_fn_with_state,
    routing::{delete, get, post, put},
};
use utoipa::OpenApi;

use crate::{
    api::limits::{Limit, UserLimit, limit_by_user},
    core::AppState,
};

use super::{
    accept_invitation, create_organization, decline_invitation, delete_organization, invite_member,
    leave_organization, list_agents, list_invitations, list_members, list_organization_summaries,
    list_organizations, overview, remove_member, set_default_organization, share_agent,
    unshare_agent, usage,
};

pub(crate) fn routes(state: &AppState) -> Router<AppState> {
    // Every write below spends from one per-user budget; reads are unlimited.
    let write = from_fn_with_state(
        UserLimit::new(state, Limit::OrganizationWrite),
        limit_by_user,
    );

    Router::new()
        .route(
            "/organizations",
            get(list_organizations).merge(post(create_organization).layer(write.clone())),
        )
        .route("/organization-summaries", get(list_organization_summaries))
        .route("/organization-invitations", get(list_invitations))
        .route(
            "/organization-invitations/{invitation_id}/accept",
            post(accept_invitation).layer(write.clone()),
        )
        .route(
            "/organization-invitations/{invitation_id}",
            delete(decline_invitation).layer(write.clone()),
        )
        .route(
            "/organizations/{id}",
            delete(delete_organization).layer(write.clone()),
        )
        .route(
            "/organizations/{id}/default",
            put(set_default_organization).layer(write.clone()),
        )
        .route(
            "/organizations/{id}/membership",
            delete(leave_organization).layer(write.clone()),
        )
        .route("/organizations/{id}/overview", get(overview))
        .route(
            "/organizations/{id}/agents",
            get(list_agents).merge(post(share_agent).layer(write.clone())),
        )
        .route(
            "/organizations/{id}/agents/{connection_id}",
            delete(unshare_agent).layer(write.clone()),
        )
        .route(
            "/organizations/{id}/members",
            get(list_members).merge(post(invite_member).layer(write.clone())),
        )
        .route(
            "/organizations/{id}/members/{username}",
            delete(remove_member).layer(write),
        )
        .route("/organizations/{id}/usage", get(usage))
}

#[derive(OpenApi)]
#[openapi(
    paths(
        super::list_organizations,
        super::list_organization_summaries,
        super::create_organization,
        super::delete_organization,
        super::set_default_organization,
        super::leave_organization,
        super::list_invitations,
        super::accept_invitation,
        super::decline_invitation,
        super::overview,
        super::list_agents,
        super::share_agent,
        super::unshare_agent,
        super::list_members,
        super::invite_member,
        super::remove_member,
        super::usage
    ),
    components(schemas(
        super::CreateOrganization,
        super::InviteOrganizationMember,
        super::Organization,
        super::OrganizationAgent,
        super::OrganizationAgentDetails,
        super::OrganizationAgentListQuery,
        super::OrganizationInvitation,
        super::OrganizationMember,
        super::OrganizationOverview,
        super::OrganizationPeriodQuery,
        super::OrganizationSummary,
        super::OrganizationUsage,
        super::OrganizationUsageBreakdown,
        super::OrganizationUsageDay,
        super::OrganizationUsageQuery,
        super::ShareOrganizationAgent
    )),
    tags((name = "organizations", description = "Organization membership, shared agents, and recorded usage"))
)]
pub(crate) struct OrganizationsApi;
