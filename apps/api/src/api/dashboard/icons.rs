//! The icons the dashboard shows beside a provider. The pictures live in an R2
//! bucket (`R2_*`, see `core::config`) and a browser loads them from the bucket's
//! public address; this API only puts them there, lists them, and remembers which
//! provider shows which. Without the bucket configured the dashboard still works and
//! shows each provider's first letter.

use axum::{
    Json,
    body::Bytes,
    extract::{Path, Query, State},
    http::StatusCode,
};
use axum_extra::extract::CookieJar;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use utoipa::{IntoParams, ToSchema};

use crate::{
    api::telegram::catalogue::slugify,
    core::{ApiError, AppState, IconStorage},
    utils::object_storage::{self, StorageError},
};

use super::{
    access::{Permission, authorize, staff_member},
    database_error,
    images::image_type,
};

/// The most an icon may weigh. A shop's icons are small; the largest of the six it
/// started with is 39 KB.
pub(crate) const MAXIMUM_ICON_BYTES: usize = 256 * 1024;

/// Where in the bucket the icons are kept.
const ICON_PREFIX: &str = "icons/";

/// The name an uploaded icon starts with when the upload gives none.
const DEFAULT_ICON_NAME: &str = "icon";

/// An icon keeps its bytes for good, so a browser and the CDN may too: a changed
/// picture is a new object under a new name.
const ICON_CACHE_CONTROL: &str = "public, max-age=31536000, immutable";

const NOT_SET_UP: ApiError = ApiError::NotAvailable("Icon storage is not set up.");

fn storage(state: &AppState) -> Result<&IconStorage, ApiError> {
    state.config.icon_storage.as_ref().ok_or(NOT_SET_UP)
}

fn icon_url(storage: &IconStorage, key: &str) -> String {
    format!("{}/{key}", storage.public_url)
}

/// An object name this API would make: under `icons/`, lowercase letters, digits,
/// `.`, `_` and `-`, starting with a letter or a digit. The table checks the same
/// rule, so what is not one is neither listed nor remembered.
fn is_icon_key(key: &str) -> bool {
    let Some(name) = key.strip_prefix(ICON_PREFIX) else {
        return false;
    };

    (1..=100).contains(&name.len())
        && name.starts_with(|first: char| first.is_ascii_lowercase() || first.is_ascii_digit())
        && name.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
}

/// `icons/<name>-<first 8 hex of the bytes' hash>.<extension>`. The hash makes the
/// same picture land on the same object however often it is sent, and a different
/// picture under the same name a different object.
fn icon_key(name: Option<&str>, bytes: &[u8], extension: &str) -> String {
    let stem = name
        .and_then(slugify)
        .map(|slug| slug.chars().take(32).collect::<String>())
        .map(|slug| slug.trim_matches('-').to_owned())
        .filter(|slug| !slug.is_empty())
        .unwrap_or_else(|| DEFAULT_ICON_NAME.to_owned());
    let hash: String = Sha256::digest(bytes)
        .iter()
        .take(4)
        .map(|byte| format!("{byte:02x}"))
        .collect();

    format!("{ICON_PREFIX}{stem}-{hash}.{extension}")
}

fn extension_of(content_type: &str) -> &'static str {
    match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        _ => "webp",
    }
}

fn storage_error(operation: &str, error: StorageError) -> ApiError {
    eprintln!("icon storage {operation} failed: {error}");

    ApiError::Provider("The icon storage did not answer. Try again in a moment.".to_owned())
}

