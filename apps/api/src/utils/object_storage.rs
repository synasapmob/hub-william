//! A bucket reached through the S3 API, the way Cloudflare R2 offers it: put an
//! object, remove one and list the ones under a prefix. Every request is signed with AWS
//! Signature Version 4, which R2 accepts with the region `auto`.

use std::{fmt, time::Duration};

use chrono::{DateTime, Utc};
use hmac::{Hmac, Mac};
use reqwest::{Client, Method, Url};
use sha2::{Digest, Sha256};

use crate::core::IconStorage;

type HmacSha256 = Hmac<Sha256>;

/// R2 has the one region, and calls it `auto`.
const REGION: &str = "auto";
const SERVICE: &str = "s3";

/// A bucket that answers slowly is no use to a person waiting on an upload.
const TIMEOUT: Duration = Duration::from_secs(15);

/// The most objects one listing asks for.
const LISTING_LIMIT: usize = 200;

/// Why the bucket could not be used. It never carries what the bucket said, so
/// it can go to a log.
#[derive(Debug)]
pub(crate) enum StorageError {
    /// The request did not get an answer.
    Unreachable,
    /// The bucket answered with this status.
    Refused(u16),
    /// The answer was not what a listing looks like.
    Unreadable,
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable => formatter.write_str("the bucket did not answer"),
            Self::Refused(status) => write!(formatter, "the bucket answered {status}"),
            Self::Unreadable => formatter.write_str("the bucket's listing could not be read"),
        }
    }
}

/// An object as a listing names it.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct StoredObject {
    pub key: String,
    pub size: u64,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hmac_sha256(key: &[u8], message: &str) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(key).expect("HMAC takes a key of any length");
    mac.update(message.as_bytes());

    mac.finalize().into_bytes().to_vec()
}

/// Percent-encodes everything but the unreserved characters, as the signature
/// asks; a `/` stays when `keep_slash` is set, for the segments of a path.
fn uri_encode(value: &str, keep_slash: bool) -> String {
    let mut encoded = String::with_capacity(value.len());

    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            encoded.push(char::from(byte));
        } else if byte == b'/' && keep_slash {
            encoded.push('/');
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }

    encoded
}

/// The `Authorization` header of one request. `headers` are every header that is
/// signed, with lowercase names and trimmed values; `query` is already in its
/// canonical form: names sorted, names and values encoded.
#[allow(clippy::too_many_arguments)]
fn authorization(
    access_key_id: &str,
    secret_access_key: &str,
    region: &str,
    service: &str,
    method: &str,
    path: &str,
    query: &str,
    headers: &[(&str, &str)],
    payload_hash: &str,
    now: DateTime<Utc>,
) -> String {
    let mut headers = headers.to_vec();
    headers.sort_by_key(|(name, _)| *name);

    let canonical_headers: String = headers
        .iter()
        .map(|(name, value)| format!("{name}:{value}\n"))
        .collect();
    let signed_headers = headers
        .iter()
        .map(|(name, _)| *name)
        .collect::<Vec<_>>()
        .join(";");
    let canonical_request =
        format!("{method}\n{path}\n{query}\n{canonical_headers}\n{signed_headers}\n{payload_hash}");

    let date = now.format("%Y%m%d");
    let scope = format!("{date}/{region}/{service}/aws4_request");
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{scope}\n{}",
        now.format("%Y%m%dT%H%M%SZ"),
        sha256_hex(canonical_request.as_bytes()),
    );

    let signing_key = [date.to_string().as_str(), region, service, "aws4_request"]
        .into_iter()
        .fold(
            format!("AWS4{secret_access_key}").into_bytes(),
            |key, part| hmac_sha256(&key, part),
        );
    let signature = hex(&hmac_sha256(&signing_key, &string_to_sign));

    format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    )
}

/// What a request to the bucket needs besides its method, path and body.
struct Call<'a> {
    method: Method,
    /// Names sorted, names and values encoded; empty for none.
    query: &'a str,
    path: String,
    /// Signed headers beyond the ones every request has.
    headers: &'a [(&'a str, &'a str)],
    body: Vec<u8>,
}

