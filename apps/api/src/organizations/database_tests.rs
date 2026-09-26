use axum::{Json, extract::Path, http::StatusCode};
use axum_extra::extract::{CookieJar, cookie::Cookie};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    CreateOrganization, InviteOrganizationMember, OrganizationAgentListQuery,
    OrganizationPeriodQuery, OrganizationUsageQuery, ShareOrganizationAgent, accept_invitation,
    create_organization, invite_member, list_agents, list_invitations, list_members, overview,
    share_agent, unshare_agent, usage,
};
use crate::{AppConfig, AppState, error::ApiError};
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
