//! Encrypting stored credentials and reading claims from provider tokens.

use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Duration, Utc};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::core::ApiError;

pub(super) fn access_token_fingerprint(access_token: &str) -> [u8; 32] {
    Sha256::digest(access_token.as_bytes()).into()
}

/// A provider-reported lifetime. Providers may omit the field, or answer with a
/// non-positive value that means "not reported"; storing that as `now` would
/// expire a healthy credential and mark its account for reconnect.
pub(super) fn provider_expiry_at(token: &Value, field: &str) -> Option<DateTime<Utc>> {
    token
        .get(field)
        .and_then(Value::as_i64)
        .filter(|seconds| *seconds > 0)
        .map(|seconds| Utc::now() + Duration::seconds(seconds))
}

pub(super) fn merge_token_response(mut stored: Value, refreshed: Value) -> Value {
    let Some(stored_object) = stored.as_object_mut() else {
        return refreshed;
    };
    let Some(refreshed_object) = refreshed.as_object() else {
        return refreshed;
    };
    for (key, value) in refreshed_object {
        stored_object.insert(key.clone(), value.clone());
    }
    stored
}

pub(super) fn encrypt_json<T: Serialize>(
    key: &[u8; 32],
    value: &T,
) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let mut nonce_bytes = [0_u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let plaintext = serde_json::to_vec(value).map_err(|_| ApiError::Internal)?;
    let ciphertext = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_ref())
        .map_err(|_| ApiError::Internal)?;
    Ok((ciphertext, nonce_bytes.to_vec()))
}

pub(super) fn decrypt_json<T: for<'de> Deserialize<'de>>(
    key: &[u8; 32],
    ciphertext: &[u8],
    nonce: &[u8],
) -> Result<T, ApiError> {
    if nonce.len() != 12 {
        return Err(ApiError::Internal);
    }
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|_| ApiError::Internal)?;
    let plaintext = cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| ApiError::Internal)?;
    serde_json::from_slice(&plaintext).map_err(|_| ApiError::Internal)
}

pub(super) fn random_url_token(bytes: usize) -> String {
    let mut random = vec![0_u8; bytes];
    rand::rngs::OsRng.fill_bytes(&mut random);
    URL_SAFE_NO_PAD.encode(random)
}

fn decoded_token_claims(encoded_token: &str) -> Option<Value> {
    let encoded = encoded_token.split('.').nth(1)?;
    let decoded = URL_SAFE_NO_PAD.decode(encoded).ok()?;
    serde_json::from_slice(&decoded).ok()
}

pub(super) fn token_claims(token: &Value) -> Option<Value> {
    ["id_token", "access_token"]
        .into_iter()
        .find_map(|field| decoded_token_claims(token.get(field)?.as_str()?))
}

pub(super) fn token_claim(token: &Value, claim: &str) -> Option<Value> {
    ["access_token", "id_token"].into_iter().find_map(|field| {
        decoded_token_claims(token.get(field)?.as_str()?)?
            .get(claim)
            .cloned()
    })
}
