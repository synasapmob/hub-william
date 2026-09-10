use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use utoipa::ToSchema;
use uuid::Uuid;

use crate::{
    AppState,
    auth::{authenticated_user_id, normalize_username, optional_authenticated_user_id},
    error::ApiError,
};

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentPoolPerson {
    pub avatar_label: String,
    pub username: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentPoolUsageMetric {
    pub detail: Option<String>,
    pub label: String,
    pub value: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentPoolJoinRequest {
    pub avatar_label: String,
    pub id: Uuid,
    pub reason: String,
    pub status: AgentPoolRequestStatus,
    pub telegram: String,
    pub username: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentPoolRequestStatus {
    Pending,
    Accepted,
    Rejected,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentPoolAvailabilityStatus {
    Active,
    RateLimited,
    HalfOpen,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentPoolAvailability {
    pub retry_at: Option<DateTime<Utc>>,
    pub status: AgentPoolAvailabilityStatus,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct AgentPool {
    pub account_label: String,
    pub agent: String,
    pub availability: AgentPoolAvailability,
    pub capacity: i32,
    pub created_at: DateTime<Utc>,
    pub id: Uuid,
    pub members: Vec<AgentPoolPerson>,
    pub owner: AgentPoolPerson,
    pub plan: String,
    pub requests: Vec<AgentPoolJoinRequest>,
    pub usage: Vec<AgentPoolUsageMetric>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateAgentPoolJoinRequest {
    pub reason: String,
    pub telegram: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DecideAgentPoolJoinRequest {
    pub status: AgentPoolRequestStatus,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct InviteAgentPoolMember {
    pub username: String,
}

#[derive(FromRow)]
struct PoolRow {
    account_label: Option<String>,
    availability_status: String,
    capacity: i32,
    created_at: DateTime<Utc>,
    id: Uuid,
    owner_id: Uuid,
    owner_username: String,
    plan: Option<String>,
    provider: String,
    rate_limited_until: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
struct RequestRow {
    id: Uuid,
    reason: String,
    status: String,
    telegram: String,
    username: String,
}

#[utoipa::path(
    get,
    path = "/agent-pools",
    responses((status = 200, description = "Connected account pools", body = [AgentPool])),
    tag = "agent pools"
)]
pub async fn list(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<Vec<AgentPool>>, ApiError> {
    let viewer_id = optional_authenticated_user_id(&state, &jar).await?;
    let rows = sqlx::query_as::<_, PoolRow>(
        "SELECT connections.id, connections.user_id AS owner_id, users.username AS owner_username,
                connections.provider, connections.account_label, connections.plan,
                connections.availability_status, connections.rate_limited_until,
                connections.capacity, connections.created_at
         FROM agent_connections AS connections
         JOIN users ON users.id = connections.user_id
         WHERE connections.status = 'connected'
         ORDER BY connections.created_at DESC",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    let mut pools = Vec::with_capacity(rows.len());
    for row in rows {
        let accepted_usernames = sqlx::query_scalar::<_, String>(
            "SELECT users.username
             FROM agent_pool_join_requests AS requests
             JOIN users ON users.id = requests.requester_user_id
             WHERE requests.connection_id = $1 AND requests.status = 'accepted'
             ORDER BY requests.updated_at",
        )
        .bind(row.id)
        .fetch_all(&state.pool)
        .await
        .map_err(database_error)?;
        let mut members = vec![person(&row.owner_username)];
        members.extend(accepted_usernames.iter().map(|username| person(username)));

        let request_rows = match viewer_id {
            Some(viewer_id) if viewer_id == row.owner_id => {
                request_rows(&state, row.id, None).await?
            }
            Some(viewer_id) => request_rows(&state, row.id, Some(viewer_id)).await?,
            None => Vec::new(),
        };
        let requests = request_rows
            .into_iter()
            .map(request_from_row)
            .collect::<Result<Vec<_>, _>>()?;

        pools.push(AgentPool {
            account_label: row
                .account_label
                .unwrap_or_else(|| "connected account".to_owned()),
            agent: provider_label(&row.provider)?.to_owned(),
            availability: availability_from_values(
                &row.availability_status,
                row.rate_limited_until,
            )?,
            capacity: row.capacity,
            created_at: row.created_at,
            id: row.id,
            members,
            owner: person(&row.owner_username),
            plan: row.plan.unwrap_or_else(|| "Unknown".to_owned()),
            requests,
            usage: Vec::new(),
        });
    }

    Ok(Json(pools))
}

#[utoipa::path(
    post,
    path = "/agent-pools/{connection_id}/members",
    params(("connection_id" = Uuid, Path, description = "Connected account identifier")),
    request_body = InviteAgentPoolMember,
    responses(
        (status = 201, description = "Member invited", body = AgentPoolPerson),
        (status = 403, description = "Pool ownership required", body = crate::ErrorResponse),
        (status = 422, description = "Invite rejected", body = crate::ErrorResponse)
    ),
    tag = "agent pools"
)]
pub async fn invite_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
    Json(payload): Json<InviteAgentPoolMember>,
) -> Result<(StatusCode, Json<AgentPoolPerson>), ApiError> {
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let username = normalize_username(&payload.username)?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let pool = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT user_id, capacity FROM agent_connections
         WHERE id = $1 AND status = 'connected' FOR UPDATE",
    )
    .bind(connection_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if pool.0 != owner_id {
        return Err(ApiError::Forbidden);
    }
    let member_id = sqlx::query_scalar::<_, Uuid>("SELECT id FROM users WHERE username = $1")
        .bind(&username)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(database_error)?
        .ok_or(ApiError::NotFound)?;
    if member_id == owner_id {
        return Err(ApiError::Validation("You already own this account pool."));
    }
    let existing_status = sqlx::query_scalar::<_, String>(
        "SELECT status FROM agent_pool_join_requests
         WHERE connection_id = $1 AND requester_user_id = $2",
    )
    .bind(connection_id)
    .bind(member_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?;
    if existing_status.as_deref() == Some("accepted") {
        return Err(ApiError::Validation("That user is already a member."));
    }
    ensure_pool_capacity(&mut transaction, connection_id, pool.1).await?;
    sqlx::query(
        "INSERT INTO agent_pool_join_requests
            (id, connection_id, requester_user_id, telegram, reason, status)
         VALUES ($1, $2, $3, '', 'Invited by pool owner.', 'accepted')
         ON CONFLICT (connection_id, requester_user_id) DO UPDATE
         SET status = 'accepted', updated_at = NOW()",
    )
    .bind(Uuid::new_v4())
    .bind(connection_id)
    .bind(member_id)
    .execute(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;

    Ok((StatusCode::CREATED, Json(person(&username))))
}

#[utoipa::path(
    delete,
    path = "/agent-pools/{connection_id}/members/{username}",
    params(
        ("connection_id" = Uuid, Path, description = "Connected account identifier"),
        ("username" = String, Path, description = "Hub William username")
    ),
    responses(
        (status = 204, description = "Member removed"),
        (status = 403, description = "Pool ownership required", body = crate::ErrorResponse),
        (status = 404, description = "Membership not found", body = crate::ErrorResponse)
    ),
    tag = "agent pools"
)]
pub async fn remove_member(
    State(state): State<AppState>,
    jar: CookieJar,
    Path((connection_id, username)): Path<(Uuid, String)>,
) -> Result<StatusCode, ApiError> {
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let username = normalize_username(&username)?;
    let owns_pool = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM agent_connections
         WHERE id = $1 AND user_id = $2 AND status = 'connected')",
    )
    .bind(connection_id)
    .bind(owner_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    if !owns_pool {
        return Err(ApiError::Forbidden);
    }
    let result = sqlx::query(
        "DELETE FROM agent_pool_join_requests AS requests
         USING users
         WHERE requests.connection_id = $1
           AND requests.requester_user_id = users.id
           AND users.username = $2
           AND requests.status = 'accepted'",
    )
    .bind(connection_id)
    .bind(username)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;
    if result.rows_affected() == 0 {
        return Err(ApiError::NotFound);
    }
    Ok(StatusCode::NO_CONTENT)
}

#[utoipa::path(
    post,
    path = "/agent-pools/{connection_id}/retry",
    params(("connection_id" = Uuid, Path, description = "Connected account identifier")),
    responses(
        (status = 200, description = "Pool armed for the next real gateway request", body = AgentPoolAvailability),
        (status = 403, description = "Pool ownership required", body = crate::ErrorResponse)
    ),
    tag = "agent pools"
)]
pub async fn retry_pool(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
) -> Result<Json<AgentPoolAvailability>, ApiError> {
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let values = sqlx::query_as::<_, (String, Option<DateTime<Utc>>)>(
        "UPDATE agent_connections
         SET availability_status = CASE
               WHEN availability_status = 'active' THEN 'active'
               ELSE 'half_open'
             END,
             rate_limited_until = CASE
               WHEN availability_status = 'active' THEN rate_limited_until
               ELSE NULL
             END,
             retry_claimed_at = CASE
               WHEN availability_status = 'rate_limited' THEN NULL
               ELSE retry_claimed_at
             END,
             updated_at = NOW()
         WHERE id = $1 AND user_id = $2 AND status = 'connected'
         RETURNING availability_status, rate_limited_until",
    )
    .bind(connection_id)
    .bind(owner_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::Forbidden)?;
    Ok(Json(availability_from_values(&values.0, values.1)?))
}

#[utoipa::path(
    post,
    path = "/agent-pools/{connection_id}/requests",
    params(("connection_id" = Uuid, Path, description = "Connected account identifier")),
    request_body = CreateAgentPoolJoinRequest,
    responses(
        (status = 201, description = "Join request created", body = AgentPoolJoinRequest),
        (status = 401, description = "Login required", body = crate::ErrorResponse),
        (status = 422, description = "Request rejected", body = crate::ErrorResponse)
    ),
    tag = "agent pools"
)]
pub async fn create_request(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(connection_id): Path<Uuid>,
    Json(payload): Json<CreateAgentPoolJoinRequest>,
) -> Result<(StatusCode, Json<AgentPoolJoinRequest>), ApiError> {
    let requester_id = authenticated_user_id(&state, &jar).await?;
    let telegram = normalize_telegram(&payload.telegram)?;
    let reason = normalize_reason(&payload.reason)?;
    let pool = sqlx::query_as::<_, (Uuid, i32)>(
        "SELECT user_id, capacity FROM agent_connections WHERE id = $1 AND status = 'connected'",
    )
    .bind(connection_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if pool.0 == requester_id {
        return Err(ApiError::Validation("You already own this account pool."));
    }
    let accepted = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_pool_join_requests WHERE connection_id = $1 AND status = 'accepted'",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .map_err(database_error)?;
    if accepted + 1 >= i64::from(pool.1) {
        return Err(ApiError::Validation("This account pool is full."));
    }

    let id = Uuid::new_v4();
    let inserted = sqlx::query_as::<_, RequestRow>(
        "INSERT INTO agent_pool_join_requests
            (id, connection_id, requester_user_id, telegram, reason)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, reason, status, telegram,
             (SELECT username FROM users WHERE id = requester_user_id) AS username",
    )
    .bind(id)
    .bind(connection_id)
    .bind(requester_id)
    .bind(telegram)
    .bind(reason)
    .fetch_one(&state.pool)
    .await
    .map_err(|error| {
        if error
            .as_database_error()
            .and_then(|item| item.code())
            .as_deref()
            == Some("23505")
        {
            ApiError::Validation("You already requested to join this account pool.")
        } else {
            database_error(error)
        }
    })?;

    Ok((StatusCode::CREATED, Json(request_from_row(inserted)?)))
}

#[utoipa::path(
    post,
    path = "/agent-pool-requests/{request_id}/decision",
    params(("request_id" = Uuid, Path, description = "Join request identifier")),
    request_body = DecideAgentPoolJoinRequest,
    responses(
        (status = 200, description = "Join request decided", body = AgentPoolJoinRequest),
        (status = 403, description = "Pool ownership required", body = crate::ErrorResponse)
    ),
    tag = "agent pools"
)]
pub async fn decide_request(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(request_id): Path<Uuid>,
    Json(payload): Json<DecideAgentPoolJoinRequest>,
) -> Result<Json<AgentPoolJoinRequest>, ApiError> {
    if matches!(payload.status, AgentPoolRequestStatus::Pending) {
        return Err(ApiError::Validation("Choose accepted or rejected."));
    }
    let owner_id = authenticated_user_id(&state, &jar).await?;
    let mut transaction = state.pool.begin().await.map_err(database_error)?;
    let pool = sqlx::query_as::<_, (Uuid, Uuid, i32)>(
        "SELECT connections.id, connections.user_id, connections.capacity
         FROM agent_pool_join_requests AS requests
         JOIN agent_connections AS connections ON connections.id = requests.connection_id
         WHERE requests.id = $1 AND connections.status = 'connected'
         FOR UPDATE OF connections",
    )
    .bind(request_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(database_error)?
    .ok_or(ApiError::NotFound)?;
    if pool.1 != owner_id {
        return Err(ApiError::Forbidden);
    }
    if matches!(payload.status, AgentPoolRequestStatus::Accepted) {
        ensure_pool_capacity(&mut transaction, pool.0, pool.2).await?;
    }
    let status = status_value(payload.status);
    let row = sqlx::query_as::<_, RequestRow>(
        "UPDATE agent_pool_join_requests AS requests
         SET status = $2, updated_at = NOW()
         FROM users
         WHERE requests.id = $1 AND users.id = requests.requester_user_id
         RETURNING requests.id, requests.reason, requests.status, requests.telegram, users.username",
    )
    .bind(request_id)
    .bind(status)
    .fetch_one(&mut *transaction)
    .await
    .map_err(database_error)?;
    transaction.commit().await.map_err(database_error)?;
    Ok(Json(request_from_row(row)?))
}

async fn ensure_pool_capacity(
    transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    connection_id: Uuid,
    capacity: i32,
) -> Result<(), ApiError> {
    let accepted = sqlx::query_scalar::<_, i64>(
        "SELECT COUNT(*) FROM agent_pool_join_requests
         WHERE connection_id = $1 AND status = 'accepted'",
    )
    .bind(connection_id)
    .fetch_one(&mut **transaction)
    .await
    .map_err(database_error)?;
    if accepted + 1 >= i64::from(capacity) {
        return Err(ApiError::Validation("This account pool is full."));
    }
    Ok(())
}

fn availability_from_values(
    status: &str,
    retry_at: Option<DateTime<Utc>>,
) -> Result<AgentPoolAvailability, ApiError> {
    let status = match status {
        "active" => AgentPoolAvailabilityStatus::Active,
        "rate_limited" => AgentPoolAvailabilityStatus::RateLimited,
        "half_open" => AgentPoolAvailabilityStatus::HalfOpen,
        _ => return Err(ApiError::Internal),
    };
    Ok(AgentPoolAvailability { retry_at, status })
}

async fn request_rows(
    state: &AppState,
    connection_id: Uuid,
    requester_id: Option<Uuid>,
) -> Result<Vec<RequestRow>, ApiError> {
    sqlx::query_as::<_, RequestRow>(
        "SELECT requests.id, requests.reason, requests.status, requests.telegram, users.username
         FROM agent_pool_join_requests AS requests
         JOIN users ON users.id = requests.requester_user_id
         WHERE requests.connection_id = $1 AND ($2::uuid IS NULL OR requests.requester_user_id = $2)
         ORDER BY requests.created_at",
    )
    .bind(connection_id)
    .bind(requester_id)
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)
}

fn request_from_row(row: RequestRow) -> Result<AgentPoolJoinRequest, ApiError> {
    Ok(AgentPoolJoinRequest {
        avatar_label: avatar_label(&row.username),
        id: row.id,
        reason: row.reason,
        status: match row.status.as_str() {
            "pending" => AgentPoolRequestStatus::Pending,
            "accepted" => AgentPoolRequestStatus::Accepted,
            "rejected" => AgentPoolRequestStatus::Rejected,
            _ => return Err(ApiError::Internal),
        },
        telegram: row.telegram,
        username: row.username,
    })
}

fn person(username: &str) -> AgentPoolPerson {
    AgentPoolPerson {
        avatar_label: avatar_label(username),
        username: username.to_owned(),
    }
}

fn avatar_label(username: &str) -> String {
    let mut label = username.chars().take(3).collect::<String>();
    if let Some(first) = label.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    label
}

fn normalize_telegram(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if !(2..=80).contains(&value.len()) {
        return Err(ApiError::Validation("Enter a Telegram username."));
    }
    Ok(value.to_owned())
}

fn normalize_reason(value: &str) -> Result<String, ApiError> {
    let value = value.trim();
    if !(10..=500).contains(&value.len()) {
        return Err(ApiError::Validation(
            "Reason must be between 10 and 500 characters.",
        ));
    }
    Ok(value.to_owned())
}

fn provider_label(provider: &str) -> Result<&'static str, ApiError> {
    match provider {
        "chatgpt" => Ok("ChatGPT"),
        "claude" => Ok("Claude"),
        "grok" => Ok("Grok"),
        _ => Err(ApiError::Internal),
    }
}

fn status_value(status: AgentPoolRequestStatus) -> &'static str {
    match status {
        AgentPoolRequestStatus::Pending => "pending",
        AgentPoolRequestStatus::Accepted => "accepted",
        AgentPoolRequestStatus::Rejected => "rejected",
    }
}

fn database_error(error: sqlx::Error) -> ApiError {
    eprintln!("agent pool database operation failed: {error}");
    ApiError::Internal
}
