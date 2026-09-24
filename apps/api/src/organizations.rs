use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use std::str::FromStr;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AgentPoolUsageMetric, AgentProvider, AppState, auth::authenticated_user_id,
    auth::normalize_username, error::ApiError, usage,
};

const DEFAULT_PERIOD_DAYS: i64 = 30;
const MAX_PERIOD_DAYS: i64 = 365;

#[derive(Debug, Serialize, ToSchema)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub description: Option<String>,
    pub role: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateOrganization {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationInvitation {
    pub id: Uuid,
    pub organization_id: Uuid,
    pub organization_name: String,
    pub invited_by_username: Option<String>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationAgent {
    pub id: Uuid,
    pub provider: String,
    pub account_label: Option<String>,
    pub owner_username: String,
    pub availability_status: String,
    pub rate_limited_until: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationAgentDetails {
    pub id: Uuid,
    pub provider: String,
    pub account_label: Option<String>,
    pub owner_username: String,
    pub availability_status: String,
    pub rate_limited_until: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub plan: String,
    pub usage: Vec<AgentPoolUsageMetric>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ShareOrganizationAgent {
    pub connection_id: Uuid,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OrganizationAgentListQuery {
    pub include_usage: Option<bool>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationMember {
    /// The Hub user ID, also used by the Usage member_id filter.
    pub id: Uuid,
    pub username: String,
    pub role: String,
    pub status: String,
    pub joined_at: Option<DateTime<Utc>>,
    pub invited_at: DateTime<Utc>,
    pub invited_by_username: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct InviteOrganizationMember {
    pub username: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationUsageDay {
    pub date: String,
    pub requests: i64,
    pub known_total_tokens: i64,
    pub token_known_requests: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationOverview {
    pub organization: Organization,
    pub period_days: i64,
    pub agent_count: i64,
    pub member_count: i64,
    pub requests: i64,
    pub known_input_tokens: i64,
    pub known_output_tokens: i64,
    pub known_cached_tokens: i64,
    pub token_known_requests: i64,
    pub daily_usage: Vec<OrganizationUsageDay>,
    pub agents: Vec<OrganizationAgent>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationUsageBreakdown {
    pub member_id: Uuid,
    pub username: String,
    pub connection_id: Option<Uuid>,
    pub provider: String,
    pub model: Option<String>,
    pub requests: i64,
    pub known_input_tokens: i64,
    pub known_output_tokens: i64,
    pub known_cached_tokens: i64,
    pub token_known_requests: i64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct OrganizationUsage {
    pub period_days: i64,
    pub requests: i64,
    pub known_input_tokens: i64,
    pub known_output_tokens: i64,
    pub known_cached_tokens: i64,
    pub token_known_requests: i64,
    pub daily_usage: Vec<OrganizationUsageDay>,
    pub breakdown: Vec<OrganizationUsageBreakdown>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OrganizationPeriodQuery {
    pub days: Option<i64>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct OrganizationUsageQuery {
    pub days: Option<i64>,
    pub member_id: Option<Uuid>,
    pub connection_id: Option<Uuid>,
    pub model: Option<String>,
}

#[derive(FromRow)]
struct OrganizationRow {
    id: Uuid,
    name: String,
    description: Option<String>,
    role: String,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct InvitationRow {
    id: Uuid,
    organization_id: Uuid,
    organization_name: String,
    invited_by_username: Option<String>,
    created_at: DateTime<Utc>,
}

#[derive(FromRow)]
struct AgentRow {
    id: Uuid,
    provider: String,
    account_label: Option<String>,
    owner_username: String,
    availability_status: String,
    rate_limited_until: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    plan: Option<String>,
}

#[derive(FromRow)]
struct MemberRow {
    id: Uuid,
    username: String,
    role: String,
    status: String,
    joined_at: Option<DateTime<Utc>>,
    invited_at: DateTime<Utc>,
    invited_by_username: Option<String>,
}

#[derive(FromRow)]
struct UsageTotals {
    requests: i64,
    known_input_tokens: i64,
    known_output_tokens: i64,
    known_cached_tokens: i64,
    token_known_requests: i64,
}

#[derive(FromRow)]
struct UsageDayRow {
    date: NaiveDate,
    requests: i64,
    known_total_tokens: i64,
    token_known_requests: i64,
}

#[derive(FromRow)]
struct UsageBreakdownRow {
    member_id: Uuid,
    username: String,
    connection_id: Option<Uuid>,
    provider: String,
    model: Option<String>,
    requests: i64,
    known_input_tokens: i64,
    known_output_tokens: i64,
    known_cached_tokens: i64,
    token_known_requests: i64,
}

struct Period {
    days: i64,
    start: DateTime<Utc>,
    end: DateTime<Utc>,
    first_day: NaiveDate,
}

#[utoipa::path(
    get,
    path = "/organizations",
    responses((status = 200, description = "Organizations where the viewer is an accepted member", body = [Organization])),
    tag = "organizations"
)]
pub async fn list_organizations(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<Organization>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, OrganizationRow>(
        "SELECT organizations.id, organizations.name, organizations.description, memberships.role, organizations.created_at
         FROM organizations
         JOIN organization_memberships AS memberships ON memberships.org_id = organizations.id
         WHERE memberships.user_id = $1 AND memberships.status = 'accepted'
         ORDER BY organizations.created_at, organizations.id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(Json(rows.into_iter().map(Organization::from).collect()))
}

#[utoipa::path(
    post,
    path = "/organizations",
    request_body = CreateOrganization,
    responses((status = 201, description = "Organization created", body = Organization)),
    tag = "organizations"
)]
pub async fn create_organization(
    State(state): State<AppState>,
    jar: CookieJar,
    Json(payload): Json<CreateOrganization>,
) -> Result<(StatusCode, Json<Organization>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let name = payload.name.trim();
    if name.is_empty() || name.chars().count() > 80 {
        return Err(ApiError::Validation(
            "Organization name must be between 1 and 80 characters.",
        ));
    }
    let description = payload
        .description
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if description.is_some_and(|value| value.chars().count() > 350) {
        return Err(ApiError::Validation(
            "Organization description must be 350 characters or fewer.",
        ));
    }
    let id = Uuid::new_v4();
    let membership_id = Uuid::new_v4();
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let created_at = sqlx::query_scalar::<_, DateTime<Utc>>(
        "INSERT INTO organizations (id, name, description) VALUES ($1, $2, $3) RETURNING created_at",
    )
    .bind(id)
    .bind(name)
    .bind(description)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    sqlx::query(
        "INSERT INTO organization_memberships
            (id, org_id, user_id, role, status, joined_at)
         VALUES ($1, $2, $3, 'owner', 'accepted', NOW())",
    )
    .bind(membership_id)
    .bind(id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok((
        StatusCode::CREATED,
        Json(Organization {
            id,
            name: name.to_owned(),
            description: description.map(str::to_owned),
            role: "owner".to_owned(),
            created_at,
        }),
    ))
}

#[utoipa::path(
    get,
    path = "/organization-invitations",
    responses((status = 200, description = "Viewer's pending organization invitations", body = [OrganizationInvitation])),
    tag = "organizations"
)]
pub async fn list_invitations(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<OrganizationInvitation>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, InvitationRow>(
        "SELECT memberships.id, organizations.id AS organization_id,
                organizations.name AS organization_name,
                inviters.username AS invited_by_username, memberships.created_at
         FROM organization_memberships AS memberships
         JOIN organizations ON organizations.id = memberships.org_id
         LEFT JOIN users AS inviters ON inviters.id = memberships.invited_by_user_id
         WHERE memberships.user_id = $1 AND memberships.status = 'pending'
         ORDER BY memberships.created_at, memberships.id",
    )
    .bind(user_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(Json(
        rows.into_iter().map(OrganizationInvitation::from).collect(),
    ))
}

#[utoipa::path(
    post,
    path = "/organization-invitations/{invitation_id}/accept",
    params(("invitation_id" = Uuid, Path, description = "Pending membership ID")),
    responses((status = 200, description = "Invitation accepted", body = Organization)),
    tag = "organizations"
)]
pub async fn accept_invitation(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(invitation_id): Path<Uuid>,
) -> Result<Json<Organization>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let org_id = sqlx::query_scalar::<_, Uuid>(
        "UPDATE organization_memberships
         SET status = 'accepted', joined_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'pending'
         RETURNING org_id",
    )
    .bind(invitation_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    Ok(Json(organization_for_user(&state, org_id, user_id).await?))
}

#[utoipa::path(
    delete,
    path = "/organization-invitations/{invitation_id}",
    params(("invitation_id" = Uuid, Path, description = "Pending membership ID")),
    responses((status = 204, description = "Invitation declined")),
    tag = "organizations"
)]
pub async fn decline_invitation(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(invitation_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let result = sqlx::query(
        "DELETE FROM organization_memberships
         WHERE id = $1 AND user_id = $2 AND status = 'pending'",
    )
    .bind(invitation_id)
    .bind(user_id)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/organizations/{id}/overview",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("days" = Option<i64>, Query, description = "UTC calendar days, 1 through 365; defaults to 30")
    ),
    responses((status = 200, description = "Organization overview", body = OrganizationOverview)),
    tag = "organizations"
)]
pub async fn overview(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
    Query(query): Query<OrganizationPeriodQuery>,
) -> Result<Json<OrganizationOverview>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let organization = organization_for_user(&state, org_id, user_id).await?;
    let period = period(query.days)?;
    let agents = agents_for_org(&state, org_id).await?;
    let member_count = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM organization_memberships
         WHERE org_id = $1 AND status = 'accepted'",
    )
    .bind(org_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    let totals = usage_totals(&state, org_id, &period, None, None, None).await?;
    let daily_usage = usage_days(&state, org_id, &period, None, None, None).await?;
    Ok(Json(OrganizationOverview {
        organization,
        period_days: period.days,
        agent_count: agents.len() as i64,
        member_count,
        requests: totals.requests,
        known_input_tokens: totals.known_input_tokens,
        known_output_tokens: totals.known_output_tokens,
        known_cached_tokens: totals.known_cached_tokens,
        token_known_requests: totals.token_known_requests,
        daily_usage,
        agents,
    }))
}

#[utoipa::path(
    get,
    path = "/organizations/{id}/agents",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("include_usage" = Option<bool>, Query, description = "Fetch live provider quota metrics; defaults to false")
    ),
    responses((status = 200, description = "Shared connected agents and provider usage", body = [OrganizationAgentDetails])),
    tag = "organizations"
)]
pub async fn list_agents(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
    Query(query): Query<OrganizationAgentListQuery>,
) -> Result<Json<Vec<OrganizationAgentDetails>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    organization_for_user(&state, org_id, user_id).await?;
    let rows = agent_rows_for_org(&state, org_id).await?;
    let mut agents = Vec::with_capacity(rows.len());
    let mut usage_tasks = tokio::task::JoinSet::new();
    for (index, row) in rows.into_iter().enumerate() {
        let provider = AgentProvider::from_str(&row.provider)?;
        let connection_id = row.id;
        agents.push(OrganizationAgentDetails {
            id: row.id,
            provider: row.provider,
            account_label: row.account_label,
            owner_username: row.owner_username,
            availability_status: row.availability_status,
            rate_limited_until: row.rate_limited_until,
            created_at: row.created_at,
            plan: row.plan.unwrap_or_else(|| "Unknown".to_owned()),
            usage: Vec::new(),
        });
        if query.include_usage.unwrap_or(false)
            && matches!(provider, AgentProvider::Chatgpt | AgentProvider::Claude)
        {
            let state = state.clone();
            usage_tasks.spawn(async move {
                (
                    index,
                    usage::for_connection(&state, connection_id, provider).await,
                )
            });
        }
    }
    while let Some(joined) = usage_tasks.join_next().await {
        if let Ok((index, usage)) = joined {
            agents[index].usage = usage.metrics;
        }
    }
    Ok(Json(agents))
}

#[utoipa::path(
    post,
    path = "/organizations/{id}/agents",
    params(("id" = Uuid, Path, description = "Organization ID")),
    request_body = ShareOrganizationAgent,
    responses((status = 201, description = "Owned agent shared with organization", body = OrganizationAgent)),
    tag = "organizations"
)]
pub async fn share_agent(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
    Json(payload): Json<ShareOrganizationAgent>,
) -> Result<(StatusCode, Json<OrganizationAgent>), ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let accepted = sqlx::query_scalar::<_, bool>(
        "SELECT status = 'accepted' FROM organization_memberships
         WHERE org_id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .unwrap_or(false);
    if !accepted {
        return Err(ApiError::Forbidden);
    }
    let connection_owner = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM agent_connections
         WHERE id = $1 AND status = 'connected' FOR UPDATE",
    )
    .bind(payload.connection_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if connection_owner != user_id {
        return Err(ApiError::Forbidden);
    }
    let inserted = sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
         VALUES ($1, $2, $3)",
    )
    .bind(org_id)
    .bind(payload.connection_id)
    .bind(user_id)
    .execute(&mut *transaction)
    .await;
    if let Err(error) = inserted {
        if is_unique_violation(&error) {
            return Err(ApiError::Validation(
                "That agent is already shared with this organization.",
            ));
        }
        return Err(database_error(error));
    }
    transaction.commit().await.map_err(database_error)?;
    let agent = agent_for_org(&state, org_id, payload.connection_id)
        .await?
        .ok_or(ApiError::Internal)?;
    Ok((StatusCode::CREATED, Json(agent)))
}

