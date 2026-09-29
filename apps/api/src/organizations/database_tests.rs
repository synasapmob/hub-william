use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use axum::{
    Json, Router,
    body::Bytes,
    extract::Path,
    http::{HeaderMap, StatusCode, header::AUTHORIZATION},
    response::Response,
    routing::{get, post},
};
use axum_extra::extract::{CookieJar, cookie::Cookie};
use chrono::{DateTime, Utc};
use rand::RngCore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool};
use tokio::net::TcpListener;
use uuid::Uuid;

use super::{
    CreateOrganization, InviteOrganizationMember, OrganizationAgentDetails,
    OrganizationAgentListQuery, OrganizationPeriodQuery, OrganizationUsageQuery,
    ShareOrganizationAgent, accept_invitation, create_organization, delete_organization,
    invite_member, leave_organization, list_agents, list_invitations, list_members,
    list_organization_summaries, list_organizations, overview, remove_member,
    set_default_organization, share_agent, unshare_agent, usage,
};
use crate::{
    AgentConnection, AgentConnectionStatus, AgentProvider, AppConfig, AppState,
    ConnectDeepseekRequest,
    connections::{
        CredentialLookup, PROVIDER_LOGIN_REQUIRED_MESSAGE, gateway_credential,
        mark_reauthorization_required_if_current,
    },
    error::ApiError,
    gateway::{SERVED_CONNECTION_HEADER, response_for_organization_user, response_for_user},
};
use axum::extract::{Query, State};

struct TestUser {
    id: Uuid,
    username: String,
    jar: CookieJar,
}

async fn test_user(pool: &PgPool) -> TestUser {
    let id = Uuid::new_v4();
    let username = id.simple().to_string();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(&username)
        .execute(pool)
        .await
        .unwrap();
    let token = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at)
         VALUES ($1, $2, $3, NOW() + INTERVAL '1 hour')",
    )
    .bind(Uuid::new_v4())
    .bind(id)
    .bind(format!("{:x}", Sha256::digest(token.as_bytes())))
    .execute(pool)
    .await
    .unwrap();
    TestUser {
        id,
        username,
        jar: CookieJar::new().add(Cookie::new("hub_session", token)),
    }
}

fn state(pool: PgPool) -> AppState {
    AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    }
}

#[sqlx::test]
async fn existing_accounts_share_without_reauthorizing_and_keep_status_for_every_provider(
    pool: PgPool,
) {
    let state = state(pool);
    let owner = test_user(&state.pool).await;
    let (_, Json(org)) = create_organization(
        State(state.clone()),
        owner.jar.clone(),
        Json(CreateOrganization {
            name: "All providers".to_owned(),
            description: None,
        }),
    )
    .await
    .unwrap();
    for provider in ["chatgpt", "claude", "gemini", "grok", "deepseek"] {
        for availability in ["active", "reauth_required", "rate_limited", "half_open"] {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO agent_connections (id, user_id, provider, status, availability_status)
                 VALUES ($1, $2, $3, 'connected', $4)",
            )
            .bind(id)
            .bind(owner.id)
            .bind(provider)
            .bind(availability)
            .execute(&state.pool)
            .await
            .unwrap();
            // Sharing must not read, rotate or replace provider credentials.
            sqlx::query(
                "INSERT INTO agent_connection_credentials (connection_id, credential_ciphertext, credential_nonce)
                 VALUES ($1, decode('010203', 'hex'), decode('000000000000000000000000', 'hex'))",
            ).bind(id).execute(&state.pool).await.unwrap();
            let (_, Json(shared)) = share_agent(
                State(state.clone()),
                owner.jar.clone(),
                Path(org.id),
                Json(ShareOrganizationAgent { connection_id: id }),
            )
            .await
            .unwrap();
            assert_eq!(shared.id, id);
            assert_eq!(shared.availability_status, availability);
            let Json(connections) =
                crate::connections::list_connections(State(state.clone()), owner.jar.clone())
                    .await
                    .unwrap();
            let workspace = connections.iter().find(|row| row.id == id).unwrap();
            assert_eq!(workspace.availability_status, availability);
            let (status, ciphertext, authorizations): (String, Vec<u8>, i64) = sqlx::query_as(
                "SELECT c.status, cr.credential_ciphertext,
                    (SELECT count(*) FROM agent_connection_authorizations WHERE connection_id = c.id)
                 FROM agent_connections c JOIN agent_connection_credentials cr ON cr.connection_id = c.id
                 WHERE c.id = $1",
            ).bind(id).fetch_one(&state.pool).await.unwrap();
            assert_eq!(status, "connected");
            assert_eq!(ciphertext, [1, 2, 3]);
            assert_eq!(authorizations, 0);
        }
    }
    let Json(shared) = list_agents(
        State(state.clone()),
        owner.jar,
        Path(org.id),
        Query(OrganizationAgentListQuery {
            include_usage: Some(false),
        }),
    )
    .await
    .unwrap();
    assert_eq!(shared.len(), 20);
}

