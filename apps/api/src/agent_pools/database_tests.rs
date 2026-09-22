use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use axum_extra::extract::{CookieJar, cookie::Cookie};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use super::{
    AgentPoolRequestStatus, CreateAgentPoolJoinRequest, DecideAgentPoolJoinRequest,
    InviteAgentPoolMember, create_request, decide_request, invite_member,
};
use crate::{AppConfig, AppState, error::ApiError};

struct TestUser {
    id: Uuid,
    username: String,
    jar: CookieJar,
}

async fn user(pool: &PgPool) -> TestUser {
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

#[sqlx::test]
async fn sharing_beyond_legacy_capacity_preserves_owner_and_duplicate_checks(pool: PgPool) {
    let state = AppState {
        config: AppConfig::default(),
        http: reqwest::Client::new(),
        gateway_http: reqwest::Client::new(),
        pool,
    };
    let owner = user(&state.pool).await;
    let connection_id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO agent_connections (id, user_id, provider, status, capacity)
         VALUES ($1, $2, 'deepseek', 'connected', 6)",
    )
    .bind(connection_id)
    .bind(owner.id)
    .execute(&state.pool)
    .await
    .unwrap();

    for _ in 0..7 {
        let member = user(&state.pool).await;
        let payload = || {
            Json(InviteAgentPoolMember {
                username: member.username.clone(),
            })
        };
        let forbidden = invite_member(
            State(state.clone()),
            member.jar.clone(),
            Path(connection_id),
            payload(),
        )
        .await;
        assert!(matches!(forbidden, Err(ApiError::Forbidden)));
        let (status, Json(invited)) = invite_member(
            State(state.clone()),
            owner.jar.clone(),
            Path(connection_id),
            payload(),
        )
        .await
        .unwrap();
        assert_eq!(status, StatusCode::CREATED);
        assert_eq!(invited.username, member.username);
        let duplicate = invite_member(
            State(state.clone()),
            owner.jar.clone(),
            Path(connection_id),
            payload(),
        )
        .await;
        assert!(matches!(
            duplicate,
            Err(ApiError::Validation("That user is already a member."))
        ));
    }

    let requester = user(&state.pool).await;
    let payload = || {
        Json(CreateAgentPoolJoinRequest {
            telegram: "@newmember".to_owned(),
            reason: "Sharing for open-source development.".to_owned(),
        })
    };
    let (status, Json(request)) = create_request(
        State(state.clone()),
        requester.jar.clone(),
        Path(connection_id),
        payload(),
    )
    .await
    .unwrap();
    assert_eq!(status, StatusCode::CREATED);
    assert!(matches!(request.status, AgentPoolRequestStatus::Pending));
    let duplicate = create_request(
        State(state.clone()),
        requester.jar.clone(),
        Path(connection_id),
        payload(),
    )
    .await;
    assert!(matches!(
        duplicate,
        Err(ApiError::Validation(
            "You already requested to join this account pool."
        ))
    ));

    let decision = || {
        Json(DecideAgentPoolJoinRequest {
            status: AgentPoolRequestStatus::Accepted,
        })
    };
    let forbidden = decide_request(
        State(state.clone()),
        requester.jar,
        Path(request.id),
        decision(),
    )
    .await;
    assert!(matches!(forbidden, Err(ApiError::Forbidden)));
    let Json(accepted) = decide_request(
        State(state.clone()),
        owner.jar,
        Path(request.id),
        decision(),
    )
    .await
    .unwrap();
    assert!(matches!(accepted.status, AgentPoolRequestStatus::Accepted));
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM agent_pool_join_requests
         WHERE connection_id = $1 AND status = 'accepted'",
    )
    .bind(connection_id)
    .fetch_one(&state.pool)
    .await
    .unwrap();
    assert_eq!(
        members, 8,
        "eight accepted members plus the owner exceed the old limit"
    );
}