#[utoipa::path(
    delete,
    path = "/organizations/{id}/agents/{connection_id}",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("connection_id" = Uuid, Path, description = "Owned connection ID")
    ),
    responses((status = 204, description = "Agent unshared")),
    tag = "organizations"
)]
pub async fn unshare_agent(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((org_id, connection_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM organization_memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'accepted' FOR UPDATE",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Forbidden)?;
    let connection_owner = sqlx::query_scalar::<_, Uuid>(
        "SELECT user_id FROM agent_connections WHERE id = $1 FOR UPDATE",
    )
    .bind(connection_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if connection_owner != user_id && role != "owner" {
        return Err(ApiError::Forbidden);
    }
    let result =
        sqlx::query("DELETE FROM organization_agents WHERE org_id = $1 AND connection_id = $2")
            .bind(org_id)
            .bind(connection_id)
            .execute(&mut *transaction)
            .await
            .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/organizations/{id}/members",
    params(("id" = Uuid, Path, description = "Organization ID")),
    responses((status = 200, description = "Accepted and pending organization members", body = [OrganizationMember])),
    tag = "organizations"
)]
pub async fn list_members(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
) -> Result<Json<Vec<OrganizationMember>>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    organization_for_user(&state, org_id, user_id).await?;
    let rows = sqlx::query_as::<_, MemberRow>(
        "SELECT users.id, users.username, memberships.role, memberships.status,
                memberships.joined_at, memberships.created_at AS invited_at,
                inviters.username AS invited_by_username
         FROM organization_memberships AS memberships
         JOIN users ON users.id = memberships.user_id
         LEFT JOIN users AS inviters ON inviters.id = memberships.invited_by_user_id
         WHERE memberships.org_id = $1
         ORDER BY CASE WHEN memberships.role = 'owner' THEN 0 ELSE 1 END,
                  CASE WHEN memberships.status = 'accepted' THEN 0 ELSE 1 END,
                  memberships.created_at, users.username",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(Json(
        rows.into_iter().map(OrganizationMember::from).collect(),
    ))
}

