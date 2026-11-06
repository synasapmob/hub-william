//! The Service is its own product. A service key is served only by the platform's
//! stock of accounts, held to the price list before a request goes out and
//! charged when it ends; a workspace key is none of that, and the two never see each
//! other's accounts, keys or usage.

use std::time::Duration;

use axum::{
    Router,
    body::{Body, Bytes, to_bytes},
    http::{HeaderMap, HeaderValue, Method, Uri, header},
    response::Response,
    routing::get,
};
use futures_util::{FutureExt, StreamExt, stream};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    api::gateway::{
        CLAUDE_COUNT_TOKENS_URL, KeyKind, UsageScope, create_key_of_kind,
        keys::authorize_gateway_key,
        list_keys_of_kind,
        providers::gemini::{GeminiOperation, gemini_proxy_request_for_user},
        proxy::{GatewayUpstream, proxy_request_for_user, upstream_response_with_usage},
        revoke_key_of_kind,
        selection::{GatewaySelection, connected_provider_candidates},
        usage::{TokenUsage, UsageEvent, UsageOutcome},
        usage_for_user,
    },
    core::{ApiError, AppConfig, AppState},
    utils::provider_catalogue::AgentProvider,
};

const DOLLAR: i64 = 1_000_000;

struct Fixture {
    user_id: Uuid,
    key_id: Uuid,
    service: bool,
}

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

/// The sums in these tests are worked out at a round price, so they do not follow
/// the price list: gpt-6-sol costs $0.60, $0.06 and $4.70 per million tokens.
async fn pin_the_price(pool: &PgPool) {
    sqlx::query(
        "UPDATE service_model_prices
         SET input_micro_per_million = 600000, cached_micro_per_million = 60000,
             output_micro_per_million = 4700000
         WHERE provider = 'chatgpt' AND model = 'gpt-6-sol'",
    )
    .execute(pool)
    .await
    .unwrap();
}

/// A user with a key of `kind` and a wallet holding `wallet_micro`.
async fn fixture(pool: &PgPool, kind: KeyKind, wallet_micro: i64) -> Fixture {
    let user_id = user(pool).await;
    let key_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO gateway_keys (id, user_id, key_hash, last_four, kind)
         VALUES ($1, $2, $3, 'abcd', $4)",
    )
    .bind(key_id)
    .bind(user_id)
    .bind(key_id.as_bytes().to_vec())
    .bind(kind.as_str())
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("INSERT INTO service_wallets (user_id, wallet_micro) VALUES ($1, $2)")
        .bind(user_id)
        .bind(wallet_micro)
        .execute(pool)
        .await
        .unwrap();
    pin_the_price(pool).await;
    Fixture {
        user_id,
        key_id,
        service: kind == KeyKind::Service,
    }
}

/// A connected account of `provider`, in the platform's stock or not.
async fn connection(pool: &PgPool, owner: Uuid, provider: &str, stock: bool) -> Uuid {
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, service_stock)
         VALUES ($1, $2, $3, 'connected', $4)",
    )
    .bind(id)
    .bind(owner)
    .bind(provider)
    .bind(stock)
    .execute(pool)
    .await
    .unwrap();
    id
}

fn event(pool: &PgPool, fixture: &Fixture, model: &str) -> UsageEvent {
    UsageEvent {
        pool: pool.clone(),
        user_id: fixture.user_id,
        key_id: Some(fixture.key_id),
        organization_id: None,
        connection_id: Uuid::new_v4(),
        provider: AgentProvider::Chatgpt,
        model: Some(model.to_owned()),
        service: fixture.service,
    }
}

async fn serve(app: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    format!("http://{address}")
}

