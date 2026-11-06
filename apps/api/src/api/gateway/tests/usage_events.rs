//! Every generation request that reaches a provider through the gateway leaves a
//! row in `gateway_usage_events`, whoever sent it and however it ended.

use std::time::Duration;

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::header,
    response::Response,
    routing::get,
};
use futures_util::{StreamExt, stream};
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    api::gateway::{
        proxy::upstream_response_with_usage,
        usage::{UsageEvent, UsageOutcome},
    },
    utils::provider_catalogue::AgentProvider,
};

#[derive(sqlx::FromRow)]
struct EventRow {
    user_id: Uuid,
    gateway_key_id: Option<Uuid>,
    org_id: Option<Uuid>,
    outcome: String,
    input_tokens: Option<i64>,
    output_tokens: Option<i64>,
    cached_tokens: Option<i64>,
    quota: Option<Value>,
}

struct Fixture {
    user_id: Uuid,
    key_id: Uuid,
    org_id: Uuid,
    connection_id: Uuid,
}

async fn fixture(pool: &PgPool) -> Fixture {
    let fixture = Fixture {
        user_id: Uuid::new_v4(),
        key_id: Uuid::new_v4(),
        org_id: Uuid::new_v4(),
        connection_id: Uuid::new_v4(),
    };
    sqlx::query("INSERT INTO users (id, username, password_hash) VALUES ($1, $2, 'test-only')")
        .bind(fixture.user_id)
        .bind(fixture.user_id.simple().to_string())
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO organizations (id, name) VALUES ($1, 'Usage test')")
        .bind(fixture.org_id)
        .execute(pool)
        .await
        .unwrap();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, account_label)
         VALUES ($1, $2, 'chatgpt', 'connected', 'test')",
    )
    .bind(fixture.connection_id)
    .bind(fixture.user_id)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four) VALUES ($1, $2, $3, 'abcd')",
    )
    .bind(fixture.key_id)
    .bind(fixture.user_id)
    .bind(fixture.key_id.as_bytes().to_vec())
    .execute(pool)
    .await
    .unwrap();
    fixture
}

fn event(pool: &PgPool, fixture: &Fixture, organization: bool) -> UsageEvent {
    UsageEvent {
        pool: pool.clone(),
        user_id: fixture.user_id,
        key_id: Some(fixture.key_id),
        organization_id: organization.then_some(fixture.org_id),
        connection_id: fixture.connection_id,
        provider: AgentProvider::Chatgpt,
        model: Some("gpt-test".to_owned()),
        service: false,
    }
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

async fn wait_for_events(pool: &PgPool, user_id: Uuid, count: i64) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let found: i64 =
                sqlx::query_scalar("SELECT COUNT(*) FROM gateway_usage_events WHERE user_id = $1")
                    .bind(user_id)
                    .fetch_one(pool)
                    .await
                    .unwrap();
            if found >= count {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the usage event should have been recorded");
}

#[sqlx::test]
async fn a_key_request_without_an_organization_is_recorded_with_its_quota_signals(pool: PgPool) {
    let fixture = fixture(&pool).await;
    let base = serve(Router::new().route(
        "/responses",
        get(|| async {
            (
                [
                    (header::CONTENT_TYPE, "text/event-stream"),
                    (
                        header::HeaderName::from_static("x-codex-primary-used-percent"),
                        "12",
                    ),
                    (header::HeaderName::from_static("x-request-id"), "not-quota"),
                ],
                concat!(
                    "data: {\"type\":\"codex.rate_limits\",\"rate_limits\":{\"primary\":{\"used_percent\":12.5}}}\n\n",
                    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":12,\"output_tokens\":7,\"input_tokens_details\":{\"cached_tokens\":4}}}}\n\n",
                ),
            )
        }),
    ))
    .await;

    let upstream = reqwest::get(format!("{base}/responses")).await.unwrap();
    let response = upstream_response_with_usage(upstream, Some(event(&pool, &fixture, false)))
        .await
        .unwrap();
    to_bytes(response.into_body(), 1024 * 1024).await.unwrap();

    let row: EventRow = sqlx::query_as(
        "SELECT user_id, gateway_key_id, org_id, outcome,
                input_tokens, output_tokens, cached_tokens, quota
         FROM gateway_usage_events WHERE user_id = $1",
    )
    .bind(fixture.user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.user_id, fixture.user_id);
    assert_eq!(row.gateway_key_id, Some(fixture.key_id));
    assert_eq!(row.org_id, None);
    assert_eq!(row.outcome, "completed");
    assert_eq!(
        (row.input_tokens, row.output_tokens, row.cached_tokens),
        (Some(12), Some(7), Some(4))
    );
    let quota = row.quota.expect("the provider's quota signals are kept");
    assert_eq!(quota["headers"]["x-codex-primary-used-percent"], "12");
    assert!(quota["headers"].get("x-request-id").is_none());
    assert_eq!(
        quota["event"]["rate_limits"]["primary"]["used_percent"],
        12.5
    );

    let organization_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_usage_events")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        organization_rows, 0,
        "no organization, so no organization row"
    );
}

