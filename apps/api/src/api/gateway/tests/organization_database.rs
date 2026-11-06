use std::time::Duration;

use axum::{Router, body::to_bytes, http::header, routing::get};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    api::gateway::{
        proxy::upstream_response_with_usage,
        selection::{GatewaySelection, connected_provider_candidates},
        usage::{UsageEvent, UsageOutcome},
    },
    core::{ApiError, AppConfig, AppState},
    utils::provider_catalogue::AgentProvider,
};

#[sqlx::test]
async fn organization_candidate_scope_does_not_grant_personal_pool_access(pool: PgPool) {
    let state = AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    };
    let owner = Uuid::new_v4();
    let member = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    for user_id in [owner, member] {
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
            .bind(user_id)
            .bind(user_id.simple().to_string())
            .execute(&state.pool)
            .await
            .unwrap();
    }
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Team')")
        .bind(org_id)
        .execute(&state.pool)
        .await
        .unwrap();
    for (user_id, role) in [(owner, "owner"), (member, "member")] {
        sqlx::query(
            "INSERT INTO organization_memberships
                 (id, org_id, user_id, role, status, joined_at)
                 VALUES ($1, $2, $3, $4, 'accepted', NOW())",
        )
        .bind(Uuid::new_v4())
        .bind(org_id)
        .bind(user_id)
        .bind(role)
        .execute(&state.pool)
        .await
        .unwrap();
    }
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'masked')",
    )
    .bind(connection_id)
    .bind(owner)
    .execute(&state.pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             VALUES ($1, $2, $3)",
    )
    .bind(org_id)
    .bind(connection_id)
    .bind(owner)
    .execute(&state.pool)
    .await
    .unwrap();

    let personal = GatewaySelection::from(member);
    let scoped = GatewaySelection {
        key_id: None,
        user_id: member,
        connection_id: Some(connection_id),
        organization_id: Some(org_id),
        service: false,
    };
    assert!(matches!(
        connected_provider_candidates(&state, personal, AgentProvider::Deepseek).await,
        Err(ApiError::Forbidden)
    ));
    assert_eq!(
        connected_provider_candidates(&state, scoped, AgentProvider::Deepseek)
            .await
            .unwrap()
            .len(),
        1
    );

    sqlx::query("DELETE FROM organization_agents WHERE org_id = $1 AND connection_id = $2")
        .bind(org_id)
        .bind(connection_id)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(matches!(
        connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
        Err(ApiError::Forbidden)
    ));
    sqlx::query(
        "INSERT INTO organization_agents (org_id, connection_id, owner_user_id)
             VALUES ($1, $2, $3)",
    )
    .bind(org_id)
    .bind(connection_id)
    .bind(owner)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        connected_provider_candidates(&state, scoped, AgentProvider::Deepseek)
            .await
            .unwrap()
            .len(),
        1
    );
    sqlx::query("DELETE FROM organization_memberships WHERE org_id = $1 AND user_id = $2")
        .bind(org_id)
        .bind(member)
        .execute(&state.pool)
        .await
        .unwrap();
    assert!(matches!(
        connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
        Err(ApiError::Forbidden)
    ));
    sqlx::query(
        "INSERT INTO agent_pool_join_requests
             (id, connection_id, requester_user_id, telegram, reason, status)
             VALUES ($1, $2, $3, 'test', 'test', 'accepted')",
    )
    .bind(Uuid::new_v4())
    .bind(connection_id)
    .bind(member)
    .execute(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        connected_provider_candidates(&state, personal, AgentProvider::Deepseek)
            .await
            .unwrap()
            .len(),
        1
    );
    assert!(matches!(
        connected_provider_candidates(&state, scoped, AgentProvider::Deepseek).await,
        Err(ApiError::Forbidden)
    ));
}