async fn wallet(pool: &PgPool, user_id: Uuid) -> i64 {
    sqlx::query_scalar("SELECT wallet_micro FROM service_wallets WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(pool)
        .await
        .unwrap()
}

async fn charges(pool: &PgPool, user_id: Uuid) -> Vec<(i64, i64, Option<Uuid>)> {
    sqlx::query_as(
        "SELECT amount_micro, wallet_after_micro, usage_event_id
         FROM service_ledger WHERE user_id = $1 AND kind = 'usage' ORDER BY created_at",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap()
}

async fn wait_for_charge(pool: &PgPool, user_id: Uuid) {
    tokio::time::timeout(Duration::from_secs(5), async {
        while charges(pool, user_id).await.is_empty() {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .expect("the request should have been charged");
}

/// A provider answer that finishes, with 1,000,000 input tokens of which 800,000
/// cached, and 100,000 output tokens: at the price pinned by `pin_the_price` 638,000 micro-dollars.
const FINISHED: &str = concat!(
    "data: {\"type\":\"response.completed\",\"response\":{\"usage\":{",
    "\"input_tokens\":1000000,\"output_tokens\":100000,",
    "\"input_tokens_details\":{\"cached_tokens\":800000}}}}\n\n",
);

async fn finished_request(pool: &PgPool, fixture: &Fixture) {
    let base = serve(Router::new().route(
        "/done",
        get(|| async { ([(header::CONTENT_TYPE, "text/event-stream")], FINISHED) }),
    ))
    .await;
    let upstream = reqwest::get(format!("{base}/done")).await.unwrap();
    let response = upstream_response_with_usage(upstream, Some(event(pool, fixture, "gpt-6-sol")))
        .await
        .unwrap();
    to_bytes(response.into_body(), 1024 * 1024).await.unwrap();
}

#[sqlx::test]
async fn a_finished_service_request_is_charged_when_its_body_ends(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, DOLLAR).await;

    finished_request(&pool, &fixture).await;
    wait_for_charge(&pool, fixture.user_id).await;

    let event_id: Uuid =
        sqlx::query_scalar("SELECT id FROM gateway_usage_events WHERE user_id = $1")
            .bind(fixture.user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(
        charges(&pool, fixture.user_id).await,
        [(638_000, DOLLAR - 638_000, Some(event_id))]
    );
    assert_eq!(wallet(&pool, fixture.user_id).await, DOLLAR - 638_000);
}

#[sqlx::test]
async fn a_request_of_a_workspace_key_is_never_charged(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Workspace, DOLLAR).await;

    finished_request(&pool, &fixture).await;

    let recorded: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gateway_usage_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(recorded, 1, "the request is still recorded");
    assert!(charges(&pool, fixture.user_id).await.is_empty());
    assert_eq!(wallet(&pool, fixture.user_id).await, DOLLAR);
}

#[sqlx::test]
async fn a_service_request_is_charged_even_if_the_client_leaves_as_the_stream_ends(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, DOLLAR).await;
    let base = serve(Router::new().route(
        "/done",
        get(|| async { ([(header::CONTENT_TYPE, "text/event-stream")], FINISHED) }),
    ))
    .await;
    let upstream = reqwest::get(format!("{base}/done")).await.unwrap();
    let response =
        upstream_response_with_usage(upstream, Some(event(&pool, &fixture, "gpt-6-sol")))
            .await
            .unwrap();
    let mut body = response.into_body().into_data_stream();
    assert!(body.next().await.unwrap().is_ok());

    // The Playground stops reading and closes the connection as soon as it has seen
    // the completion event, while the server is still recording the request.
    assert!(body.next().now_or_never().is_none());
    drop(body);

    wait_for_charge(&pool, fixture.user_id).await;
    assert_eq!(wallet(&pool, fixture.user_id).await, DOLLAR - 638_000);
    let recorded: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM gateway_usage_events WHERE user_id = $1 AND outcome = 'completed'",
    )
    .bind(fixture.user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(recorded, 1);
}

#[sqlx::test]
async fn a_service_request_the_client_abandons_is_charged_for_what_was_seen(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, DOLLAR).await;
    // The provider reports 1,000,000 input tokens and then stalls.
    let base = serve(Router::new().route(
        "/stalled",
        get(|| async {
            let first = stream::once(async {
                Ok::<_, std::io::Error>(Bytes::from_static(
                    b"data: {\"type\":\"response.in_progress\",\"usage\":{\"input_tokens\":1000000}}\n\n",
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
    let response =
        upstream_response_with_usage(upstream, Some(event(&pool, &fixture, "gpt-6-sol")))
            .await
            .unwrap();
    let mut body = response.into_body().into_data_stream();
    assert!(body.next().await.unwrap().is_ok());
    drop(body);
    wait_for_charge(&pool, fixture.user_id).await;

    let outcome: String =
        sqlx::query_scalar("SELECT outcome FROM gateway_usage_events WHERE user_id = $1")
            .bind(fixture.user_id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(outcome, "incomplete");
    // 1,000,000 new input tokens at $0.60 per million.
    assert_eq!(wallet(&pool, fixture.user_id).await, DOLLAR - 600_000);
}

fn state(pool: &PgPool) -> AppState {
    AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool: pool.clone(),
    }
}

fn selection(fixture: &Fixture) -> GatewaySelection {
    GatewaySelection {
        user_id: fixture.user_id,
        key_id: Some(fixture.key_id),
        connection_id: None,
        organization_id: None,
        service: fixture.service,
    }
}

/// The error of a request sent through the gateway to a provider that cannot be
/// reached, from a key that has no account to be served by: a workspace key gets as far
/// as "forbidden", and a service key as "no capacity", both past the billing
/// checks.
async fn send(pool: &PgPool, fixture: &Fixture, method: Method, url: &str, body: &str) -> ApiError {
    proxy_request_for_user(
        &state(pool),
        selection(fixture),
        GatewayUpstream {
            provider: AgentProvider::Chatgpt,
            url,
        },
        method,
        &Uri::from_static("/"),
        &HeaderMap::new(),
        Bytes::from(body.to_owned()),
    )
    .await
    .expect_err("nothing is served by an unreachable provider")
}

const UNREACHABLE: &str = "http://127.0.0.1:1/unreachable";

#[sqlx::test]
async fn a_service_key_with_an_empty_wallet_is_refused_before_anything_is_sent(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, 0).await;

    let error = send(
        &pool,
        &fixture,
        Method::POST,
        UNREACHABLE,
        r#"{"model":"gpt-6-sol"}"#,
    )
    .await;

    assert!(matches!(error, ApiError::InsufficientBalance), "{error:?}");
}

#[sqlx::test]
async fn a_service_key_must_name_a_model_on_the_price_list(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, DOLLAR).await;

    for body in [r#"{"model":"not-a-model"}"#, r#"{}"#, "not json"] {
        let error = send(&pool, &fixture, Method::POST, UNREACHABLE, body).await;

        assert!(
            matches!(error, ApiError::Validation(_)),
            "{body}: {error:?}"
        );
    }
}

#[sqlx::test]
async fn a_service_key_with_money_and_a_listed_model_goes_on_to_the_stock(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, DOLLAR).await;

    let error = send(
        &pool,
        &fixture,
        Method::POST,
        UNREACHABLE,
        r#"{"model":"gpt-6-sol"}"#,
    )
    .await;

    // Past the billing checks; the stock has no ChatGPT account to serve it.
    assert!(matches!(error, ApiError::Provider(_)), "{error:?}");
}

#[sqlx::test]
async fn a_workspace_key_is_not_held_to_the_price_list_or_the_wallet(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Workspace, 0).await;

    let error = send(
        &pool,
        &fixture,
        Method::POST,
        UNREACHABLE,
        r#"{"model":"not-a-model"}"#,
    )
    .await;

    assert!(matches!(error, ApiError::Forbidden), "{error:?}");
}

#[sqlx::test]
async fn counting_tokens_and_listing_models_are_not_billed(pool: PgPool) {
    let fixture = fixture(&pool, KeyKind::Service, 0).await;

    let counting = send(
        &pool,
        &fixture,
        Method::POST,
        CLAUDE_COUNT_TOKENS_URL,
        r#"{"model":"not-a-model"}"#,
    )
    .await;
    let listing = send(&pool, &fixture, Method::GET, UNREACHABLE, "").await;

    assert!(matches!(counting, ApiError::Provider(_)), "{counting:?}");
    assert!(matches!(listing, ApiError::Provider(_)), "{listing:?}");
}

#[sqlx::test]
async fn a_gemini_request_of_a_service_key_is_held_to_the_price_list_too(pool: PgPool) {
    let broke = fixture(&pool, KeyKind::Service, 0).await;
    let funded = fixture(&pool, KeyKind::Service, DOLLAR).await;
    let ask = |fixture: &Fixture, model: &'static str, operation: GeminiOperation| {
        let state = state(&pool);
        let selection = selection(fixture);
        async move {
            gemini_proxy_request_for_user(&state, selection, model, operation, Bytes::new())
                .await
                .expect_err("nothing is served without an account")
        }
    };

    assert!(matches!(
        ask(&broke, "gemini-4-argon-high", GeminiOperation::Generate).await,
        ApiError::InsufficientBalance
    ));
    assert!(matches!(
        ask(&funded, "not-a-model", GeminiOperation::StreamGenerate).await,
        ApiError::Validation(_)
    ));
    // A listed model, with the prefix of its URL, goes on past the checks.
    assert!(matches!(
        ask(
            &funded,
            "models/gemini-4-argon-high",
            GeminiOperation::Generate
        )
        .await,
        ApiError::Provider(_)
    ));
    // Counting tokens is not billed.
    assert!(matches!(
        ask(&broke, "not-a-model", GeminiOperation::CountTokens).await,
        ApiError::Provider(_)
    ));
}

#[sqlx::test]
async fn a_service_key_is_served_by_the_stock_and_nothing_else(pool: PgPool) {
    let customer = fixture(&pool, KeyKind::Service, DOLLAR).await;
    // The customer's own account, a pool's, and the platform's stock.
    let own = connection(&pool, customer.user_id, "deepseek", false).await;
    let platform = user(&pool).await;
    let not_stock = connection(&pool, platform, "deepseek", false).await;
    let stock = connection(&pool, platform, "deepseek", true).await;
    let other_provider = connection(&pool, platform, "groq", true).await;

    let served =
        connected_provider_candidates(&state(&pool), selection(&customer), AgentProvider::Deepseek)
            .await
            .unwrap();

    assert_eq!(
        served
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>(),
        [stock],
        "only a stock account of that provider"
    );
    for hidden in [own, not_stock, other_provider] {
        assert!(served.iter().all(|candidate| candidate.id != hidden));
    }
}

#[sqlx::test]
async fn a_workspace_key_never_reaches_the_stock(pool: PgPool) {
    let member = fixture(&pool, KeyKind::Workspace, 0).await;
    let own = connection(&pool, member.user_id, "deepseek", false).await;
    let platform = user(&pool).await;
    let stock = connection(&pool, platform, "deepseek", true).await;

    let served =
        connected_provider_candidates(&state(&pool), selection(&member), AgentProvider::Deepseek)
            .await
            .unwrap();

    assert_eq!(
        served
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>(),
        [own]
    );
    assert!(served.iter().all(|candidate| candidate.id != stock));
}

#[sqlx::test]
async fn a_service_key_with_no_stock_gets_no_capacity_not_the_owners_accounts(pool: PgPool) {
    let customer = fixture(&pool, KeyKind::Service, DOLLAR).await;
    connection(&pool, customer.user_id, "deepseek", false).await;

    let error =
        connected_provider_candidates(&state(&pool), selection(&customer), AgentProvider::Deepseek)
            .await
            .expect_err("there is no stock");

    assert!(matches!(error, ApiError::Provider(_)), "{error:?}");
}

fn bearer(key: &str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {key}")).unwrap(),
    );
    headers
}

#[sqlx::test]
async fn a_request_is_told_apart_by_the_kind_of_key_it_presents(pool: PgPool) {
    let owner = user(&pool).await;
    let workspace_key = create_key_of_kind(&pool, owner, KeyKind::Workspace, None)
        .await
        .unwrap();
    let service = create_key_of_kind(&pool, owner, KeyKind::Service, None)
        .await
        .unwrap();

    assert!(workspace_key.key.starts_with("hw_live_"));
    assert!(service.key.starts_with("hw_svc_"));
    let state = state(&pool);
    let workspace_auth = authorize_gateway_key(&state, &bearer(&workspace_key.key))
        .await
        .unwrap();
    let service_auth = authorize_gateway_key(&state, &bearer(&service.key))
        .await
        .unwrap();
    assert!(!workspace_auth.is_service());
    assert!(service_auth.is_service());
    assert!(GatewaySelection::from(service_auth).service);
    assert!(!GatewaySelection::from(workspace_auth).service);

    // A revoked key stops working, whatever its kind.
    revoke_key_of_kind(&pool, owner, service.metadata.id, KeyKind::Service, None)
        .await
        .unwrap();
    assert!(matches!(
        authorize_gateway_key(&state, &bearer(&service.key)).await,
        Err(ApiError::GatewayUnauthorized)
    ));
}

#[sqlx::test]
async fn workspace_keys_and_service_keys_are_listed_and_revoked_apart(pool: PgPool) {
    let owner = user(&pool).await;
    let workspace_key = create_key_of_kind(&pool, owner, KeyKind::Workspace, None)
        .await
        .unwrap();
    let service = create_key_of_kind(&pool, owner, KeyKind::Service, None)
        .await
        .unwrap();

    let workspace_ids: Vec<Uuid> = list_keys_of_kind(&pool, owner, KeyKind::Workspace, None)
        .await
        .unwrap()
        .into_iter()
        .map(|key| key.id)
        .collect();
    let service_ids: Vec<Uuid> = list_keys_of_kind(&pool, owner, KeyKind::Service, None)
        .await
        .unwrap()
        .into_iter()
        .map(|key| key.id)
        .collect();
    assert_eq!(workspace_ids, [workspace_key.metadata.id]);
    assert_eq!(service_ids, [service.metadata.id]);

    // Each is found only by its own kind.
    assert!(matches!(
        revoke_key_of_kind(&pool, owner, service.metadata.id, KeyKind::Workspace, None).await,
        Err(ApiError::NotFound)
    ));
    assert!(matches!(
        revoke_key_of_kind(
            &pool,
            owner,
            workspace_key.metadata.id,
            KeyKind::Service,
            None
        )
        .await,
        Err(ApiError::NotFound)
    ));
    assert_eq!(
        list_keys_of_kind(&pool, owner, KeyKind::Service, None)
            .await
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test]
async fn the_workspace_and_the_service_each_read_only_their_own_usage(pool: PgPool) {
    let owner = user(&pool).await;
    let workspace_key = create_key_of_kind(&pool, owner, KeyKind::Workspace, None)
        .await
        .unwrap();
    let service = create_key_of_kind(&pool, owner, KeyKind::Service, None)
        .await
        .unwrap();
    sqlx::query("INSERT INTO service_wallets (user_id, wallet_micro) VALUES ($1, $2)")
        .bind(owner)
        .bind(DOLLAR)
        .execute(&pool)
        .await
        .unwrap();
    pin_the_price(&pool).await;
    let usage = TokenUsage {
        input_tokens: Some(1_000_000),
        output_tokens: Some(100_000),
        cached_tokens: Some(800_000),
    };
    let sent = |key: Option<Uuid>, service: bool| UsageEvent {
        pool: pool.clone(),
        user_id: owner,
        key_id: key,
        organization_id: None,
        connection_id: Uuid::new_v4(),
        provider: AgentProvider::Chatgpt,
        model: Some("gpt-6-sol".to_owned()),
        service,
    };
    // A workspace key, the Playground (no key), and a service key.
    for event in [
        sent(Some(workspace_key.metadata.id), false),
        sent(None, false),
        sent(Some(service.metadata.id), true),
    ] {
        event
            .record(UsageOutcome::Completed, Some(usage), None, false)
            .await
            .unwrap();
    }
    let state = state(&pool);

    let workspace = usage_for_user(&state, owner, None, UsageScope::Workspace)
        .await
        .unwrap();
    let serviced = usage_for_user(&state, owner, None, UsageScope::Service)
        .await
        .unwrap();

    assert_eq!(
        workspace.requests, 2,
        "the workspace key and the Playground"
    );
    assert_eq!(workspace.spent_micro, 0);
    assert!(
        workspace
            .breakdown
            .iter()
            .all(|row| row.gateway_key_id != Some(service.metadata.id))
    );
    assert_eq!(serviced.requests, 1, "the service key alone");
    assert_eq!(serviced.spent_micro, 638_000);
    assert_eq!(serviced.breakdown.len(), 1);
    assert_eq!(serviced.breakdown[0].spent_micro, 638_000);
    assert_eq!(
        serviced.breakdown[0].gateway_key_id,
        Some(service.metadata.id)
    );
    assert_eq!(wallet(&pool, owner).await, DOLLAR - 638_000);
    // Only the service request was charged, and the charge is of that event.
    assert_eq!(charges(&pool, owner).await.len(), 1);
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
async fn an_organization_key_is_served_by_what_its_organization_shares_and_nothing_else(
    pool: PgPool,
) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek", false).await;
    let owners_other = connection(&pool, owner, "deepseek", false).await;
    let members_own = connection(&pool, member, "deepseek", false).await;
    let stock = connection(&pool, user(&pool).await, "deepseek", true).await;
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

    assert!(key.key.starts_with("hw_org_"));
    assert_eq!(selection.organization_id, Some(org));
    assert!(!selection.service);
    assert_eq!(
        served
            .iter()
            .map(|candidate| candidate.id)
            .collect::<Vec<_>>(),
        [shared],
        "only what the organization shares"
    );
    for hidden in [owners_other, members_own, stock] {
        assert!(served.iter().all(|candidate| candidate.id != hidden));
    }
}

#[sqlx::test]
async fn an_organization_key_stops_working_when_its_owner_leaves_the_organization(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek", false).await;
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
async fn the_three_kinds_of_keys_are_listed_apart(pool: PgPool) {
    let owner = user(&pool).await;
    let member = user(&pool).await;
    let shared = connection(&pool, owner, "deepseek", false).await;
    let org = organization(&pool, owner, member, shared).await;
    let workspace_key = create_key_of_kind(&pool, member, KeyKind::Workspace, None)
        .await
        .unwrap();
    let organization_key = create_key_of_kind(&pool, member, KeyKind::Organization, Some(org))
        .await
        .unwrap();
    let service_key = create_key_of_kind(&pool, member, KeyKind::Service, None)
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
    assert_eq!(
        ids(list_keys_of_kind(&pool, member, KeyKind::Service, None)
            .await
            .unwrap()),
        [service_key.metadata.id]
    );
    // The database refuses an organization key with no organization, and a key of
    // another kind that names one.
    for (kind, organization) in [
        ("organization", None),
        ("workspace", Some(org)),
        ("service", Some(org)),
    ] {
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
    let shared = connection(&pool, owner, "deepseek", false).await;
    let org = organization(&pool, owner, member, shared).await;
    let usage = TokenUsage {
        input_tokens: Some(10),
        output_tokens: Some(5),
        cached_tokens: Some(0),
    };
    let sent = |organization_id: Option<Uuid>, service: bool| UsageEvent {
        pool: pool.clone(),
        user_id: member,
        key_id: None,
        organization_id,
        connection_id: shared,
        provider: AgentProvider::Deepseek,
        model: Some("deepseek-flash".to_owned()),
        service,
    };
    sqlx::query("INSERT INTO service_wallets (user_id, wallet_micro) VALUES ($1, $2)")
        .bind(member)
        .bind(DOLLAR)
        .execute(&pool)
        .await
        .unwrap();
    for event in [sent(None, false), sent(Some(org), false), sent(None, true)] {
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
        [
            ("organization".to_owned(), 1),
            ("service".to_owned(), 1),
            ("workspace".to_owned(), 1)
        ]
    );
    // The Workspace's usage has neither the organization's request nor the Service's.
    let workspace = usage_for_user(&state(&pool), member, None, UsageScope::Workspace)
        .await
        .unwrap();
    assert_eq!(workspace.requests, 1);
}
