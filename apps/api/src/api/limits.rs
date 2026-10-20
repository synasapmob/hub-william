//! Rate-limit policy for the HTTP surface.
//!
//! Every number lives in [`Limit::per_minute`]. A feature gets a limiter from
//! `ip_limit`, [`UserLimit`] or [`GatewayLimit`] and attaches it to its own
//! routes in `routes.rs`. A limiter value is one bucket set, so cloning it onto
//! several routes makes them share a budget, and building another gives a route
//! its own.

use std::sync::Arc;

use axum::{
    extract::{Request, State},
    middleware::Next,
    response::Response,
};
use axum_extra::extract::CookieJar;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::core::{
    ApiError, AppState, GatewayAuthFailed,
    client_ip::{ClientIpSource, ClientKey, peer_address},
    rate_limit::{IpLimit, TokenBuckets},
};

use super::{auth::optional_authenticated_user_id, gateway::gateway_key_from_headers};

#[derive(Clone, Copy)]
pub(crate) enum Limit {
    AgentKeyConnect,
    AgentOAuth,
    AgentRefresh,
    AgentResetCredits,
    AuthLogin,
    AuthRefresh,
    AuthRegister,
    GatewayFailedAuth,
    GatewayKey,
    GatewayKeyManagement,
    OrganizationWrite,
    PlaygroundGenerate,
    PoolDecision,
    PoolInvite,
    PoolRequest,
    ReelMedia,
    ReelResolve,
    Tts,
}

impl Limit {
    pub(crate) const fn per_minute(self) -> u32 {
        match self {
            Self::AgentKeyConnect
            | Self::AgentOAuth
            | Self::AgentRefresh
            | Self::AgentResetCredits
            | Self::AuthLogin
            | Self::AuthRefresh
            | Self::AuthRegister
            | Self::GatewayKeyManagement
            | Self::OrganizationWrite
            | Self::PoolInvite
            | Self::PoolRequest => 10,
            Self::GatewayFailedAuth
            | Self::GatewayKey
            | Self::PlaygroundGenerate
            | Self::PoolDecision
            | Self::ReelMedia
            | Self::ReelResolve
            | Self::Tts => 30,
        }
    }
}

pub(crate) fn ip_limit(state: &AppState, limit: Limit) -> IpLimit {
    IpLimit::new(&state.config, limit.per_minute())
}

/// The user a request is signed in as, once a limiter or `authorize_chat` has
/// resolved the session, so later layers do not look it up again.
#[derive(Clone, Copy)]
pub(crate) struct SessionUserId(pub(crate) Uuid);

/// Limits a route group per signed-in user. A request without a valid session
/// is counted against its IP instead and left for the handler to reject.
#[derive(Clone)]
pub(crate) struct UserLimit {
    state: AppState,
    users: Arc<TokenBuckets<Uuid>>,
    anonymous: Arc<TokenBuckets<ClientKey>>,
    source: ClientIpSource,
}

impl UserLimit {
    pub(crate) fn new(state: &AppState, limit: Limit) -> Self {
        Self {
            state: state.clone(),
            users: Arc::new(TokenBuckets::per_minute(limit.per_minute())),
            anonymous: Arc::new(TokenBuckets::per_minute(limit.per_minute())),
            source: ClientIpSource::from_config(&state.config),
        }
    }
}

pub(crate) async fn limit_by_user(
    State(limit): State<UserLimit>,
    jar: CookieJar,
    mut request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user_id = match request.extensions().get::<SessionUserId>() {
        Some(session) => Some(session.0),
        None => optional_authenticated_user_id(&limit.state, &jar).await?,
    };
    match user_id {
        Some(user_id) => {
            limit
                .users
                .acquire(&user_id)
                .map_err(ApiError::too_many_requests)?;
            request.extensions_mut().insert(SessionUserId(user_id));
        }
        None => {
            let client = limit.source.key(request.headers(), peer_address(&request));
            limit
                .anonymous
                .acquire(&client)
                .map_err(ApiError::too_many_requests)?;
        }
    }

    Ok(next.run(request).await)
}

/// Limits `/gateway/*` per gateway key, and counts failed key attempts per IP.
///
/// A bucket exists only for keys that have worked, so random strings cannot
/// grow the map. Failed attempts spend from an IP budget that is checked before
/// the handler runs, which stops key guessing without taxing valid callers.
#[derive(Clone)]
pub(crate) struct GatewayLimit {
    keys: Arc<TokenBuckets<[u8; 32]>>,
    failures: Arc<TokenBuckets<ClientKey>>,
    source: ClientIpSource,
}

impl GatewayLimit {
    pub(crate) fn new(state: &AppState) -> Self {
        Self {
            keys: Arc::new(TokenBuckets::per_minute(Limit::GatewayKey.per_minute())),
            failures: Arc::new(TokenBuckets::per_minute(
                Limit::GatewayFailedAuth.per_minute(),
            )),
            source: ClientIpSource::from_config(&state.config),
        }
    }
}

pub(crate) async fn limit_gateway(
    State(limit): State<GatewayLimit>,
    request: Request,
    next: Next,
) -> Result<Response, ApiError> {
    let client = limit.source.key(request.headers(), peer_address(&request));
    limit
        .failures
        .peek(&client)
        .map_err(ApiError::too_many_requests)?;

    let key: Option<[u8; 32]> =
        gateway_key_from_headers(request.headers()).map(|key| Sha256::digest(key).into());
    let mut counted = false;
    if let Some(key) = &key
        && let Some(spent) = limit.keys.acquire_existing(key)
    {
        spent.map_err(ApiError::too_many_requests)?;
        counted = true;
    }

    let response = next.run(request).await;

    if response.extensions().get::<GatewayAuthFailed>().is_some() {
        let _ = limit.failures.acquire(&client);
    } else if let Some(key) = &key
        && !counted
    {
        // First request of a key that just authenticated.
        let _ = limit.keys.acquire(key);
    }

    Ok(response)
}