/// The `Host` header a request to `url` carries, which the signature covers.
fn host_header(url: &Url) -> Option<String> {
    let host = url.host_str()?;

    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

async fn send(
    http: &Client,
    storage: &IconStorage,
    call: Call<'_>,
) -> Result<reqwest::Response, StorageError> {
    let mut url = Url::parse(&format!("{}{}", storage.endpoint, call.path))
        .map_err(|_| StorageError::Unreachable)?;
    if !call.query.is_empty() {
        url.set_query(Some(call.query));
    }
    let host = host_header(&url).ok_or(StorageError::Unreachable)?;
    let now = Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let payload_hash = sha256_hex(&call.body);

    let mut signed: Vec<(&str, &str)> = call.headers.to_vec();
    signed.push(("host", &host));
    signed.push(("x-amz-content-sha256", &payload_hash));
    signed.push(("x-amz-date", &amz_date));

    let authorization = authorization(
        &storage.access_key_id,
        &storage.secret_access_key,
        REGION,
        SERVICE,
        call.method.as_str(),
        &call.path,
        call.query,
        &signed,
        &payload_hash,
        now,
    );

    let mut request = http
        .request(call.method, url)
        .timeout(TIMEOUT)
        .header("authorization", authorization);
    // The host comes from the address, which is what was signed.
    for (name, value) in signed.iter().filter(|(name, _)| *name != "host") {
        request = request.header(*name, *value);
    }

    request
        .body(call.body)
        .send()
        .await
        .map_err(|_| StorageError::Unreachable)
}

/// `/bucket/key`, each segment of the key encoded.
fn object_path(storage: &IconStorage, key: &str) -> String {
    format!(
        "/{}/{}",
        uri_encode(&storage.bucket, false),
        uri_encode(key, true)
    )
}

/// Stores `body` under `key`, replacing what was there. `cache_control` is kept
/// with the object and sent back with it.
pub(crate) async fn put_object(
    http: &Client,
    storage: &IconStorage,
    key: &str,
    content_type: &str,
    cache_control: &str,
    body: Vec<u8>,
) -> Result<(), StorageError> {
    let response = send(
        http,
        storage,
        Call {
            method: Method::PUT,
            query: "",
            path: object_path(storage, key),
            headers: &[
                ("cache-control", cache_control),
                ("content-type", content_type),
            ],
            body,
        },
    )
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(StorageError::Refused(response.status().as_u16()))
    }
}

/// Removes the object. An object that is not there is not an error: asking again
/// after an answer was lost leaves the bucket as wanted.
pub(crate) async fn delete_object(
    http: &Client,
    storage: &IconStorage,
    key: &str,
) -> Result<(), StorageError> {
    let response = send(
        http,
        storage,
        Call {
            method: Method::DELETE,
            query: "",
            path: object_path(storage, key),
            headers: &[],
            body: Vec::new(),
        },
    )
    .await?;

    if response.status().is_success() {
        Ok(())
    } else {
        Err(StorageError::Refused(response.status().as_u16()))
    }
}

/// The objects whose key starts with `prefix`, at most [`LISTING_LIMIT`] of them.
pub(crate) async fn list_objects(
    http: &Client,
    storage: &IconStorage,
    prefix: &str,
) -> Result<Vec<StoredObject>, StorageError> {
    let query = format!(
        "list-type=2&max-keys={LISTING_LIMIT}&prefix={}",
        uri_encode(prefix, false)
    );
    let response = send(
        http,
        storage,
        Call {
            method: Method::GET,
            query: &query,
            path: format!("/{}", uri_encode(&storage.bucket, false)),
            headers: &[],
            body: Vec::new(),
        },
    )
    .await?;

    if !response.status().is_success() {
        return Err(StorageError::Refused(response.status().as_u16()));
    }
    let text = response
        .text()
        .await
        .map_err(|_| StorageError::Unreachable)?;

    parse_listing(&text).ok_or(StorageError::Unreadable)
}

/// The text between `<name>` and `</name>`, when it is there.
fn element<'a>(xml: &'a str, name: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{name}>"))? + name.len() + 2;
    let end = xml[start..].find(&format!("</{name}>"))? + start;

    Some(&xml[start..end])
}

/// The keys and sizes of a `ListObjectsV2` answer. `None` when it is not one.
fn parse_listing(xml: &str) -> Option<Vec<StoredObject>> {
    if !xml.contains("<ListBucketResult") {
        return None;
    }

    let mut objects = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find("<Contents>") {
        let block = &rest[start..];
        let end = block.find("</Contents>")?;
        let contents = &block[..end];
        objects.push(StoredObject {
            key: element(contents, "Key")?.to_owned(),
            size: element(contents, "Size")?.parse().ok()?,
        });
        rest = &block[end..];
    }

    Some(objects)
}

#[cfg(test)]
pub(crate) mod tests;
