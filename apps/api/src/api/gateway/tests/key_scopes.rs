//! A key belongs to one scope. A workspace key is served by its owner's own
//! accounts and pools, an organization key by what its organization shares, and
//! the two are told apart, listed, revoked and counted apart.

use axum::http::{HeaderMap, HeaderValue, header};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    api::gateway::{
        KeyKind, create_key_of_kind,
        keys::authorize_gateway_key,
        list_keys_of_kind, revoke_key_of_kind,
        selection::{GatewaySelection, connected_provider_candidates},
        usage::{TokenUsage, UsageEvent, UsageOutcome},
        usage_report::usage_for_user,
    },
    core::{ApiError, AppConfig, AppState},
    utils::provider_catalogue::AgentProvider,
};

async fn user(pool: &PgPool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(id)
        .bind(id.simple().to_string())
        .execute(pool)
        .await
        .unwrap();
    id
}

/// A connected account of `provider`.
async fn connection(pool: &PgPool, owner: Uuid, provider: &str) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status)
         VALUES ($1, $2, $3, 'connected')",
    )
    .bind(id)
    .bind(owner)
    .bind(provider)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn state(pool: &PgPool) -> AppState {
    AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: pool.clone(),
    }
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {key}")).unwrap(),
    );
    headers
}

/// An organization of `owner` with `member` accepted in it, and `shared` one of
/// the owner's accounts, shared with it.
async fn organization(pool: &PgPool, owner: Uuid, member: Uuid, shared: Uuid) -> Uuid {
    let org_id = Uuid::new_v4();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Team')")
        .bind(org_id)
        .execute(pool)
        .await
        .unwrap();
    for (user_id, role) in [(owner, "owner"), (member, "member")] {
        sqlx::query(
            "INSERT INTO organization_memberships (id, org_id, user_id, role, status, joined_at)
             VALUES ($1, $2, $3, $4, 'accepted', NOW())",
        )
        .bind(Uuid::new_v4())
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id) VALUES ($1, $2, $3)",
    )
    .bind(org_id)
    .bind(shared)
    .bind(owner)
    .execute(pool)
    .await
    .unwrap();
    org_id
}

#[sqlx::test]
async fn a_request_is_told_apart_by_the_kind_of_key_it_presents(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek").await;
    let org = organization(&pool, owner, member, shared).await;
    let workspace_key = create_key_of_kind(&pool, member, KeyKind::Workspace, None)
        .await
        .unwrap();
    let organization_key = create_key_of_kind(&pool, member, KeyKind::Organization, Some(org))
        .await
        .unwrap();

    assert!(workspace_key.key.starts_with("hw_live_"));
    assert!(organization_key.key.starts_with("hw_org_"));
    let state = state(&pool);
    let workspace_auth = authorize_gateway_key(&state, &bearer(&workspace_key.key))
        .await
        .unwrap();
    let organization_auth = authorize_gateway_key(&state, &bearer(&organization_key.key))
        .await
        .unwrap();
    assert_eq!(GatewaySelection::from(workspace_auth).organization_id, None);
    assert_eq!(
        GatewaySelection::from(organization_auth).organization_id,
        Some(org)
    );

    // A revoked key stops working, whatever its kind.
    revoke_key_of_kind(
        &pool,
        member,
        organization_key.metadata.id,
        KeyKind::Organization,
        Some(org),
    )
    .await
    .unwrap();
    assert!(matches!(
        authorize_gateway_key(&state, &bearer(&organization_key.key)).await,
        Err(ApiError::GatewayUnauthorized)
    ));
}

#[sqlx::test]
async fn an_organization_key_is_served_by_what_its_organization_shares_and_nothing_else(
    pool: PgPool,
) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek").await;
    let owners_other = connection(&pool, owner, "deepseek").await;
    let members_own = connection(&pool, member, "deepseek").await;
    let org = organization(&pool, owner, member, shared).await;
    let key = create_key_of_kind(&pool, member, KeyKind::Organization, Some(org))
        .await
        .unwrap();
    let state = state(&pool);

    let authorized = authorize_gateway_key(&state, &bearer(&key.key))
        .await
        .unwrap();
    let selection = GatewaySelection::from(authorized);
    let served = connected_provider_candidates(&state, selection, AgentProvider::Deepseek)
        .await
        .unwrap();

    assert_eq!(selection.organization_id, Some(org));
    assert_eq!(
        served
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>(),
        [shared],
        "only what the organization shares"
    );
    for hidden in [owners_other, members_own] {
        assert!(served.iter().all(|candidate| candidate.id != hidden));
    }
}