#[utoipa::path(
    post,
    path = "/organizations/{id}/members",
    operation_id = "organization_invite_member",
    params(("id" = Uuid, Path, description = "Organization ID")),
    request_body = InviteOrganizationMember,
    responses((status = 201, description = "Existing Hub user invited", body = OrganizationMember)),
    tag = "organizations"
)]
pub async fn invite_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
    Json(payload): Json<InviteOrganizationMember>,
) -> Result<(StatusCode, Json<OrganizationMember>), ApiError> {
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let username = normalize_username(&payload.username)?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM organization_memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'accepted' FOR UPDATE",
    )
    .bind(org_id)
    .bind(owner_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    if role.as_deref() != Some("owner") {
        return Err(ApiError::Forbidden);
    }
    let member_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or(ApiError::NotFound)?;
    if member_id == owner_id {
        return Err(ApiError::Validation("You already own this organization."));
    }
    let row = sqlx::query_as::<_, MemberRow>(
        "INSERT INTO organization_memberships
            (id, org_id, user_id, role, status, invited_by_user_id)
         VALUES ($1, $2, $3, 'member', 'pending', $4)
         RETURNING user_id AS id, $5::text AS username, role, status, joined_at,
                   created_at AS invited_at,
                   (SELECT username FROM users WHERE id = $4) AS invited_by_username",
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(member_id)
    .bind(owner_id)
    .bind(&username)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|error| {
        if is_unique_violation(&error) {
            ApiError::Validation("That user is already invited or a member.")
        } else {
            database_error(error)
        }
    })?;
    transaction.commit().await.map_err(database_error)?;
    Ok((StatusCode::CREATED, Json(row.into())))
}