#[sqlx::test]
async fn organization_usage_records_only_completed_generation_streams(pool: PgPool) {
    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(user_id)
        .bind(user_id.simple().to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Stream test')")
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'test')",
    )
    .bind(connection_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    let app = Router::new()
            .route(
                "/incomplete",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":12}}\n\n",
                    )
                }),
            )
            .route(
                "/complete",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":7}}}\n\n",
                    )
                }),
            )
            .route(
                "/unknown",
                get(|| async {
                    (
                        [(header::CONTENT_TYPE, "text/event-stream")],
                        "data: {\"type\":\"response.completed\"}\n\n",
                    )
                }),
            );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    let client = reqwest::Client::new();
    let event = UsageEvent {
        pool: pool.clone(),
        user_id,
        key_id: None,
        organization_id: Some(org_id),
        connection_id,
        provider: AgentProvider::Deepseek,
        model: Some("deepseek-chat".to_owned()),
        service: false,
    };
    for (path, expected_count) in [
        ("incomplete", 0_i64),
        ("complete", 1_i64),
        ("unknown", 2_i64),
    ] {
        let upstream = client
            .get(format!("http://{address}/{path}"))
            .send()
            .await
            .unwrap();
        let response = upstream_response_with_usage(upstream, Some(event.clone()))
            .await
            .unwrap();
        to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM organization_usage_events WHERE org_id = $1")
                .bind(org_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, expected_count, "{path} stream count");
    }
    let known_count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_usage_events
             WHERE org_id = $1 AND input_tokens = 12 AND output_tokens = 7",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(known_count, 1);

    let upstream = client
        .get(format!("http://{address}/complete"))
        .send()
        .await
        .unwrap();
    let response = upstream_response_with_usage(upstream, Some(event))
        .await
        .unwrap();
    sqlx::query("DELETE FROM agent_connections WHERE id = $1")
        .bind(connection_id)
        .execute(&pool)
        .await
        .unwrap();
    to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
    let (count, null_connections): (i64, i64) = sqlx::query_as(
        "SELECT COUNT(*), COUNT(*) FILTER (WHERE connection_id IS NULL)
             FROM organization_usage_events WHERE org_id = $1",
    )
    .bind(org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((count, null_connections), (3, 3));
    server.abort();
}

#[sqlx::test]
async fn organization_usage_survives_concurrent_connection_delete(pool: PgPool) {
    let user_id = Uuid::new_v4();
    let org_id = Uuid::new_v4();
    let connection_id = Uuid::new_v4();
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(user_id)
        .bind(user_id.simple().to_string())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Concurrent delete')")
        .bind(org_id)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
             VALUES ($1, $2, 'deepseek', 'connected', 'test')",
    )
    .bind(connection_id)
    .bind(user_id)
    .execute(&pool)
    .await
    .unwrap();

    let mut deleting = pool.begin().await.unwrap();
    sqlx::query("DELETE FROM agent_connections WHERE id = $1")
        .bind(connection_id)
        .execute(&mut *deleting)
        .await
        .unwrap();
    let event = UsageEvent {
        pool: pool.clone(),
        user_id,
        key_id: None,
        organization_id: Some(org_id),
        connection_id,
        provider: AgentProvider::Deepseek,
        model: Some("deepseek-chat".to_owned()),
        service: false,
    };
    let insert = tokio::spawn(async move {
        event
            .record(UsageOutcome::Completed, None, None, true)
            .await
    });

    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            let waiting: bool = sqlx::query_scalar(
                "SELECT EXISTS (
                       SELECT 1 FROM pg_stat_activity
                       WHERE datname = current_database()
                         AND pid <> pg_backend_pid()
                         AND query LIKE 'INSERT INTO %usage_events%'
                         AND wait_event_type = 'Lock'
                     )",
            )
            .fetch_one(&pool)
            .await
            .unwrap();
            if waiting {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("usage insert must wait for the connection deletion");

    deleting.commit().await.unwrap();
    insert.await.unwrap().unwrap();
    let connection: Option<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM organization_usage_events WHERE org_id = $1")
            .bind(org_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(connection, None);
    let gateway_connection: Option<Uuid> =
        sqlx::query_scalar("SELECT connection_id FROM gateway_usage_events WHERE user_id = $1")
            .bind(user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(gateway_connection, None);
}