/// A provider name as the dashboard writes it: its slug.
fn is_provider_slug(provider: &str) -> bool {
    (1..=64).contains(&provider.len())
        && provider
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IconAssignment {
    /// The provider's slug.
    pub provider: String,
    /// The icon's name in the bucket.
    pub key: String,
    /// Where a browser loads it from.
    pub url: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct DashboardIcons {
    /// Whether the bucket is set up. When it is not, no icon is shown or changed.
    pub enabled: bool,
    pub assignments: Vec<IconAssignment>,
}

#[utoipa::path(
    get,
    path = "/dashboard/icons",
    responses(
        (status = 200, description = "The icon each provider shows", body = DashboardIcons),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "Not a member of staff", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn list_icons(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<DashboardIcons>, ApiError> {
    staff_member(&state, &jar).await?;

    let Some(storage) = state.config.icon_storage.as_ref() else {
        return Ok(Json(DashboardIcons {
            enabled: false,
            assignments: Vec::new(),
        }));
    };

    let rows = sqlx::query_as::<_, (String, String)>(
        "SELECT provider, icon FROM dashboard_provider_icons ORDER BY provider",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(DashboardIcons {
        enabled: true,
        assignments: rows
            .into_iter()
            .map(|(provider, key)| IconAssignment {
                url: icon_url(storage, &key),
                provider,
                key,
            })
            .collect(),
    }))
}

#[derive(Debug, Serialize, ToSchema)]
pub struct LibraryIcon {
    pub key: String,
    pub url: String,
    pub size: u64,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IconLibrary {
    pub icons: Vec<LibraryIcon>,
}

#[utoipa::path(
    get,
    path = "/dashboard/icons/library",
    responses(
        (status = 200, description = "The icons in the bucket, to choose from", body = IconLibrary),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 501, description = "The icon bucket is not set up", body = crate::core::ErrorResponse),
        (status = 502, description = "The bucket did not answer", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn icon_library(
    State(state): State<AppState>,
    jar: CookieJar,
) -> Result<Json<IconLibrary>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let storage = storage(&state)?;

    let mut icons: Vec<LibraryIcon> =
        object_storage::list_objects(&state.http, storage, ICON_PREFIX)
            .await
            .map_err(|error| storage_error("listing", error))?
            .into_iter()
            .filter(|object| is_icon_key(&object.key))
            .map(|object| LibraryIcon {
                url: icon_url(storage, &object.key),
                key: object.key,
                size: object.size,
            })
            .collect();
    icons.sort_by(|a, b| a.key.cmp(&b.key));

    Ok(Json(IconLibrary { icons }))
}

#[derive(Debug, Deserialize, IntoParams)]
pub struct UploadIconQuery {
    /// What to start the icon's name with, such as the provider it is for.
    name: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct UploadedIcon {
    pub key: String,
    pub url: String,
}

#[utoipa::path(
    post,
    path = "/dashboard/icons",
    params(UploadIconQuery),
    request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "A PNG, JPEG, GIF or WebP picture of at most 256 KiB"),
    responses(
        (status = 201, description = "The icon is in the bucket", body = UploadedIcon),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 413, description = "The picture is over 256 KiB"),
        (status = 422, description = "The body is not a PNG, JPEG, GIF or WebP picture", body = crate::core::ErrorResponse),
        (status = 501, description = "The icon bucket is not set up", body = crate::core::ErrorResponse),
        (status = 502, description = "The bucket did not answer", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn upload_icon(
    State(state): State<AppState>,
    jar: CookieJar,
    Query(query): Query<UploadIconQuery>,
    body: Bytes,
) -> Result<(StatusCode, Json<UploadedIcon>), ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let storage = storage(&state)?;

    if body.len() > MAXIMUM_ICON_BYTES {
        return Err(ApiError::Validation("An icon may weigh at most 256 KiB."));
    }
    // An SVG is left out on purpose: it can carry a script, and the bucket is a
    // page of its own that a browser would run it in if someone opened it there.
    let content_type = image_type(&body).ok_or(ApiError::Validation(
        "An icon must be a PNG, JPEG, GIF or WebP file.",
    ))?;

    let key = icon_key(query.name.as_deref(), &body, extension_of(content_type));
    object_storage::put_object(
        &state.http,
        storage,
        &key,
        content_type,
        ICON_CACHE_CONTROL,
        body.to_vec(),
    )
    .await
    .map_err(|error| storage_error("upload", error))?;

    Ok((
        StatusCode::CREATED,
        Json(UploadedIcon {
            url: icon_url(storage, &key),
            key,
        }),
    ))
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct AssignIcon {
    /// The icon's name in the bucket, or `null` for none.
    pub key: Option<String>,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct IconAssigned {
    pub provider: String,
    pub key: Option<String>,
    pub url: Option<String>,
}

#[utoipa::path(
    put,
    path = "/dashboard/icons/providers/{provider}",
    params(("provider" = String, Path, description = "The provider's slug")),
    request_body = AssignIcon,
    responses(
        (status = 200, description = "The provider now shows this icon, or none", body = IconAssigned),
        (status = 401, description = "Hub login required", body = crate::core::ErrorResponse),
        (status = 403, description = "The role may not manage stock", body = crate::core::ErrorResponse),
        (status = 422, description = "Not a provider's slug or an icon's name", body = crate::core::ErrorResponse),
        (status = 501, description = "The icon bucket is not set up", body = crate::core::ErrorResponse)
    ),
    tag = "dashboard"
)]
pub async fn assign_icon(
    State(state): State<AppState>,
    jar: CookieJar,
    Path(provider): Path<String>,
    Json(payload): Json<AssignIcon>,
) -> Result<Json<IconAssigned>, ApiError> {
    authorize(&state, &jar, Permission::Stock).await?;
    let storage = storage(&state)?;

    if !is_provider_slug(&provider) {
        return Err(ApiError::Validation("That is not a provider's slug."));
    }

    let Some(key) = payload.key else {
        sqlx::query("DELETE FROM dashboard_provider_icons WHERE provider = $1")
            .bind(&provider)
            .execute(&state.pool)
            .await
            .map_err(database_error)?;

        return Ok(Json(IconAssigned {
            provider,
            key: None,
            url: None,
        }));
    };
    if !is_icon_key(&key) {
        return Err(ApiError::Validation("That is not an icon's name."));
    }

    sqlx::query(
        "INSERT INTO dashboard_provider_icons (provider, icon) VALUES ($1, $2)
         ON CONFLICT (provider) DO UPDATE SET icon = EXCLUDED.icon, updated_at = NOW()",
    )
    .bind(&provider)
    .bind(&key)
    .execute(&state.pool)
    .await
    .map_err(database_error)?;

    Ok(Json(IconAssigned {
        provider,
        url: Some(icon_url(storage, &key)),
        key: Some(key),
    }))
}

#[cfg(test)]
mod tests {
    use super::{extension_of, icon_key, is_icon_key, is_provider_slug};

    #[test]
    fn an_icon_is_named_for_its_provider_and_its_bytes() {
        let key = icon_key(Some("  ChatGPT "), b"abc", "png");

        // The first four bytes of the SHA-256 of "abc".
        assert_eq!(key, "icons/chatgpt-ba7816bf.png");
        assert!(is_icon_key(&key));
    }

    #[test]
    fn the_same_picture_is_the_same_object_and_another_is_not() {
        assert_eq!(
            icon_key(Some("a"), b"1", "png"),
            icon_key(Some("a"), b"1", "png")
        );
        assert_ne!(
            icon_key(Some("a"), b"1", "png"),
            icon_key(Some("a"), b"2", "png")
        );
    }

    #[test]
    fn a_name_with_nothing_to_use_gets_the_default() {
        for name in [None, Some(""), Some("   "), Some("!!!")] {
            assert!(icon_key(name, b"x", "webp").starts_with("icons/icon-"));
        }
    }

    #[test]
    fn a_long_or_odd_name_makes_a_key_the_table_accepts() {
        let key = icon_key(Some(&"Ảnh đại diện – Claude ".repeat(10)), b"x", "jpg");

        assert!(is_icon_key(&key), "{key}");
        assert!(key.len() <= 128);
    }

    #[test]
    fn only_a_name_under_icons_is_an_icon() {
        for key in ["icons/a.png", "icons/chatgpt-ba7816bf.png", "icons/0.webp"] {
            assert!(is_icon_key(key), "{key}");
        }
        for key in [
            "",
            "icons/",
            "a.png",
            "icons/../x.png",
            "icons/a/b.png",
            "icons/-a.png",
            "icons/A.png",
            "icons/a b.png",
            "other/a.png",
            &format!("icons/{}", "a".repeat(101)),
        ] {
            assert!(!is_icon_key(key), "{key}");
        }
    }

    #[test]
    fn a_provider_is_named_by_a_slug() {
        assert!(is_provider_slug("chatgpt"));
        assert!(is_provider_slug("capcut-pro"));
        for provider in ["", "ChatGPT", "a b", "a/b", &"a".repeat(65)] {
            assert!(!is_provider_slug(provider), "{provider}");
        }
    }

    #[test]
    fn the_extension_follows_what_the_bytes_are() {
        assert_eq!(extension_of("image/png"), "png");
        assert_eq!(extension_of("image/jpeg"), "jpg");
        assert_eq!(extension_of("image/gif"), "gif");
        assert_eq!(extension_of("image/webp"), "webp");
    }
}