#[utoipa::path(
    delete,
    path = "/organizations/{id}/members/{username}",
    operation_id = "organization_remove_member",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("username" = String, Path, description = "Hub username")
    ),
    responses((status = 204, description = "Member removed or invitation canceled")),
    tag = "organizations"
)]
pub async fn remove_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((org_id, username)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let username = normalize_username(&username)?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let role = sqlx::query_scalar::<_, String>(
        "SELECT role FROM organization_memberships
         WHERE org_id = $1 AND user_id = $2 AND status = 'accepted' FOR UPDATE",
    )
    .bind(org_id)
    .bind(owner_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    if role.as_deref() != Some("owner") {
        return Err(ApiError::Forbidden);
    }
    let result = sqlx::query(
        "DELETE FROM organization_memberships AS memberships
         USING users
         WHERE memberships.org_id = $1 AND memberships.user_id = users.id
           AND users.username = $2 AND memberships.role = 'member'",
    )
    .bind(org_id)
    .bind(&username)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    transaction.commit().await.map_err(database_error)?;
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    get,
    path = "/organizations/{id}/usage",
    params(
        ("id" = Uuid, Path, description = "Organization ID"),
        ("days" = Option<i64>, Query, description = "UTC calendar days, 1 through 365; defaults to 30"),
        ("member_id" = Option<Uuid>, Query, description = "Hub user ID"),
        ("connection_id" = Option<Uuid>, Query, description = "Shared connection ID"),
        ("model" = Option<String>, Query, description = "Exact upstream model ID")
    ),
    responses((status = 200, description = "Organization usage recorded by accepted upstream requests", body = OrganizationUsage)),
    tag = "organizations"
)]
pub async fn usage(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(org_id): Path<Uuid>,
    Query(query): Query<OrganizationUsageQuery>,
) -> Result<Json<OrganizationUsage>, ApiError> {
    let user_id = authenticated_user_id(&state, &jar).await?;
    organization_for_user(&state, org_id, user_id).await?;
    let period = period(query.days)?;
    let model = query.model.as_deref().filter(|model| !model.is_empty());
    let totals = usage_totals(
        &state,
        org_id,
        &period,
        query.member_id,
        query.connection_id,
        model,
    )
    .await?;
    let daily_usage = usage_days(
        &state,
        org_id,
        &period,
        query.member_id,
        query.connection_id,
        model,
    )
    .await?;
    let rows = sqlx::query_as::<_, UsageBreakdownRow>(
        "SELECT events.user_id AS member_id, users.username, events.connection_id,
                events.provider, events.model, COUNT(*) AS requests,
                COALESCE(SUM(events.input_tokens), 0)::bigint AS known_input_tokens,
                COALESCE(SUM(events.output_tokens), 0)::bigint AS known_output_tokens,
                COALESCE(SUM(events.cached_tokens), 0)::bigint AS known_cached_tokens,
                COUNT(*) FILTER (WHERE events.input_tokens IS NOT NULL
                                 AND events.output_tokens IS NOT NULL) AS token_known_requests
         FROM organization_usage_events AS events
         JOIN users ON users.id = events.user_id
         WHERE events.org_id = $1 AND events.created_at >= $2 AND events.created_at < $3
           AND ($4::uuid IS NULL OR events.user_id = $4)
           AND ($5::uuid IS NULL OR events.connection_id = $5)
           AND ($6::text IS NULL OR events.model = $6)
         GROUP BY events.user_id, users.username, events.connection_id,
                  events.provider, events.model
         ORDER BY requests DESC, users.username, events.provider, events.model",
    )
    .bind(org_id)
    .bind(period.start)
    .bind(period.end)
    .bind(query.member_id)
    .bind(query.connection_id)
    .bind(model)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(Json(OrganizationUsage {
        period_days: period.days,
        requests: totals.requests,
        known_input_tokens: totals.known_input_tokens,
        known_output_tokens: totals.known_output_tokens,
        known_cached_tokens: totals.known_cached_tokens,
        token_known_requests: totals.token_known_requests,
        daily_usage,
        breakdown: rows
            .into_iter()
            .map(OrganizationUsageBreakdown::from)
            .collect(),
    }))
}

