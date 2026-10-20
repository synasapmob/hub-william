//! Shared leaf modules: no endpoints, depend on `core` only and never on `api`.
//!
//! A helper belongs here only when every caller wants exactly the same behavior.
//! Look-alikes that differ (each feature's text normalisation, upstream error
//! wording) stay in their feature rather than gaining flags here.

mod database;
pub(crate) mod provider_catalogue;
pub(crate) mod reel;
pub(crate) mod tts;

pub(crate) use database::database_error;