#[sqlx::test]
async fn a_response_the_client_abandons_is_recorded_as_incomplete(pool: PgPool) {
    let fixture = fixture(&pool).await;
    // The provider sends the start of a response and then stalls.
    let base = serve(Router::new().route(
        "/stalled",
        get(|| async {
            let first = stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(
                    b"data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":12}}\n\n",
                ))
            })
            .chain(stream::pending());
            Response::builder()
                .header(header::CONTENT_TYPE, "text/event-stream")
                .body(Body::from_stream(first))
                .unwrap()
        }),
    ))
    .await;

    let upstream = reqwest::get(format!("{base}/stalled")).await.unwrap();
    let response = upstream_response_with_usage(upstream, Some(event(&pool, &fixture, true)))
        .await
        .unwrap();
    let mut body = response.into_body().into_data_stream();
    assert!(
        body.next().await.unwrap().is_ok(),
        "the client sees the first chunk"
    );
    drop(body);

    wait_for_events(&pool, fixture.user_id, 1).await;
    let row: (String, Option<i64>, Option<i64>) = sqlx::query_as(
        "SELECT outcome, input_tokens, output_tokens
         FROM gateway_usage_events WHERE user_id = $1",
    )
    .bind(fixture.user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(row.0, "incomplete");
    assert_eq!(
        (row.1, row.2),
        (Some(12), None),
        "the usage seen before the client left is kept"
    );

    let organization_rows: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM organization_usage_events")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        organization_rows, 0,
        "organizations still count only finished requests"
    );
}

#[sqlx::test]
async fn organization_requests_that_finish_are_recorded_in_both_tables(pool: PgPool) {
    let fixture = fixture(&pool).await;
    let base = serve(Router::new().route(
        "/done",
        get(|| async {
            (
                [(header::CONTENT_TYPE, "text/event-stream")],
                "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}}\n\n",
            )
        }),
    ))
    .await;

    let upstream = reqwest::get(format!("{base}/done")).await.unwrap();
    let response = upstream_response_with_usage(upstream, Some(event(&pool, &fixture, true)))
        .await
        .unwrap();
    to_bytes(response.into_body(), 1024 * 1024).await.unwrap();

    let gateway: (Option<Uuid>, String) =
        sqlx::query_as("SELECT org_id, outcome FROM gateway_usage_events WHERE user_id = $1")
            .bind(fixture.user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(gateway, (Some(fixture.org_id), "completed".to_owned()));
    let organization: (i64, i64) = sqlx::query_as(
        "SELECT input_tokens, output_tokens FROM organization_usage_events WHERE org_id = $1",
    )
    .bind(fixture.org_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(organization, (3, 2));
}

#[sqlx::test]
async fn recording_never_fails_the_request_when_the_user_is_gone(pool: PgPool) {
    let fixture = fixture(&pool).await;
    let event = event(&pool, &fixture, false);
    sqlx::query("DELETE FROM users WHERE id = $1")
        .bind(fixture.user_id)
        .execute(&pool)
        .await
        .unwrap();

    // The foreign key to the user is violated; the caller must not see an error.
    event
        .record(UsageOutcome::Completed, None, None, false)
        .await
        .unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_usage_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(rows, 0);
}