async fn organization_for_user(
    state: &AppState,
    org_id: Uuid,
    user_id: Uuid,
) -> Result<Organization, ApiError> {
    let row = sqlx::query_as::<_, OrganizationRow>(
        "SELECT organizations.id, organizations.name, organizations.description, memberships.role, organizations.created_at
         FROM organizations
         JOIN organization_memberships AS memberships ON memberships.org_id = organizations.id
         WHERE organizations.id = $1 AND memberships.user_id = $2
           AND memberships.status = 'accepted'",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Forbidden)?;
    Ok(row.into())
}

async fn agent_rows_for_org(state: &AppState, org_id: Uuid) -> Result<Vec<AgentRow>, ApiError> {
    let rows = sqlx::query_as::<_, AgentRow>(
        "SELECT connections.id, connections.provider, connections.account_label,
                users.username AS owner_username, connections.availability_status,
                connections.rate_limited_until, shares.created_at, connections.plan
         FROM organization_agents AS shares
         JOIN agent_connections AS connections ON connections.id = shares.connection_id
         JOIN users ON users.id = shares.owner_user_id
         JOIN organization_memberships AS memberships
           ON memberships.org_id = shares.org_id
          AND memberships.user_id = shares.owner_user_id
          AND memberships.status = 'accepted'
         WHERE shares.org_id = $1 AND connections.status = 'connected'
           AND connections.user_id = shares.owner_user_id
         ORDER BY shares.created_at, connections.id",
    )
    .bind(org_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(rows)
}

async fn agents_for_org(
    state: &AppState,
    org_id: Uuid,
) -> Result<Vec<OrganizationAgent>, ApiError> {
    Ok(agent_rows_for_org(state, org_id)
        .await?
        .into_iter()
        .map(OrganizationAgent::from)
        .collect())
}

async fn agent_for_org(
    state: &AppState,
    org_id: Uuid,
    connection_id: Uuid,
) -> Result<Option<OrganizationAgent>, ApiError> {
    let row = sqlx::query_as::<_, AgentRow>(
        "SELECT connections.id, connections.provider, connections.account_label,
                users.username AS owner_username, connections.availability_status,
                connections.rate_limited_until, shares.created_at, connections.plan
         FROM organization_agents AS shares
         JOIN agent_connections AS connections ON connections.id = shares.connection_id
         JOIN users ON users.id = shares.owner_user_id
         WHERE shares.org_id = $1 AND shares.connection_id = $2",
    )
    .bind(org_id)
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?;
    Ok(row.map(OrganizationAgent::from))
}

async fn usage_totals(
    state: &AppState,
    org_id: Uuid,
    period: &Period,
    member_id: Option<Uuid>,
    connection_id: Option<Uuid>,
    model: Option<&str>,
) -> Result<UsageTotals, ApiError> {
    sqlx::query_as::<_, UsageTotals>(
        "SELECT COUNT(*) AS requests,
                COALESCE(SUM(input_tokens), 0)::bigint AS known_input_tokens,
                COALESCE(SUM(output_tokens), 0)::bigint AS known_output_tokens,
                COALESCE(SUM(cached_tokens), 0)::bigint AS known_cached_tokens,
                COUNT(*) FILTER (WHERE input_tokens IS NOT NULL
                                 AND output_tokens IS NOT NULL) AS token_known_requests
         FROM organization_usage_events
         WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
           AND ($4::uuid IS NULL OR user_id = $4)
           AND ($5::uuid IS NULL OR connection_id = $5)
           AND ($6::text IS NULL OR model = $6)",
    )
    .bind(org_id)
    .bind(period.start)
    .bind(period.end)
    .bind(member_id)
    .bind(connection_id)
    .bind(model)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)
}

async fn usage_days(
    state: &AppState,
    org_id: Uuid,
    period: &Period,
    member_id: Option<Uuid>,
    connection_id: Option<Uuid>,
    model: Option<&str>,
) -> Result<Vec<OrganizationUsageDay>, ApiError> {
    let rows = sqlx::query_as::<_, UsageDayRow>(
        "SELECT (created_at AT TIME ZONE 'UTC')::date AS date, COUNT(*) AS requests,
                (COALESCE(SUM(input_tokens), 0) + COALESCE(SUM(output_tokens), 0))::bigint
                    AS known_total_tokens,
                COUNT(*) FILTER (WHERE input_tokens IS NOT NULL
                                 AND output_tokens IS NOT NULL) AS token_known_requests
         FROM organization_usage_events
         WHERE org_id = $1 AND created_at >= $2 AND created_at < $3
           AND ($4::uuid IS NULL OR user_id = $4)
           AND ($5::uuid IS NULL OR connection_id = $5)
           AND ($6::text IS NULL OR model = $6)
         GROUP BY (created_at AT TIME ZONE 'UTC')::date
         ORDER BY date",
    )
    .bind(org_id)
    .bind(period.start)
    .bind(period.end)
    .bind(member_id)
    .bind(connection_id)
    .bind(model)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;
    let mut rows = rows.into_iter().peekable();
    let mut days = Vec::with_capacity(period.days as usize);
    for offset in 0..period.days {
        let date = period.first_day + Duration::days(offset);
        let (requests, known_total_tokens, token_known_requests) =
            if rows.peek().is_some_and(|row| row.date == date) {
                let row = rows.next().ok_or(ApiError::Internal)?;
                (
                    row.requests,
                    row.known_total_tokens,
                    row.token_known_requests,
                )
            } else {
                (0, 0, 0)
            };
        days.push(OrganizationUsageDay {
            date: date.to_string(),
            requests,
            known_total_tokens,
            token_known_requests,
        });
    }
    Ok(days)
}

fn period(days: Option<i64>) -> Result<Period, ApiError> {
    let days = days.unwrap_or(DEFAULT_PERIOD_DAYS);
    if !(1..=MAX_PERIOD_DAYS).contains(&days) {
        return Err(ApiError::Validation("days must be between 1 and 365."));
    }
    let today = Utc::now().date_naive();
    let first_day = today - Duration::days(days - 1);
    let start = first_day.and_hms_opt(0, 0, 0).ok_or(ApiError::Internal)?;
    let end = (today + Duration::days(1))
        .and_hms_opt(0, 0, 0)
        .ok_or(ApiError::Internal)?;
    Ok(Period {
        days,
        start: DateTime::from_naive_utc_and_offset(start, Utc),
        end: DateTime::from_naive_utc_and_offset(end, Utc),
        first_day,
    })
}

fn is_unique_violation(error: &sqlx::Error) -> bool {
    error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("organization database operation failed: {error}");
    ApiError::Internal
}

impl From<OrganizationRow> for Organization {
    fn from(row: OrganizationRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            description: row.description,
            role: row.role,
            created_at: row.created_at,
        }
    }
}