#[sqlx::test]
async fn invitation_sharing_and_usage_obey_organization_boundary(pool: PgPool) {
    let state = state(pool);
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;
    let connection_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label, plan)
         VALUES ($1, $2, 'deepseek', 'connected', 'tes**@**.com', 'API')",
    )
    .bind(connection_id)
    .bind(owner.id)
    .execute(&state.pool)
    .await
    .unwrap();

    let (_, Json(org)) = create_organization(
        State(state.clone()),
        owner.jar.clone(),
        Json(CreateOrganization {
            name: " Team May ".to_owned(),
            description: None,
        }),
    )
    .await
    .unwrap();
    assert_eq!(org.name, "Team May");
    assert_eq!(org.description, None);
    let (_, Json(other_org)) = create_organization(
        State(state.clone()),
        owner.jar.clone(),
        Json(CreateOrganization {
            name: "Other team".to_owned(),
            description: None,
        }),
    )
    .await
    .unwrap();

    let (_, Json(invited)) = invite_member(
        State(state.clone()),
        owner.jar.clone(),
        Path(org.id),
        Json(InviteOrganizationMember {
            username: member.username.clone(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(invited.status, "pending");
    assert!(matches!(
        list_agents(
            State(state.clone()),
            member.jar.clone(),
            Path(org.id),
            Query(OrganizationAgentListQuery {
                include_usage: None
            }),
        )
        .await,
        Err(ApiError::Forbidden)
    ));
    assert!(matches!(
        share_agent(
            State(state.clone()),
            member.jar.clone(),
            Path(org.id),
            Json(ShareOrganizationAgent { connection_id }),
        )
        .await,
        Err(ApiError::Forbidden)
    ));
    let Json(invitations) = list_invitations(State(state.clone()), member.jar.clone())
        .await
        .unwrap();
    assert_eq!(invitations.len(), 1);
    let Json(accepted) = accept_invitation(
        State(state.clone()),
        member.jar.clone(),
        Path(invitations[0].id),
    )
    .await
    .unwrap();
    assert_eq!(accepted.id, org.id);

    assert!(matches!(
        share_agent(
            State(state.clone()),
            member.jar.clone(),
            Path(org.id),
            Json(ShareOrganizationAgent { connection_id }),
        )
        .await,
        Err(ApiError::Forbidden)
    ));
    let (status, _) = share_agent(
        State(state.clone()),
        owner.jar.clone(),
        Path(org.id),
        Json(ShareOrganizationAgent { connection_id }),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED);
    share_agent(
        State(state.clone()),
        owner.jar.clone(),
        Path(other_org.id),
        Json(ShareOrganizationAgent { connection_id }),
    )
    .await
    .unwrap();
    let Json(agents_without_usage) = list_agents(
        State(state.clone()),
        member.jar.clone(),
        Path(org.id),
        Query(OrganizationAgentListQuery {
            include_usage: None,
        }),
    )
    .await
    .unwrap();
    assert!(agents_without_usage[0].usage.is_empty());
    let Json(agents) = list_agents(
        State(state.clone()),
        member.jar.clone(),
        Path(org.id),
        Query(OrganizationAgentListQuery {
            include_usage: Some(true),
        }),
    )
    .await
    .unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, connection_id);
    assert_eq!(agents[0].plan, "API");
    assert!(agents[0].usage.is_empty());
    assert!(matches!(
        list_agents(
            State(state.clone()),
            outsider.jar.clone(),
            Path(org.id),
            Query(OrganizationAgentListQuery {
                include_usage: None
            }),
        )
        .await,
        Err(ApiError::Forbidden)
    ));
    let Json(members) = list_members(State(state.clone()), member.jar.clone(), Path(org.id))
        .await
        .unwrap();
    assert_eq!(members.len(), 2);
    assert!(
        members
            .iter()
            .any(|listed| listed.id == member.id && listed.status == "accepted")
    );

    sqlx::query(
        "INSERT INTO organization_usage_events
            (id, org_id, user_id, connection_id, provider, model,
             input_tokens, output_tokens, cached_tokens)
         VALUES ($1, $2, $3, $4, 'deepseek', 'deepseek-chat', 10, 5, 3),
                ($5, $2, $3, $4, 'deepseek', NULL, NULL, NULL, NULL),
                ($6, $7, $8, $4, 'deepseek', 'deepseek-chat', 100, 50, 0)",
    )
    .bind(Uuid::new_v4())
    .bind(org.id)
    .bind(member.id)
    .bind(connection_id)
    .bind(Uuid::new_v4())
    .bind(Uuid::new_v4())
    .bind(other_org.id)
    .bind(owner.id)
    .execute(&state.pool)
    .await
    .unwrap();
    let Json(summary) = overview(
        State(state.clone()),
        member.jar.clone(),
        Path(org.id),
        Query(OrganizationPeriodQuery { days: Some(1) }),
    )
    .await
    .unwrap();
    assert_eq!(summary.member_count, 2);
    assert_eq!(summary.agent_count, 1);
    assert_eq!(summary.requests, 2);
    assert_eq!(summary.known_input_tokens, 10);
    assert_eq!(summary.known_output_tokens, 5);
    assert_eq!(summary.token_known_requests, 1);
    assert_eq!(summary.daily_usage[0].known_total_tokens, 15);

    let Json(filtered) = usage(
        State(state.clone()),
        member.jar.clone(),
        Path(org.id),
        Query(OrganizationUsageQuery {
            days: Some(1),
            member_id: Some(member.id),
            connection_id: Some(connection_id),
            model: Some("deepseek-chat".to_owned()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(filtered.requests, 1);
    assert_eq!(filtered.breakdown.len(), 1);
    assert_eq!(filtered.breakdown[0].member_id, member.id);
    assert_eq!(
        filtered.breakdown[0].model.as_deref(),
        Some("deepseek-chat")
    );

    sqlx::query("UPDATE agent_connections SET user_id = $1 WHERE id = $2")
        .bind(outsider.id)
        .bind(connection_id)
        .execute(&state.pool)
        .await
        .unwrap();
    let Json(agents) = list_agents(
        State(state.clone()),
        member.jar,
        Path(org.id),
        Query(OrganizationAgentListQuery {
            include_usage: None,
        }),
    )
    .await
    .unwrap();
    assert!(
        agents.is_empty(),
        "ownership transfer must revoke the old share"
    );
    let retained_connection: Option<Uuid> = sqlx::query_scalar(
        "SELECT connection_id FROM organization_usage_events WHERE org_id = $1 AND model = 'deepseek-chat'",
    )
    .bind(org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(retained_connection, Some(connection_id));
    sqlx::query("DELETE FROM agent_connections WHERE id = $1")
        .bind(connection_id)
        .execute(&state.pool)
        .await
        .unwrap();
    let retained_connection: Option<Uuid> = sqlx::query_scalar(
        "SELECT connection_id FROM organization_usage_events WHERE org_id = $1 AND model = 'deepseek-chat'",
    )
    .bind(org.id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(retained_connection, None);
}

#[sqlx::test]
async fn members_share_own_agents_and_owner_can_remove_them(pool: PgPool) {
    let state = state(pool);
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let peer = test_user(&state.pool).await;
    let connection_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status)
         VALUES ($1, $2, 'deepseek', 'connected')",
    )
    .bind(connection_id)
    .bind(member.id)
    .execute(&state.pool)
    .await
    .unwrap();

    let (_, Json(org)) = create_organization(
        State(state.clone()),
        owner.jar.clone(),
        Json(CreateOrganization {
            name: "Team Mây".to_owned(),
            description: Some("  Shared agents  ".to_owned()),
        }),
    )
    .await
    .unwrap();
    assert_eq!(org.description.as_deref(), Some("Shared agents"));
    assert!(matches!(
        create_organization(
            State(state.clone()),
            owner.jar.clone(),
            Json(CreateOrganization {
                name: "Too long".to_owned(),
                description: Some("a".repeat(351)),
            }),
        )
        .await,
        Err(ApiError::Validation(_))
    ));

    for invitee in [&member, &peer] {
        invite_member(
            State(state.clone()),
            owner.jar.clone(),
            Path(org.id),
            Json(InviteOrganizationMember {
                username: invitee.username.clone(),
            }),
        )
        .await
        .unwrap();
        let Json(invitations) = list_invitations(State(state.clone()), invitee.jar.clone())
            .await
            .unwrap();
        accept_invitation(
            State(state.clone()),
            invitee.jar.clone(),
            Path(invitations[0].id),
        )
        .await
        .unwrap();
    }

    share_agent(
        State(state.clone()),
        member.jar.clone(),
        Path(org.id),
        Json(ShareOrganizationAgent { connection_id }),
    )
    .await
    .unwrap();
    assert!(matches!(
        unshare_agent(
            State(state.clone()),
            peer.jar.clone(),
            Path((org.id, connection_id)),
        )
        .await,
        Err(ApiError::Forbidden)
    ));
    assert_eq!(
        unshare_agent(
            State(state.clone()),
            member.jar.clone(),
            Path((org.id, connection_id)),
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT
    );
    share_agent(
        State(state.clone()),
        member.jar,
        Path(org.id),
        Json(ShareOrganizationAgent { connection_id }),
    )
    .await
    .unwrap();
    assert_eq!(
        unshare_agent(State(state), owner.jar, Path((org.id, connection_id)))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
}

// Organization agents are live links to Workspace connections: one
// `agent_connections` row and one credential serve both places.

const WORKSPACE_KEY: &str = "sk-workspace-linked-000000000001";
const ROTATED_WORKSPACE_KEY: &str = "sk-workspace-rotated-00000000002";
const PEER_KEY: &str = "sk-workspace-peer-0000000000003";

/// A local stand-in for the DeepSeek API, so connecting a Workspace account
/// and gateway generations never leave the machine.
#[derive(Clone, Default)]
struct FakeDeepseek {
    /// The bearer key of every generation request, in arrival order.
    generations: Arc<Mutex<Vec<String>>>,
    /// Generation status per bearer key; any other key receives 200.
    statuses: Arc<Mutex<HashMap<String, StatusCode>>>,
}

impl FakeDeepseek {
    fn respond(&self, api_key: &str, status: StatusCode) {
        self.statuses
            .lock()
            .unwrap()
            .insert(api_key.to_owned(), status);
    }

    fn generations(&self) -> Vec<String> {
        self.generations.lock().unwrap().clone()
    }
}

fn bearer_key(headers: &HeaderMap) -> String {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default()
        .to_owned()
}

async fn fake_deepseek_models() -> Json<Value> {
    Json(json!({ "object": "list", "data": [{ "id": "deepseek-chat", "object": "model" }] }))
}

async fn fake_deepseek_generation(
    State(fake): State<FakeDeepseek>,
    headers: HeaderMap,
) -> (StatusCode, Json<Value>) {
    let api_key = bearer_key(&headers);
    fake.generations.lock().unwrap().push(api_key.clone());
    let status = fake
        .statuses
        .lock()
        .unwrap()
        .get(&api_key)
        .copied()
        .unwrap_or(StatusCode::OK);
    let body = if status.is_success() {
        json!({ "id": "resp_fake", "object": "response", "status": "completed", "output": [] })
    } else {
        json!({ "error": { "message": "fake upstream refusal" } })
    };
    (status, Json(body))
}

async fn state_with_fake_deepseek(pool: PgPool) -> (AppState, FakeDeepseek) {
    let fake = FakeDeepseek::default();
    let app = Router::new()
        .route("/models", get(fake_deepseek_models))
        .route("/responses", post(fake_deepseek_generation))
        .with_state(fake.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let mut state = state(pool);
    state.config.deepseek_api_url = format!("http://{address}");
    (state, fake)
}

/// Create an organization owned by `owner` in which every `members` user has
/// accepted an invitation.
async fn organization_with_members(
    state: &AppState,
    owner: &TestUser,
    name: &str,
    members: &[&TestUser],
) -> Uuid {
    let (_, Json(org)) = create_organization(
        State(state.clone()),
        owner.jar.clone(),
        Json(CreateOrganization {
            name: name.to_owned(),
            description: None,
        }),
    )
    .await
    .unwrap();
    for member in members {
        let (status, _) = invite_member(
            State(state.clone()),
            owner.jar.clone(),
            Path(org.id),
            Json(InviteOrganizationMember {
                username: member.username.clone(),
            }),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        let Json(invitations) = list_invitations(State(state.clone()), member.jar.clone())
            .await
            .unwrap();
        let invitation = invitations
            .iter()
            .find(|invitation| invitation.organization_id == org.id)
            .unwrap();
        let Json(accepted) = accept_invitation(
            State(state.clone()),
            member.jar.clone(),
            Path(invitation.id),
        )
        .await
        .unwrap();
        assert_eq!(accepted.id, org.id);
    }
    org.id
}

/// Connect a DeepSeek account in `user`'s Workspace through the real handler.
async fn connect_workspace_deepseek(state: &AppState, user: &TestUser, api_key: &str) -> Uuid {
    let (status, Json(connection)) = crate::connections::connect_deepseek(
        State(state.clone()),
        user.jar.clone(),
        Json(ConnectDeepseekRequest {
            api_key: api_key.to_owned(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(connection.status, AgentConnectionStatus::Connected);
    connection.id
}

async fn share(
    state: &AppState,
    user: &TestUser,
    org_id: Uuid,
    connection_id: Uuid,
) -> Result<(StatusCode, Json<super::OrganizationAgent>), ApiError> {
    share_agent(
        State(state.clone()),
        user.jar.clone(),
        Path(org_id),
        Json(ShareOrganizationAgent { connection_id }),
    )
    .await
}

/// Share `connection_id` into `org_id` for the first time.
async fn link(state: &AppState, user: &TestUser, org_id: Uuid, connection_id: Uuid) {
    let (status, Json(agent)) = share(state, user, org_id, connection_id).await.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(agent.id, connection_id);
}

async fn organization_agents(
    state: &AppState,
    viewer: &TestUser,
    org_id: Uuid,
) -> Vec<OrganizationAgentDetails> {
    let Json(agents) = list_agents(
        State(state.clone()),
        viewer.jar.clone(),
        Path(org_id),
        Query(OrganizationAgentListQuery {
            include_usage: Some(false),
        }),
    )
    .await
    .unwrap();
    agents
}

async fn workspace_connections(state: &AppState, user: &TestUser) -> Vec<AgentConnection> {
    let Json(connections) =
        crate::connections::list_connections(State(state.clone()), user.jar.clone())
            .await
            .unwrap();
    connections
}

/// A DeepSeek generation through one organization's gateway scope, trying
/// `preferred` first.
async fn organization_generation(
    state: &AppState,
    user: &TestUser,
    org_id: Uuid,
    preferred: Uuid,
) -> Result<Response, ApiError> {
    response_for_organization_user(
        state,
        user.id,
        org_id,
        preferred,
        AgentProvider::Deepseek,
        "deepseek-chat",
        Bytes::from_static(br#"{"model":"deepseek-chat","input":"hi"}"#),
    )
    .await
}

fn served_connection(response: &Response) -> Option<Uuid> {
    response
        .headers()
        .get(SERVED_CONNECTION_HEADER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse().ok())
}

#[derive(Debug, PartialEq, FromRow)]
struct WorkspaceConnectionRow {
    user_id: Uuid,
    status: String,
    availability_status: String,
    rate_limited_until: Option<DateTime<Utc>>,
    failure_message: Option<String>,
    account_label: Option<String>,
    plan: Option<String>,
    updated_at: DateTime<Utc>,
}

#[derive(Debug, PartialEq, FromRow)]
struct StoredCredentialRow {
    credential_ciphertext: Vec<u8>,
    credential_nonce: Vec<u8>,
    updated_at: DateTime<Utc>,
}

async fn workspace_connection_row(
    pool: &PgPool,
    connection_id: Uuid,
) -> Option<WorkspaceConnectionRow> {
    sqlx::query_as(
        "SELECT user_id, status, availability_status, rate_limited_until, failure_message,
                account_label, plan, updated_at
         FROM agent_connections WHERE id = $1",
    )
    .bind(connection_id)
    .fetch_optional(pool)
    .await
    .unwrap()
}

async fn stored_credentials(pool: &PgPool, connection_id: Uuid) -> Vec<StoredCredentialRow> {
    sqlx::query_as(
        "SELECT credential_ciphertext, credential_nonce, updated_at
         FROM agent_connection_credentials WHERE connection_id = $1",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

/// The organizations that currently link `connection_id`, in ID order.
async fn linked_organizations(pool: &PgPool, connection_id: Uuid) -> Vec<Uuid> {
    sqlx::query_scalar(
        "SELECT org_id FROM organization_agents WHERE connection_id = $1 ORDER BY org_id",
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

fn encrypt_credential(state: &AppState, credential: &Value) -> (Vec<u8>, Vec<u8>) {
    let cipher = Aes256Gcm::new_from_slice(&state.config.credential_encryption_key).unwrap();
    let mut nonce = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            serde_json::to_vec(credential).unwrap().as_ref(),
        )
        .unwrap();
    (ciphertext, nonce.to_vec())
}

fn decrypt_credential(state: &AppState, stored: &StoredCredentialRow) -> Vec<u8> {
    Aes256Gcm::new_from_slice(&state.config.credential_encryption_key)
        .unwrap()
        .decrypt(
            Nonce::from_slice(&stored.credential_nonce),
            stored.credential_ciphertext.as_ref(),
        )
        .unwrap()
}

#[sqlx::test]
async fn sharing_a_workspace_connection_links_the_same_row_without_copying_its_credential(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let org_id = organization_with_members(&state, &owner, "Linked agents", &[]).await;
    let connection_id = connect_workspace_deepseek(&state, &owner, WORKSPACE_KEY).await;
    let workspace_before = workspace_connection_row(&state.pool, connection_id)
        .await
        .unwrap();
    let credential_before = stored_credentials(&state.pool, connection_id).await;
    assert_eq!(credential_before.len(), 1);

    let (status, Json(agent)) = share(&state, &owner, org_id, connection_id).await.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(
        agent.id, connection_id,
        "the agent is the Workspace connection"
    );
    assert_eq!(agent.provider, "deepseek");
    assert_eq!(agent.owner_username, owner.username);
    assert_eq!(agent.account_label, workspace_before.account_label);
    assert_eq!(
        agent.availability_status,
        workspace_before.availability_status
    );

    let links: Vec<(Uuid, Uuid, Uuid)> =
        sqlx::query_as("SELECT org_id, connection_id, owner_user_id FROM organization_agents")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(links, vec![(org_id, connection_id, owner.id)]);
    let (connections, credentials): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT COUNT(*) FROM agent_connections),
                (SELECT COUNT(*) FROM agent_connection_credentials)",
    )
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        (connections, credentials),
        (1, 1),
        "sharing must not copy the connection or its credential"
    );
    assert_eq!(
        stored_credentials(&state.pool, connection_id).await,
        credential_before,
        "sharing must not re-encrypt or rewrite the credential"
    );
    assert_eq!(
        workspace_connection_row(&state.pool, connection_id)
            .await
            .unwrap(),
        workspace_before
    );

    let agents = organization_agents(&state, &owner, org_id).await;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, connection_id);
    let workspace = workspace_connections(&state, &owner).await;
    assert_eq!(workspace.len(), 1);
    assert_eq!(workspace[0].id, connection_id);
}

#[sqlx::test]
async fn concurrent_and_repeated_shares_keep_one_link_and_return_the_existing_agent(pool: PgPool) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let org_id = organization_with_members(&state, &owner, "Concurrent links", &[]).await;
    let connection_id = connect_workspace_deepseek(&state, &owner, WORKSPACE_KEY).await;

    let (first, second) = tokio::join!(
        share(&state, &owner, org_id, connection_id),
        share(&state, &owner, org_id, connection_id)
    );
    let (first_status, Json(first)) = first.unwrap();
    let (second_status, Json(second)) = second.unwrap();
    let mut statuses = [first_status, second_status];
    statuses.sort_by_key(StatusCode::as_u16);
    assert_eq!(
        statuses,
        [StatusCode::OK, StatusCode::CREATED],
        "exactly one concurrent share creates the link"
    );
    assert_eq!(first.id, connection_id);
    assert_eq!(second.id, connection_id);
    assert_eq!(first.created_at, second.created_at);
    assert_eq!(
        linked_organizations(&state.pool, connection_id).await,
        vec![org_id]
    );

    let (third_status, Json(third)) = share(&state, &owner, org_id, connection_id).await.unwrap();
    assert_eq!(third_status, StatusCode::OK);
    assert_eq!(third.id, connection_id);
    assert_eq!(third.created_at, first.created_at);
    assert_eq!(
        linked_organizations(&state.pool, connection_id).await,
        vec![org_id]
    );
    assert_eq!(
        stored_credentials(&state.pool, connection_id).await.len(),
        1
    );
    let agents = organization_agents(&state, &owner, org_id).await;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, connection_id);
}

#[sqlx::test]
async fn organization_agent_reports_and_uses_the_live_workspace_state_and_credential(pool: PgPool) {
    let (state, fake) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let org_id = organization_with_members(&state, &owner, "Live links", &[&member]).await;
    let connection_id = connect_workspace_deepseek(&state, &owner, WORKSPACE_KEY).await;
    link(&state, &owner, org_id, connection_id).await;

    let agents = organization_agents(&state, &member, org_id).await;
    let workspace = workspace_connections(&state, &owner).await;
    assert_eq!(agents[0].account_label.as_deref(), Some("••••0001"));
    assert_eq!(agents[0].account_label, workspace[0].account_label);
    assert_eq!(agents[0].availability_status, "active");
    assert_eq!(workspace[0].availability_status, "active");
    assert_eq!(agents[0].plan, "API");

    // A rate limit observed through the organization is the Workspace
    // account's state, and both sides report the same cooldown.
    fake.respond(WORKSPACE_KEY, StatusCode::TOO_MANY_REQUESTS);
    assert!(matches!(
        organization_generation(&state, &member, org_id, connection_id).await,
        Err(ApiError::RateLimited)
    ));
    let row = workspace_connection_row(&state.pool, connection_id)
        .await
        .unwrap();
    assert_eq!(row.availability_status, "rate_limited");
    assert!(row.rate_limited_until.is_some());
    let agents = organization_agents(&state, &member, org_id).await;
    assert_eq!(agents[0].availability_status, "rate_limited");
    assert_eq!(agents[0].rate_limited_until, row.rate_limited_until);
    assert_eq!(
        workspace_connections(&state, &owner).await[0].availability_status,
        "rate_limited"
    );

    // A Workspace account that needs its owner to reconnect is unavailable
    // to the organization too, without contacting the provider.
    assert!(
        mark_reauthorization_required_if_current(
            &state,
            connection_id,
            WORKSPACE_KEY,
            PROVIDER_LOGIN_REQUIRED_MESSAGE,
        )
        .await
        .unwrap()
    );
    let agents = organization_agents(&state, &member, org_id).await;
    assert_eq!(agents[0].availability_status, "reauth_required");
    assert_eq!(agents[0].rate_limited_until, None);
    let workspace = workspace_connections(&state, &owner).await;
    assert_eq!(workspace[0].availability_status, "reauth_required");
    assert_eq!(
        workspace[0].failure_message.as_deref(),
        Some(PROVIDER_LOGIN_REQUIRED_MESSAGE)
    );
    let generations_before = fake.generations().len();
    match organization_generation(&state, &member, org_id, connection_id).await {
        Err(ApiError::Provider(message)) => assert!(
            message.starts_with(
                "Every account for this provider in this organization needs to reconnect."
            ),
            "{message}"
        ),
        other => panic!("expected an organization reconnect error, got {other:?}"),
    }
    assert_eq!(fake.generations().len(), generations_before);

    // The owner reconnects in Workspace with a rotated key and new label.
    let mut rotated: Value = serde_json::from_slice(&decrypt_credential(
        &state,
        &stored_credentials(&state.pool, connection_id).await[0],
    ))
    .unwrap();
    rotated["access_token"] = json!(ROTATED_WORKSPACE_KEY);
    rotated["api_key_last_four"] = json!("0002");
    let (ciphertext, nonce) = encrypt_credential(&state, &rotated);
    sqlx::query(
        "UPDATE agent_connection_credentials
         SET credential_ciphertext = $2, credential_nonce = $3, updated_at = NOW()
         WHERE connection_id = $1",
    )
    .bind(connection_id)
    .bind(&ciphertext)
    .bind(&nonce)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'active', failure_message = NULL,
             account_label = '••••0002', updated_at = NOW()
         WHERE id = $1",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let rotated_credential = stored_credentials(&state.pool, connection_id).await;
    assert_eq!(rotated_credential.len(), 1);
    assert_eq!(rotated_credential[0].credential_ciphertext, ciphertext);

    let agents = organization_agents(&state, &member, org_id).await;
    assert_eq!(agents[0].account_label.as_deref(), Some("••••0002"));
    assert_eq!(agents[0].availability_status, "active");

    // The organization gateway reads exactly the Workspace credential bytes.
    let CredentialLookup::Ready(provider, credential) =
        gateway_credential(&state, connection_id).await.unwrap()
    else {
        panic!("the rotated Workspace credential must be usable");
    };
    assert_eq!(provider, AgentProvider::Deepseek);
    assert_eq!(credential, rotated);
    assert_eq!(
        serde_json::to_vec(&credential).unwrap(),
        decrypt_credential(&state, &rotated_credential[0])
    );

    let response = organization_generation(&state, &member, org_id, connection_id)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(connection_id));
    assert_eq!(
        fake.generations().last().map(String::as_str),
        Some(ROTATED_WORKSPACE_KEY)
    );
    let response = response_for_user(
        &state,
        owner.id,
        connection_id,
        AgentProvider::Deepseek,
        "deepseek-chat",
        Bytes::from_static(br#"{"model":"deepseek-chat","input":"hi"}"#),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(connection_id));
    assert_eq!(
        fake.generations().last().map(String::as_str),
        Some(ROTATED_WORKSPACE_KEY)
    );
    assert_eq!(
        stored_credentials(&state.pool, connection_id).await,
        rotated_credential,
        "serving the organization must not copy or rewrite the credential"
    );
}

#[sqlx::test]
async fn deleting_the_workspace_connection_removes_its_organization_agent_and_gateway_candidate(
    pool: PgPool,
) {
    let (state, fake) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let org_id = organization_with_members(&state, &owner, "Delete root", &[&member]).await;
    let root_id = connect_workspace_deepseek(&state, &owner, WORKSPACE_KEY).await;
    let peer_id = connect_workspace_deepseek(&state, &member, PEER_KEY).await;
    link(&state, &owner, org_id, root_id).await;
    link(&state, &member, org_id, peer_id).await;

    // While linked, the organization fails over from the refused peer account
    // to the Workspace connection.
    fake.respond(PEER_KEY, StatusCode::FORBIDDEN);
    let response = organization_generation(&state, &member, org_id, peer_id)
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(served_connection(&response), Some(root_id));
    assert_eq!(fake.generations(), [PEER_KEY, WORKSPACE_KEY]);

    assert_eq!(
        crate::connections::disconnect(State(state.clone()), owner.jar.clone(), Path(root_id))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(linked_organizations(&state.pool, root_id).await.is_empty());
    assert!(
        workspace_connection_row(&state.pool, root_id)
            .await
            .is_none()
    );
    assert!(stored_credentials(&state.pool, root_id).await.is_empty());
    assert_eq!(
        linked_organizations(&state.pool, peer_id).await,
        vec![org_id]
    );
    let agents = organization_agents(&state, &member, org_id).await;
    assert_eq!(
        agents.iter().map(|agent| agent.id).collect::<Vec<_>>(),
        vec![peer_id]
    );

    assert!(matches!(
        organization_generation(&state, &member, org_id, root_id).await,
        Err(ApiError::Forbidden)
    ));
    let response = organization_generation(&state, &member, org_id, peer_id)
        .await
        .unwrap();
    assert_eq!(
        response.status(),
        StatusCode::FORBIDDEN,
        "with the root deleted, the refused peer is the whole scope"
    );
    assert_eq!(fake.generations(), [PEER_KEY, WORKSPACE_KEY, PEER_KEY]);
}

#[sqlx::test]
async fn removing_an_agent_from_the_organization_keeps_the_workspace_connection_and_credential(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let org_id = organization_with_members(&state, &owner, "Unlink", &[&member]).await;
    let connection_id = connect_workspace_deepseek(&state, &member, WORKSPACE_KEY).await;
    sqlx::query(
        "UPDATE agent_connections
         SET availability_status = 'rate_limited',
             rate_limited_until = NOW() + INTERVAL '20 minutes'
         WHERE id = $1",
    )
    .bind(connection_id)
    .execute(&state.pool)
    .await
    .unwrap();
    let (status, _) = share(&state, &member, org_id, connection_id).await.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    let workspace_before = workspace_connection_row(&state.pool, connection_id)
        .await
        .unwrap();
    let credential_before = stored_credentials(&state.pool, connection_id).await;

    assert_eq!(
        unshare_agent(
            State(state.clone()),
            member.jar.clone(),
            Path((org_id, connection_id)),
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(
        linked_organizations(&state.pool, connection_id)
            .await
            .is_empty()
    );
    assert!(organization_agents(&state, &owner, org_id).await.is_empty());
    assert_eq!(
        workspace_connection_row(&state.pool, connection_id)
            .await
            .unwrap(),
        workspace_before,
        "removing the link must not touch the Workspace connection"
    );
    assert_eq!(
        stored_credentials(&state.pool, connection_id).await,
        credential_before
    );
    let workspace = workspace_connections(&state, &member).await;
    assert_eq!(workspace.len(), 1);
    assert_eq!(workspace[0].id, connection_id);
    assert_eq!(workspace[0].status, AgentConnectionStatus::Connected);
    assert_eq!(workspace[0].availability_status, "rate_limited");

    let (status, Json(agent)) = share(&state, &member, org_id, connection_id).await.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(agent.id, connection_id);
    assert_eq!(agent.availability_status, "rate_limited");
    assert_eq!(
        agent.rate_limited_until,
        workspace_before.rate_limited_until
    );
    let agents = organization_agents(&state, &owner, org_id).await;
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0].id, connection_id);
    assert_eq!(
        stored_credentials(&state.pool, connection_id).await,
        credential_before
    );
}

#[sqlx::test]
async fn removing_a_member_drops_only_their_links_in_that_organization_and_keeps_their_workspace(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let removed_from = organization_with_members(&state, &owner, "Removed from", &[&member]).await;
    let still_in = organization_with_members(&state, &owner, "Still in", &[&member]).await;
    let member_connection = connect_workspace_deepseek(&state, &member, WORKSPACE_KEY).await;
    let owner_connection = connect_workspace_deepseek(&state, &owner, PEER_KEY).await;
    link(&state, &member, removed_from, member_connection).await;
    link(&state, &member, still_in, member_connection).await;
    link(&state, &owner, removed_from, owner_connection).await;
    let workspace_before = workspace_connection_row(&state.pool, member_connection)
        .await
        .unwrap();
    let credential_before = stored_credentials(&state.pool, member_connection).await;

    assert_eq!(
        remove_member(
            State(state.clone()),
            owner.jar.clone(),
            Path((removed_from, member.username.clone())),
        )
        .await
        .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        linked_organizations(&state.pool, member_connection).await,
        vec![still_in],
        "only the link in the organization they left is removed"
    );
    assert_eq!(
        linked_organizations(&state.pool, owner_connection).await,
        vec![removed_from]
    );
    let remaining = organization_agents(&state, &owner, removed_from).await;
    assert_eq!(
        remaining.iter().map(|agent| agent.id).collect::<Vec<_>>(),
        vec![owner_connection]
    );
    let other_org = organization_agents(&state, &member, still_in).await;
    assert_eq!(
        other_org.iter().map(|agent| agent.id).collect::<Vec<_>>(),
        vec![member_connection]
    );
    assert!(matches!(
        organization_generation(&state, &owner, removed_from, member_connection).await,
        Err(ApiError::Forbidden)
    ));

    assert_eq!(
        workspace_connection_row(&state.pool, member_connection)
            .await
            .unwrap(),
        workspace_before,
        "leaving an organization must not touch the Workspace connection"
    );
    assert_eq!(
        stored_credentials(&state.pool, member_connection).await,
        credential_before
    );
    let workspace = workspace_connections(&state, &member).await;
    assert_eq!(workspace.len(), 1);
    assert_eq!(workspace[0].id, member_connection);
    assert_eq!(workspace[0].status, AgentConnectionStatus::Connected);
    assert_eq!(workspace[0].availability_status, "active");
}

async fn membership_rows(pool: &PgPool, org_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM organization_memberships WHERE org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn usage_event_rows(pool: &PgPool, org_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM organization_usage_events WHERE org_id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn organization_rows(pool: &PgPool, org_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(org_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn record_usage(pool: &PgPool, org_id: Uuid, user: &TestUser, connection_id: Uuid) {
    sqlx::query(
        "INSERT INTO organization_usage_events
            (id, org_id, user_id, connection_id, provider, model, input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, 'deepseek', 'deepseek-chat', 10, 5)",
    )
    .bind(Uuid::new_v4())
    .bind(org_id)
    .bind(user.id)
    .bind(connection_id)
    .execute(pool)
    .await
    .unwrap();
}

async fn invite(state: &AppState, owner: &TestUser, org_id: Uuid, invitee: &TestUser) {
    let (status, _) = invite_member(
        State(state.clone()),
        owner.jar.clone(),
        Path(org_id),
        Json(InviteOrganizationMember {
            username: invitee.username.clone(),
        }),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED);
}

async fn organization_summaries(
    state: &AppState,
    viewer: &TestUser,
    days: Option<i64>,
) -> Vec<super::OrganizationSummary> {
    let Json(organizations) = list_organization_summaries(
        State(state.clone()),
        viewer.jar.clone(),
        Query(OrganizationPeriodQuery { days }),
    )
    .await
    .unwrap();
    organizations
}

async fn organization_ids(state: &AppState, viewer: &TestUser) -> Vec<Uuid> {
    let Json(organizations) = list_organizations(State(state.clone()), viewer.jar.clone())
        .await
        .unwrap();
    organizations
        .into_iter()
        .map(|organization| organization.id)
        .collect()
}

/// The organizations the viewer's list marks as their default.
async fn default_ids(state: &AppState, viewer: &TestUser) -> Vec<Uuid> {
    let Json(organizations) = list_organizations(State(state.clone()), viewer.jar.clone())
        .await
        .unwrap();
    organizations
        .into_iter()
        .filter(|organization| organization.is_default)
        .map(|organization| organization.id)
        .collect()
}

async fn default_rows(pool: &PgPool, user: &TestUser) -> i64 {
    sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE user_id = $1 AND is_default",
    )
    .bind(user.id)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn choose_default(
    state: &AppState,
    user: &TestUser,
    org_id: Uuid,
) -> Result<StatusCode, ApiError> {
    set_default_organization(State(state.clone()), user.jar.clone(), Path(org_id)).await
}

#[sqlx::test]
async fn deleting_an_organization_removes_its_members_links_and_usage_but_not_workspaces(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let invitee = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;
    let doomed = organization_with_members(&state, &owner, "Doomed", &[&member]).await;
    let survivor = organization_with_members(&state, &owner, "Survivor", &[&member]).await;
    invite(&state, &owner, doomed, &invitee).await;
    let owner_connection = connect_workspace_deepseek(&state, &owner, PEER_KEY).await;
    let member_connection = connect_workspace_deepseek(&state, &member, WORKSPACE_KEY).await;
    link(&state, &owner, doomed, owner_connection).await;
    link(&state, &member, doomed, member_connection).await;
    link(&state, &member, survivor, member_connection).await;
    record_usage(&state.pool, doomed, &member, member_connection).await;
    record_usage(&state.pool, survivor, &member, member_connection).await;
    let workspace_before = workspace_connection_row(&state.pool, member_connection)
        .await
        .unwrap();
    let credential_before = stored_credentials(&state.pool, member_connection).await;
    assert_eq!(membership_rows(&state.pool, doomed).await, 3);

    for (user, who) in [
        (&member, "a member"),
        (&invitee, "a pending invitee"),
        (&outsider, "someone outside the organization"),
    ] {
        assert!(
            matches!(
                delete_organization(State(state.clone()), user.jar.clone(), Path(doomed)).await,
                Err(ApiError::Forbidden)
            ),
            "{who} must not delete an organization"
        );
    }
    assert_eq!(organization_rows(&state.pool, doomed).await, 1);
    assert_eq!(membership_rows(&state.pool, doomed).await, 3);

    assert_eq!(
        delete_organization(State(state.clone()), owner.jar.clone(), Path(doomed))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(organization_rows(&state.pool, doomed).await, 0);
    assert_eq!(
        membership_rows(&state.pool, doomed).await,
        0,
        "members and the pending invitation leave with the organization"
    );
    assert_eq!(usage_event_rows(&state.pool, doomed).await, 0);
    assert_eq!(
        linked_organizations(&state.pool, member_connection).await,
        vec![survivor],
        "only the deleted organization's links are removed"
    );
    assert!(
        linked_organizations(&state.pool, owner_connection)
            .await
            .is_empty()
    );
    assert_eq!(organization_ids(&state, &owner).await, vec![survivor]);
    assert_eq!(organization_ids(&state, &member).await, vec![survivor]);
    assert!(organization_ids(&state, &invitee).await.is_empty());
    let Json(invitations) = list_invitations(State(state.clone()), invitee.jar.clone())
        .await
        .unwrap();
    assert!(invitations.is_empty());
    assert!(matches!(
        list_members(State(state.clone()), member.jar.clone(), Path(doomed)).await,
        Err(ApiError::Forbidden)
    ));

    assert_eq!(membership_rows(&state.pool, survivor).await, 2);
    assert_eq!(usage_event_rows(&state.pool, survivor).await, 1);
    let survivors = organization_agents(&state, &owner, survivor).await;
    assert_eq!(
        survivors.iter().map(|agent| agent.id).collect::<Vec<_>>(),
        vec![member_connection]
    );
    assert_eq!(
        workspace_connection_row(&state.pool, member_connection)
            .await
            .unwrap(),
        workspace_before,
        "deleting an organization must not touch a Workspace connection"
    );
    assert_eq!(
        stored_credentials(&state.pool, member_connection).await,
        credential_before
    );
    assert_eq!(workspace_connections(&state, &owner).await.len(), 1);
    assert_eq!(workspace_connections(&state, &member).await.len(), 1);

    assert!(
        matches!(
            delete_organization(State(state.clone()), owner.jar.clone(), Path(doomed)).await,
            Err(ApiError::Forbidden)
        ),
        "a deleted organization has no owner left to delete it again"
    );
}

#[sqlx::test]
async fn a_member_leaving_drops_only_their_membership_and_links_and_an_owner_cannot_leave(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let leaver = test_user(&state.pool).await;
    let stayer = test_user(&state.pool).await;
    let invitee = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;
    let left = organization_with_members(&state, &owner, "Left", &[&leaver, &stayer]).await;
    let kept = organization_with_members(&state, &owner, "Kept", &[&leaver]).await;
    invite(&state, &owner, left, &invitee).await;
    let leaver_connection = connect_workspace_deepseek(&state, &leaver, WORKSPACE_KEY).await;
    let stayer_connection = connect_workspace_deepseek(&state, &stayer, PEER_KEY).await;
    link(&state, &leaver, left, leaver_connection).await;
    link(&state, &leaver, kept, leaver_connection).await;
    link(&state, &stayer, left, stayer_connection).await;
    record_usage(&state.pool, left, &leaver, leaver_connection).await;
    let workspace_before = workspace_connection_row(&state.pool, leaver_connection)
        .await
        .unwrap();
    let credential_before = stored_credentials(&state.pool, leaver_connection).await;

    assert!(
        matches!(
            leave_organization(State(state.clone()), owner.jar.clone(), Path(left)).await,
            Err(ApiError::Validation(_))
        ),
        "an owner deletes the organization instead of leaving it"
    );
    for (user, who) in [
        (&invitee, "a pending invitee"),
        (&outsider, "someone outside the organization"),
    ] {
        assert!(
            matches!(
                leave_organization(State(state.clone()), user.jar.clone(), Path(left)).await,
                Err(ApiError::Forbidden)
            ),
            "{who} has no membership to leave"
        );
    }
    assert_eq!(membership_rows(&state.pool, left).await, 4);

    assert_eq!(
        leave_organization(State(state.clone()), leaver.jar.clone(), Path(left))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        membership_rows(&state.pool, left).await,
        3,
        "only the leaving member's membership is removed"
    );
    assert_eq!(organization_ids(&state, &leaver).await, vec![kept]);
    assert_eq!(organization_ids(&state, &owner).await, vec![left, kept]);
    assert_eq!(organization_ids(&state, &stayer).await, vec![left]);
    assert_eq!(
        linked_organizations(&state.pool, leaver_connection).await,
        vec![kept],
        "the links from the organization they left are removed"
    );
    assert_eq!(
        linked_organizations(&state.pool, stayer_connection).await,
        vec![left]
    );
    let remaining = organization_agents(&state, &owner, left).await;
    assert_eq!(
        remaining.iter().map(|agent| agent.id).collect::<Vec<_>>(),
        vec![stayer_connection]
    );
    assert!(matches!(
        organization_generation(&state, &owner, left, leaver_connection).await,
        Err(ApiError::Forbidden)
    ));
    assert!(matches!(
        list_members(State(state.clone()), leaver.jar.clone(), Path(left)).await,
        Err(ApiError::Forbidden)
    ));
    assert_eq!(
        usage_event_rows(&state.pool, left).await,
        1,
        "recorded usage stays attributed to the organization"
    );
    assert_eq!(
        workspace_connection_row(&state.pool, leaver_connection)
            .await
            .unwrap(),
        workspace_before,
        "leaving an organization must not touch the Workspace connection"
    );
    assert_eq!(
        stored_credentials(&state.pool, leaver_connection).await,
        credential_before
    );
    assert_eq!(workspace_connections(&state, &leaver).await.len(), 1);

    assert!(
        matches!(
            leave_organization(State(state.clone()), leaver.jar.clone(), Path(left)).await,
            Err(ApiError::Forbidden)
        ),
        "a member who already left has nothing left to leave"
    );
    invite(&state, &owner, left, &leaver).await;
    let Json(invitations) = list_invitations(State(state.clone()), leaver.jar.clone())
        .await
        .unwrap();
    assert!(
        invitations
            .iter()
            .any(|invitation| invitation.organization_id == left),
        "a member who left can be invited again"
    );
}

/// The id of the pending invitation `invitee` has to `org_id`.
async fn invitation_id(state: &AppState, invitee: &TestUser, org_id: Uuid) -> Uuid {
    let Json(invitations) = list_invitations(State(state.clone()), invitee.jar.clone())
        .await
        .unwrap();
    invitations
        .iter()
        .find(|invitation| invitation.organization_id == org_id)
        .unwrap()
        .id
}

async fn accept(
    state: &AppState,
    invitee: &TestUser,
    invitation_id: Uuid,
) -> Result<super::Organization, ApiError> {
    accept_invitation(
        State(state.clone()),
        invitee.jar.clone(),
        Path(invitation_id),
    )
    .await
    .map(|Json(accepted)| accepted)
}

#[sqlx::test]
async fn creating_or_accepting_an_organization_makes_it_the_default(pool: PgPool) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let invitee = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;

    assert!(default_ids(&state, &owner).await.is_empty());
    let first = organization_with_members(&state, &owner, "First", &[&member]).await;
    assert_eq!(
        default_ids(&state, &owner).await,
        vec![first],
        "the organization someone creates is their default"
    );
    let (_, Json(created)) = create_organization(
        State(state.clone()),
        outsider.jar.clone(),
        Json(CreateOrganization {
            name: "Outsider's".to_owned(),
            description: None,
        }),
    )
    .await
    .unwrap();
    assert!(
        created.is_default,
        "the created organization says so itself"
    );
    assert_eq!(default_ids(&state, &outsider).await, vec![created.id]);
    assert_eq!(
        default_ids(&state, &owner).await,
        vec![first],
        "someone else's default is not touched"
    );
    assert_eq!(
        default_ids(&state, &member).await,
        vec![first],
        "and so is the one they have just joined"
    );

    let second = organization_with_members(&state, &owner, "Second", &[&member]).await;
    for (user, who) in [(&owner, "the creator"), (&member, "the member")] {
        assert_eq!(
            default_ids(&state, user).await,
            vec![second],
            "the newest organization replaces the default of {who}"
        );
        assert_eq!(default_rows(&state.pool, user).await, 1);
    }

    // Being invited changes nothing until the invitation is accepted.
    invite(&state, &owner, first, &invitee).await;
    assert!(default_ids(&state, &invitee).await.is_empty());
    let invitation = invitation_id(&state, &invitee, first).await;
    let accepted = accept(&state, &invitee, invitation).await.unwrap();
    assert_eq!(
        (accepted.id, accepted.is_default),
        (first, true),
        "accepting returns the organization that was joined, now the default"
    );
    assert_eq!(default_ids(&state, &invitee).await, vec![first]);

    // Everyone else keeps their own default.
    assert_eq!(default_ids(&state, &owner).await, vec![second]);
    assert_eq!(default_ids(&state, &member).await, vec![second]);

    // An invitation that was already accepted, or is someone else's, is not
    // found and does not take the default back from the newer organization.
    let own = organization_with_members(&state, &invitee, "Own", &[]).await;
    assert_eq!(default_ids(&state, &invitee).await, vec![own]);
    assert!(matches!(
        accept(&state, &invitee, invitation).await,
        Err(ApiError::NotFound)
    ));
    assert!(matches!(
        accept(&state, &outsider, invitation).await,
        Err(ApiError::NotFound)
    ));
    assert_eq!(default_ids(&state, &invitee).await, vec![own]);
    assert_eq!(default_ids(&state, &outsider).await, vec![created.id]);
}

#[sqlx::test]
async fn a_default_organization_is_single_per_member_and_cleared_when_the_membership_ends(
    pool: PgPool,
) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let invitee = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;
    let first = organization_with_members(&state, &owner, "First", &[&member]).await;
    let second = organization_with_members(&state, &owner, "Second", &[&member]).await;
    invite(&state, &owner, first, &invitee).await;

    for (user, who) in [
        (&invitee, "a pending invitee"),
        (&outsider, "someone outside the organization"),
    ] {
        assert!(
            matches!(
                choose_default(&state, user, first).await,
                Err(ApiError::Forbidden)
            ),
            "{who} cannot make an organization their default"
        );
    }
    assert_eq!(default_rows(&state.pool, &invitee).await, 0);
    assert_eq!(default_rows(&state.pool, &outsider).await, 0);

    // Both organizations were joined; the newest one is the default until the
    // member picks another.
    assert_eq!(default_ids(&state, &member).await, vec![second]);
    assert_eq!(
        choose_default(&state, &member, first).await.unwrap(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(default_ids(&state, &member).await, vec![first]);
    assert_eq!(
        default_ids(&state, &owner).await,
        vec![second],
        "a default belongs to one member only"
    );

    choose_default(&state, &member, second).await.unwrap();
    assert_eq!(
        default_ids(&state, &member).await,
        vec![second],
        "choosing another organization replaces the default"
    );
    choose_default(&state, &member, second).await.unwrap();
    assert_eq!(default_ids(&state, &member).await, vec![second]);
    assert_eq!(default_rows(&state.pool, &member).await, 1);

    choose_default(&state, &owner, first).await.unwrap();
    assert_eq!(default_ids(&state, &owner).await, vec![first]);
    assert_eq!(default_ids(&state, &member).await, vec![second]);

    // Two defaults for one member, or a default nobody accepted, cannot exist.
    assert!(
        sqlx::query(
            "UPDATE organization_memberships SET is_default = TRUE WHERE user_id = $1 AND org_id = $2"
        )
        .bind(member.id)
        .bind(first)
        .execute(&state.pool)
        .await
        .is_err(),
        "the unique index allows one default per member"
    );
    assert!(
        sqlx::query("UPDATE organization_memberships SET is_default = TRUE WHERE user_id = $1")
            .bind(invitee.id)
            .execute(&state.pool)
            .await
            .is_err(),
        "a pending membership cannot be a default"
    );

    // Leaving the default organization clears it; nothing replaces it silently.
    assert_eq!(
        leave_organization(State(state.clone()), member.jar.clone(), Path(second))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(default_ids(&state, &member).await.is_empty());
    assert_eq!(default_rows(&state.pool, &member).await, 0);
    assert_eq!(default_ids(&state, &owner).await, vec![first]);

    // Being removed from an organization clears it too.
    choose_default(&state, &member, first).await.unwrap();
    assert_eq!(default_ids(&state, &member).await, vec![first]);
    remove_member(
        State(state.clone()),
        owner.jar.clone(),
        Path((first, member.username.clone())),
    )
    .await
    .unwrap();
    assert_eq!(default_rows(&state.pool, &member).await, 0);

    // Deleting the organization someone made their default clears it as well.
    assert_eq!(
        delete_organization(State(state.clone()), owner.jar.clone(), Path(first))
            .await
            .unwrap(),
        StatusCode::NO_CONTENT
    );
    assert!(default_ids(&state, &owner).await.is_empty());
    assert_eq!(default_rows(&state.pool, &owner).await, 0);
    assert!(matches!(
        choose_default(&state, &member, first).await,
        Err(ApiError::Forbidden)
    ));
}

#[sqlx::test]
async fn concurrent_default_changes_by_one_user_leave_exactly_one_default(pool: PgPool) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let newcomer = test_user(&state.pool).await;
    let mut organizations = Vec::new();
    for name in ["One", "Two", "Three"] {
        organizations.push(organization_with_members(&state, &owner, name, &[&member]).await);
    }

    // The same member choosing between their organizations at once.
    let mut requests = tokio::task::JoinSet::new();
    for round in 0..15 {
        let org_id = organizations[round % organizations.len()];
        let state = state.clone();
        let jar = member.jar.clone();
        requests
            .spawn(async move { set_default_organization(State(state), jar, Path(org_id)).await });
    }
    while let Some(result) = requests.join_next().await {
        assert_eq!(result.unwrap().unwrap(), StatusCode::NO_CONTENT);
    }
    assert_eq!(default_rows(&state.pool, &member).await, 1);
    let defaults = default_ids(&state, &member).await;
    assert_eq!(defaults.len(), 1);
    assert!(organizations.contains(&defaults[0]));

    // Someone with no organization yet accepting three invitations at once,
    // while also choosing between the ones they already have.
    for org_id in &organizations {
        invite(&state, &owner, *org_id, &newcomer).await;
    }
    let mut requests = tokio::task::JoinSet::new();
    for org_id in organizations.clone() {
        let state = state.clone();
        let newcomer_jar = newcomer.jar.clone();
        requests.spawn(async move {
            let Json(invitations) = list_invitations(State(state.clone()), newcomer_jar.clone())
                .await
                .unwrap();
            let invitation = invitations
                .iter()
                .find(|invitation| invitation.organization_id == org_id)
                .unwrap()
                .id;
            accept_invitation(State(state), newcomer_jar, Path(invitation))
                .await
                .map(|Json(accepted)| accepted.id)
        });
    }
    while let Some(result) = requests.join_next().await {
        assert!(organizations.contains(&result.unwrap().unwrap()));
    }
    assert_eq!(default_rows(&state.pool, &newcomer).await, 1);
    assert_eq!(organization_ids(&state, &newcomer).await.len(), 3);
}

#[sqlx::test]
async fn organizations_created_at_once_by_one_user_leave_exactly_one_default(pool: PgPool) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let creator = test_user(&state.pool).await;

    let mut requests = tokio::task::JoinSet::new();
    for round in 0..6 {
        let state = state.clone();
        let jar = creator.jar.clone();
        requests.spawn(async move {
            create_organization(
                State(state),
                jar,
                Json(CreateOrganization {
                    name: format!("Concurrent {round}"),
                    description: None,
                }),
            )
            .await
            .map(|(_, Json(organization))| organization.id)
        });
    }
    let mut created = Vec::new();
    while let Some(result) = requests.join_next().await {
        created.push(result.unwrap().unwrap());
    }

    assert_eq!(created.len(), 6);
    assert_eq!(organization_ids(&state, &creator).await.len(), 6);
    assert_eq!(default_rows(&state.pool, &creator).await, 1);
    assert!(created.contains(&default_ids(&state, &creator).await[0]));
}

#[sqlx::test]
async fn the_organization_list_summarizes_each_organization_like_its_overview(pool: PgPool) {
    let (state, _) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let member = test_user(&state.pool).await;
    let invitee = test_user(&state.pool).await;
    let outsider = test_user(&state.pool).await;
    let org = organization_with_members(&state, &owner, "Summarized", &[&member]).await;
    let owned_by_member = organization_with_members(&state, &member, "Member's own", &[]).await;
    invite(&state, &owner, org, &invitee).await;

    let owner_connection = connect_workspace_deepseek(&state, &owner, PEER_KEY).await;
    let member_connection = connect_workspace_deepseek(&state, &member, WORKSPACE_KEY).await;
    let retired_connection =
        connect_workspace_deepseek(&state, &owner, ROTATED_WORKSPACE_KEY).await;
    link(&state, &owner, org, owner_connection).await;
    link(&state, &member, org, member_connection).await;
    link(&state, &owner, org, retired_connection).await;
    sqlx::query("UPDATE agent_connections SET status = 'disconnected' WHERE id = $1")
        .bind(retired_connection)
        .execute(&state.pool)
        .await
        .unwrap();

    record_usage(&state.pool, org, &member, member_connection).await;
    record_usage(&state.pool, org, &owner, owner_connection).await;
    // A request whose provider reported no tokens still counts as a request.
    sqlx::query(
        "INSERT INTO organization_usage_events (id, org_id, user_id, connection_id, provider, model)
         VALUES ($1, $2, $3, $4, 'deepseek', 'deepseek-chat')",
    )
    .bind(Uuid::new_v4())
    .bind(org)
    .bind(member.id)
    .bind(member_connection)
    .execute(&state.pool)
    .await
    .unwrap();
    // A request from 45 days ago is outside the default 30 days only.
    sqlx::query(
        "INSERT INTO organization_usage_events
            (id, org_id, user_id, connection_id, provider, model, input_tokens, output_tokens, created_at)
         VALUES ($1, $2, $3, $4, 'deepseek', 'deepseek-chat', 700, 300, NOW() - INTERVAL '45 days')",
    )
    .bind(Uuid::new_v4())
    .bind(org)
    .bind(owner.id)
    .bind(owner_connection)
    .execute(&state.pool)
    .await
    .unwrap();

    for (viewer, role) in [(&owner, "owner"), (&member, "member")] {
        for days in [None, Some(1), Some(30), Some(90)] {
            let summaries = organization_summaries(&state, viewer, days).await;
            let summary = summaries.iter().find(|item| item.id == org).unwrap();
            let Json(page) = overview(
                State(state.clone()),
                viewer.jar.clone(),
                Path(org),
                Query(OrganizationPeriodQuery { days }),
            )
            .await
            .unwrap();
            let who = format!("{role} with days {days:?}");
            assert_eq!(summary.period_days, page.period_days, "{who}");
            assert_eq!(summary.agent_count, page.agent_count, "{who}");
            assert_eq!(summary.member_count, page.member_count, "{who}");
            assert_eq!(summary.requests, page.requests, "{who}");
            assert_eq!(summary.known_input_tokens, page.known_input_tokens, "{who}");
            assert_eq!(
                summary.known_output_tokens, page.known_output_tokens,
                "{who}"
            );
            assert_eq!(
                summary.known_cached_tokens, page.known_cached_tokens,
                "{who}"
            );
            assert_eq!(
                summary.token_known_requests, page.token_known_requests,
                "{who}"
            );
            assert_eq!(summary.role, role);
            assert_eq!(summary.is_default, page.organization.is_default, "{who}");
            assert_eq!(summary.name, "Summarized");
            assert_eq!(summary.owner_username, owner.username);
            // The owner created this organization, so it is their default;
            // the member created another one afterwards, so theirs is that one.
            assert_eq!(summary.is_default, role == "owner", "{who}");
        }
    }

    let summary = organization_summaries(&state, &member, None).await;
    let summarized = summary.iter().find(|item| item.id == org).unwrap();
    assert_eq!(
        summarized.member_count, 2,
        "the owner and the member, not the pending invitee"
    );
    assert_eq!(
        summarized.agent_count, 2,
        "a disconnected account is not an agent"
    );
    assert_eq!(summarized.period_days, 30);
    assert_eq!(summarized.requests, 3);
    assert_eq!(summarized.token_known_requests, 2);
    assert_eq!(summarized.known_input_tokens, 20);
    assert_eq!(summarized.known_output_tokens, 10);
    let ninety_days = organization_summaries(&state, &member, Some(90)).await;
    assert_eq!(
        ninety_days
            .iter()
            .find(|item| item.id == org)
            .unwrap()
            .requests,
        4
    );

    let own = summary
        .iter()
        .find(|item| item.id == owned_by_member)
        .unwrap();
    assert_eq!(own.role, "owner");
    assert_eq!(own.owner_username, member.username);
    assert_eq!((own.member_count, own.agent_count, own.requests), (1, 0, 0));
    assert_eq!(
        summary.iter().map(|item| item.id).collect::<Vec<_>>(),
        vec![org, owned_by_member],
        "oldest organization first"
    );

    // A default shows on the viewer's own rows only, and follows their choice.
    let flags = |summaries: &[super::OrganizationSummary]| {
        summaries
            .iter()
            .map(|item| (item.id, item.is_default))
            .collect::<Vec<_>>()
    };
    let listed = |organizations: Vec<super::Organization>| {
        organizations
            .iter()
            .map(|item| (item.id, item.is_default))
            .collect::<Vec<_>>()
    };
    assert_eq!(flags(&summary), vec![(org, false), (owned_by_member, true)]);
    choose_default(&state, &member, org).await.unwrap();
    assert_eq!(
        flags(&organization_summaries(&state, &member, None).await),
        vec![(org, true), (owned_by_member, false)]
    );
    let Json(plain_list) = list_organizations(State(state.clone()), member.jar.clone())
        .await
        .unwrap();
    assert_eq!(
        listed(plain_list),
        vec![(org, true), (owned_by_member, false)],
        "the plain list carries the same flags"
    );
    assert_eq!(
        flags(&organization_summaries(&state, &owner, None).await),
        vec![(org, true)],
        "the owner's own default is not the member's"
    );

    assert!(
        organization_summaries(&state, &outsider, None)
            .await
            .is_empty()
    );
    assert!(matches!(
        list_organization_summaries(
            State(state.clone()),
            member.jar.clone(),
            Query(OrganizationPeriodQuery { days: Some(0) }),
        )
        .await,
        Err(ApiError::Validation(_))
    ));
    assert!(matches!(
        list_organization_summaries(
            State(state.clone()),
            CookieJar::new(),
            Query(OrganizationPeriodQuery { days: None }),
        )
        .await,
        Err(ApiError::Unauthorized)
    ));
}

#[sqlx::test]
async fn deleting_a_workspace_connection_waits_for_a_refresh_that_holds_its_credential(
    pool: PgPool,
) {
    let (state, _fake) = state_with_fake_deepseek(pool).await;
    let owner = test_user(&state.pool).await;
    let root_id = connect_workspace_deepseek(&state, &owner, WORKSPACE_KEY).await;

    // A refresh (or reconnect mark) locks the credential first, then updates the
    // connection row. Hold that first lock while the owner deletes the account.
    let mut refresh = state.pool.begin().await.unwrap();
    sqlx::query("SELECT 1 FROM agent_connection_credentials WHERE connection_id = $1 FOR UPDATE")
        .bind(root_id)
        .fetch_one(&mut *refresh)
        .await
        .unwrap();
    let delete = tokio::spawn({
        let state = state.clone();
        let jar = owner.jar.clone();
        async move { crate::connections::disconnect(State(state), jar, Path(root_id)).await }
    });
    // Give the delete time to queue behind the credential lock.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert!(!delete.is_finished(), "the delete waits for the refresh");

    // The refresh finishes its connection-row update and commits. With the old
    // lock order the delete held the connection row here and Postgres aborted
    // one side as a deadlock.
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        sqlx::query("UPDATE agent_connections SET updated_at = NOW() WHERE id = $1")
            .bind(root_id)
            .execute(&mut *refresh),
    )
    .await
    .expect("the refresh's connection update must not wait on the delete")
    .unwrap();
    refresh.commit().await.unwrap();

    let deleted = tokio::time::timeout(std::time::Duration::from_secs(5), delete)
        .await
        .expect("the delete completes after the refresh commits")
        .unwrap();
    assert_eq!(deleted.unwrap(), StatusCode::NO_CONTENT);
    assert!(
        workspace_connection_row(&state.pool, root_id)
            .await
            .is_none()
    );
    assert!(stored_credentials(&state.pool, root_id).await.is_empty());
}
