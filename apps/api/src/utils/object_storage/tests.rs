use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
};

use axum::{
    Router,
    body::{Body, to_bytes},
    extract::State,
    http::{Request, StatusCode},
    response::{IntoResponse, Response},
};
use chrono::{NaiveDateTime, TimeZone, Utc};
use tokio::net::TcpListener;

use crate::core::IconStorage;

use super::{
    StorageError, StoredObject, authorization, list_objects, parse_listing, put_object, sha256_hex,
    uri_encode,
};

const ACCESS_KEY_ID: &str = "test-access-key-id";
const SECRET_ACCESS_KEY: &str = "test-secret-access-key";
pub(crate) const BUCKET: &str = "icons-test";
const EMPTY_SHA256: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/// What the fake keeps of an object: its type, its `Cache-Control`, its bytes.
pub(crate) type Stored = (String, String, Vec<u8>);

/// A bucket on this machine that behaves as far as the S3 API goes for what the
/// dashboard asks of R2: it keeps what is put in, lists it by prefix, and refuses
/// a request whose signature is not the one it works out itself.
#[derive(Clone)]
pub(crate) struct FakeBucket {
    objects: Arc<Mutex<BTreeMap<String, Stored>>>,
    refusal: Arc<Mutex<Option<StatusCode>>>,
}

impl FakeBucket {
    pub(crate) async fn start() -> (Self, IconStorage) {
        let bucket = Self {
            objects: Arc::default(),
            refusal: Arc::default(),
        };
        let app = Router::new().fallback(handle).with_state(bucket.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();

        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (bucket, storage_at(&format!("http://{address}")))
    }

    pub(crate) fn keys(&self) -> Vec<String> {
        self.objects.lock().unwrap().keys().cloned().collect()
    }

    pub(crate) fn object(&self, key: &str) -> Option<Stored> {
        self.objects.lock().unwrap().get(key).cloned()
    }

    /// Answers every request that follows with this status and keeps nothing.
    pub(crate) fn refuse_with(&self, status: StatusCode) {
        *self.refusal.lock().unwrap() = Some(status);
    }
}

pub(crate) fn storage_at(endpoint: &str) -> IconStorage {
    IconStorage {
        account_id: "0123abcd".to_owned(),
        access_key_id: ACCESS_KEY_ID.to_owned(),
        secret_access_key: SECRET_ACCESS_KEY.to_owned(),
        bucket: BUCKET.to_owned(),
        public_url: "https://cdn.test".to_owned(),
        endpoint: endpoint.to_owned(),
    }
}

async fn handle(State(bucket): State<FakeBucket>, request: Request<Body>) -> Response {
    if let Some(status) = *bucket.refusal.lock().unwrap() {
        return status.into_response();
    }

    let (parts, body) = request.into_parts();
    let body = to_bytes(body, usize::MAX).await.unwrap().to_vec();
    let header = |name: &str| {
        parts
            .headers
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };

    // Work out the signature from what arrived and compare it with the one sent.
    let (Some(sent), Some(date), Some(hash)) = (
        header("authorization"),
        header("x-amz-date"),
        header("x-amz-content-sha256"),
    ) else {
        return StatusCode::FORBIDDEN.into_response();
    };
    let signed_names = sent
        .split("SignedHeaders=")
        .nth(1)
        .and_then(|rest| rest.split(',').next())
        .unwrap_or_default();
    let signed: Vec<(String, String)> = signed_names
        .split(';')
        .map(|name| (name.to_owned(), header(name).unwrap_or_default()))
        .collect();
    let signed: Vec<(&str, &str)> = signed
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_str()))
        .collect();
    let now =
        Utc.from_utc_datetime(&NaiveDateTime::parse_from_str(&date, "%Y%m%dT%H%M%SZ").unwrap());
    let expected = authorization(
        ACCESS_KEY_ID,
        SECRET_ACCESS_KEY,
        "auto",
        "s3",
        parts.method.as_str(),
        parts.uri.path(),
        parts.uri.query().unwrap_or(""),
        &signed,
        &hash,
        now,
    );
    if sent != expected || hash != sha256_hex(&body) {
        return StatusCode::FORBIDDEN.into_response();
    }

    let path = parts.uri.path();
    let Some(key) = path.strip_prefix(&format!("/{BUCKET}/")) else {
        return list(&bucket, parts.uri.query().unwrap_or(""));
    };
    bucket.objects.lock().unwrap().insert(
        key.to_owned(),
        (
            header("content-type").unwrap_or_default(),
            header("cache-control").unwrap_or_default(),
            body,
        ),
    );

    StatusCode::OK.into_response()
}

