use crate::core::ApiError;

/// Log a failed database operation under the owning feature's `scope` and answer
/// with an internal error. Callers wrap it once per feature so every log line
/// keeps naming the feature that failed.
pub(crate) fn database_error(scope: &str, error: sqlx::Error) -> ApiError {
    eprintln!("{scope} database operation failed: {error}");
    ApiError::Internal
}