impl From<InvitationRow> for OrganizationInvitation {
    fn from(row: InvitationRow) -> Self {
        Self {
            id: row.id,
            organization_id: row.organization_id,
            organization_name: row.organization_name,
            invited_by_username: row.invited_by_username,
            created_at: row.created_at,
        }
    }
}

impl From<AgentRow> for OrganizationAgent {
    fn from(row: AgentRow) -> Self {
        Self {
            id: row.id,
            provider: row.provider,
            account_label: row.account_label,
            owner_username: row.owner_username,
            availability_status: row.availability_status,
            rate_limited_until: row.rate_limited_until,
            created_at: row.created_at,
        }
    }
}

impl From<MemberRow> for OrganizationMember {
    fn from(row: MemberRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            role: row.role,
            status: row.status,
            joined_at: row.joined_at,
            invited_at: row.invited_at,
            invited_by_username: row.invited_by_username,
        }
    }
}

impl From<UsageBreakdownRow> for OrganizationUsageBreakdown {
    fn from(row: UsageBreakdownRow) -> Self {
        Self {
            member_id: row.member_id,
            username: row.username,
            connection_id: row.connection_id,
            provider: row.provider,
            model: row.model,
            requests: row.requests,
            known_input_tokens: row.known_input_tokens,
            known_output_tokens: row.known_output_tokens,
            known_cached_tokens: row.known_cached_tokens,
            token_known_requests: row.token_known_requests,
        }
    }
}

#[cfg(all(test, feature = "database-tests"))]
mod database_tests;