#[sqlx::test]
async fn an_organization_key_stops_working_when_its_owner_leaves_the_organization(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek").await;
    let org = organization(&pool, owner, member, shared).await;
    let key = create_key_of_kind(&pool, member, KeyKind::Organization, Some(org))
        .await
        .unwrap();
    let state = state(&pool);
    let selection = GatewaySelection::from(
        authorize_gateway_key(&state, &bearer(&key.key))
            .await
            .unwrap(),
    );
    sqlx::query("DELETE FROM organization_memberships WHERE org_id = $1 AND user_id = $2")
        .bind(org)
        .bind(member)
        .execute(&pool)
        .await
        .unwrap();

    let error = connected_provider_candidates(&state, selection, AgentProvider::Deepseek)
        .await
        .expect_err("the member is no longer in the organization");

    assert!(matches!(error, ApiError::Forbidden), "{error:?}");
}

#[sqlx::test]
async fn workspace_and_organization_keys_are_listed_and_revoked_apart(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek").await;
    let org = organization(&pool, owner, member, shared).await;
    let workspace_key = create_key_of_kind(&pool, member, KeyKind::Workspace, None)
        .await
        .unwrap();
    let organization_key = create_key_of_kind(&pool, member, KeyKind::Organization, Some(org))
        .await
        .unwrap();

    let ids = |keys: Vec<crate::api::gateway::GatewayKey>| {
        keys.into_iter().map(|key| key.id).collect::<Vec<_>>()
    };
    assert_eq!(
        ids(list_keys_of_kind(&pool, member, KeyKind::Workspace, None)
            .await
            .unwrap()),
        [workspace_key.metadata.id]
    );
    assert_eq!(
        ids(
            list_keys_of_kind(&pool, member, KeyKind::Organization, Some(org))
                .await
                .unwrap()
        ),
        [organization_key.metadata.id]
    );

    // Each is found only by its own kind.
    assert!(matches!(
        revoke_key_of_kind(
            &pool,
            member,
            organization_key.metadata.id,
            KeyKind::Workspace,
            None
        )
        .await,
        Err(ApiError::NotFound)
    ));
    assert!(matches!(
        revoke_key_of_kind(
            &pool,
            member,
            workspace_key.metadata.id,
            KeyKind::Organization,
            Some(org)
        )
        .await,
        Err(ApiError::NotFound)
    ));

    // The database refuses an organization key with no organization, and a
    // workspace key that names one.
    for (kind, organization) in [("organization", None), ("workspace", Some(org))] {
        let refused = sqlx::query(
            "INSERT INTO gateway_keys (id, user_id, key_hash, last_four, kind, organization_id)
             VALUES ($1, $2, $3, 'abcd', $4, $5)",
        )
        .bind(Uuid::new_v4())
        .bind(member)
        .bind(Uuid::new_v4().as_bytes().to_vec())
        .bind(kind)
        .bind(organization)
        .execute(&pool)
        .await;
        assert!(refused.is_err(), "{kind} with {organization:?}");
    }
}

#[sqlx::test]
async fn every_request_is_counted_in_the_scope_it_belongs_to(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek").await;
    let org = organization(&pool, owner, member, shared).await;
    let usage = TokenUsage {
        input_tokens: Some(10),
        output_tokens: Some(5),
        cached_tokens: Some(0),
    };
    let sent = |organization_id: Option<Uuid>| UsageEvent {
        pool: pool.clone(),
        user_id: member,
        key_id: None,
        organization_id,
        connection_id: shared,
        provider: AgentProvider::Deepseek,
        model: Some("deepseek-flash".to_owned()),
    };
    for event in [sent(None), sent(Some(org))] {
        event
            .record(UsageOutcome::Completed, Some(usage), None, false)
            .await
            .unwrap();
    }

    let scopes: Vec<(String, i64)> = sqlx::query_as(
        "SELECT scope, COUNT(*) FROM gateway_usage_events WHERE user_id = $1
         GROUP BY scope ORDER BY scope",
    )
    .bind(member)
    .fetch_all(&pool)
    .await
    .unwrap();

    assert_eq!(
        scopes,
        [("organization".to_owned(), 1), ("workspace".to_owned(), 1)]
    );
    // The Workspace's usage does not have the organization's request.
    let workspace = usage_for_user(&state(&pool), member, None).await.unwrap();
    assert_eq!(workspace.requests, 1);
}