fn list(bucket: &FakeBucket, query: &str) -> Response {
    let prefix = query
        .split('&')
        .find_map(|pair| pair.strip_prefix("prefix="))
        .unwrap_or_default()
        .replace("%2F", "/");
    let contents: String = bucket
        .objects
        .lock()
        .unwrap()
        .iter()
        .filter(|(key, _)| key.starts_with(&prefix))
        .map(|(key, (_, _, bytes))| {
            format!(
                "<Contents><Key>{key}</Key><LastModified>2026-11-13T00:00:00.000Z</LastModified><Size>{}</Size></Contents>",
                bytes.len()
            )
        })
        .collect();

    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult xmlns=\"http://s3.amazonaws.com/doc/2006-03-01/\"><Name>{BUCKET}</Name><IsTruncated>false</IsTruncated>{contents}</ListBucketResult>"
    )
    .into_response()
}

/// The worked example in Amazon's documentation of Signature Version 4 ("GET
/// Object" with a `Range` header): a signature this code and nobody's memory made.
#[test]
fn a_request_is_signed_as_amazons_own_example_is() {
    let now = Utc.with_ymd_and_hms(2013, 5, 24, 0, 0, 0).unwrap();
    let sent = authorization(
        "AKIAIOSFODNN7EXAMPLE",
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        "us-east-1",
        "s3",
        "GET",
        "/test.txt",
        "",
        &[
            ("host", "examplebucket.s3.amazonaws.com"),
            ("range", "bytes=0-9"),
            ("x-amz-content-sha256", EMPTY_SHA256),
            ("x-amz-date", "20130524T000000Z"),
        ],
        EMPTY_SHA256,
        now,
    );

    assert_eq!(
        sent,
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
}

#[test]
fn only_the_unreserved_characters_stay_as_they_are() {
    assert_eq!(uri_encode("icons/a b+c.png", true), "icons/a%20b%2Bc.png");
    assert_eq!(uri_encode("icons/", false), "icons%2F");
    assert_eq!(uri_encode("A-z_0.9~", false), "A-z_0.9~");
}

#[test]
fn a_listing_gives_its_keys_and_sizes() {
    let xml = "<ListBucketResult><Name>b</Name><Contents><Key>icons/a.png</Key><Size>12</Size></Contents><Contents><Key>icons/b.webp</Key><Size>7</Size></Contents></ListBucketResult>";

    assert_eq!(
        parse_listing(xml),
        Some(vec![
            StoredObject {
                key: "icons/a.png".to_owned(),
                size: 12
            },
            StoredObject {
                key: "icons/b.webp".to_owned(),
                size: 7
            },
        ])
    );
    assert_eq!(
        parse_listing("<ListBucketResult><Name>b</Name></ListBucketResult>"),
        Some(Vec::new())
    );
}

#[test]
fn something_that_is_not_a_listing_is_not_read_as_one() {
    assert_eq!(parse_listing("<html>nope</html>"), None);
    assert_eq!(
        parse_listing("<ListBucketResult><Contents><Key>x</Key></Contents></ListBucketResult>"),
        None
    );
}

#[tokio::test]
async fn what_is_put_comes_back_in_a_listing_with_its_headers_kept() {
    let (bucket, storage) = FakeBucket::start().await;
    let http = reqwest::Client::new();

    put_object(
        &http,
        &storage,
        "icons/claude-1a2b3c4d.png",
        "image/png",
        "public, max-age=31536000, immutable",
        b"png bytes".to_vec(),
    )
    .await
    .unwrap();
    put_object(
        &http,
        &storage,
        "other/x.png",
        "image/png",
        "no-cache",
        vec![1],
    )
    .await
    .unwrap();

    let (content_type, cache_control, bytes) = bucket.object("icons/claude-1a2b3c4d.png").unwrap();
    assert_eq!(content_type, "image/png");
    assert_eq!(cache_control, "public, max-age=31536000, immutable");
    assert_eq!(bytes, b"png bytes");

    assert_eq!(
        list_objects(&http, &storage, "icons/").await.unwrap(),
        [StoredObject {
            key: "icons/claude-1a2b3c4d.png".to_owned(),
            size: 9
        }]
    );
}

#[tokio::test]
async fn a_request_signed_with_the_wrong_secret_is_refused() {
    let (bucket, mut storage) = FakeBucket::start().await;
    storage.secret_access_key = "another-secret".to_owned();

    let result = put_object(
        &reqwest::Client::new(),
        &storage,
        "icons/a.png",
        "image/png",
        "no-cache",
        vec![1],
    )
    .await;

    assert!(matches!(result, Err(StorageError::Refused(403))));
    assert!(bucket.keys().is_empty());
}

#[tokio::test]
async fn a_bucket_that_is_down_is_an_error_and_not_a_hang() {
    // Nothing listens on port 9 of this machine.
    let result = list_objects(
        &reqwest::Client::new(),
        &storage_at("http://127.0.0.1:9"),
        "icons/",
    )
    .await;

    assert!(matches!(result, Err(StorageError::Unreachable)));
}

#[tokio::test]
async fn a_refusal_carries_the_status_and_nothing_the_bucket_said() {
    let (bucket, storage) = FakeBucket::start().await;
    bucket.refuse_with(StatusCode::SERVICE_UNAVAILABLE);

    let error = list_objects(&reqwest::Client::new(), &storage, "icons/")
        .await
        .unwrap_err();

    assert_eq!(error.to_string(), "the bucket answered 503");
}
