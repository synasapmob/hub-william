//! Reviewed public metadata shared with the frontend, installers and docs.
//! Availability still comes from the authenticated provider/account discovery.

use std::{collections::BTreeMap, sync::OnceLock};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::ToSchema;

pub use crate::provider_catalogue_generated::AgentProvider;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ModelCapability {
    Chat,
    ImageInput,
    RealtimeAudio,
    Transcription,
    SpeechOutput,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CallKind {
    NativeRealtime,
    LocalSttLlmTts,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum CallTransport {
    CodexV3Webrtc,
    GroqSse,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize, ToSchema)]
pub struct CallProfile {
    pub id: String,
    pub provider: AgentProvider,
    pub name: String,
    pub kind: CallKind,
    pub transport: CallTransport,
    pub selector_model: String,
    pub availability: String,
    pub models: BTreeMap<String, String>,
}

#[derive(Deserialize)]
pub(crate) struct ModelDefinition {
    pub id: String,
    pub name: String,
    pub status: String,
    pub capabilities: Vec<ModelCapability>,
    #[serde(default)]
    pub reasoning_efforts: Vec<String>,
}

#[derive(Deserialize)]
pub(crate) struct DiscoveryDefinition {
    pub strategy: String,
    pub docs_url: String,
}

#[derive(Deserialize)]
pub(crate) struct GatewayDefinition {
    pub owned_by: String,
}

#[derive(Deserialize)]
pub(crate) struct ProviderDefinition {
    pub id: AgentProvider,
    pub label: String,
    pub usage_metrics: bool,
    pub chat_capabilities: Vec<ModelCapability>,
    pub discovery: DiscoveryDefinition,
    pub gateway: GatewayDefinition,
    pub models: Vec<ModelDefinition>,
}

#[derive(Deserialize)]
struct Catalogue {
    schema_version: u32,
    providers: Vec<ProviderDefinition>,
    call_profiles: Vec<CallProfile>,
}

fn catalogue() -> &'static Catalogue {
    static CATALOGUE: OnceLock<Catalogue> = OnceLock::new();
    CATALOGUE.get_or_init(|| {
        let catalogue: Catalogue = serde_json::from_str(include_str!("provider_catalogue.json"))
            .expect("validated, embedded provider catalogue");
        assert_eq!(catalogue.schema_version, 1, "unsupported catalogue schema");
        catalogue
    })
}

pub(crate) fn provider(id: AgentProvider) -> &'static ProviderDefinition {
    catalogue()
        .providers
        .iter()
        .find(|definition| definition.id == id)
        .expect("generated provider exists in the catalogue")
}

impl ProviderDefinition {
    pub(crate) fn chat_models(&self) -> impl Iterator<Item = &ModelDefinition> {
        self.models.iter().filter(|model| {
            model.status != "deprecated" && model.capabilities.contains(&ModelCapability::Chat)
        })
    }

    pub(crate) fn capabilities(&self, id: &str) -> Vec<ModelCapability> {
        self.models
            .iter()
            .find(|model| model.id == id)
            .map(|model| &model.capabilities)
            // New current IDs from live official documentation retain the existing
            // integration's accepted inputs; this does not claim new upstream features.
            .unwrap_or(&self.chat_capabilities)
            .clone()
    }
}

pub(crate) fn current_chat_model(provider_id: AgentProvider, id: &str) -> bool {
    provider(provider_id)
        .chat_models()
        .any(|model| model.id == id)
}

pub(crate) fn effort_capability(efforts: &[String]) -> Value {
    let mut value = json!({ "supported": true });
    for effort in efforts {
        value[effort] = json!({ "supported": true });
    }
    value
}

pub(crate) fn default_model_catalogue(provider_id: AgentProvider) -> Value {
    let definition = provider(provider_id);
    let data = definition
        .chat_models()
        .map(|model| {
            let mut entry = json!({"id": model.id});
            if provider_id == AgentProvider::Claude {
                entry["display_name"] = json!(model.name);
            } else {
                entry["name"] = json!(model.name);
                entry["object"] = json!("model");
                entry["owned_by"] = json!(definition.gateway.owned_by);
            }
            if !model.reasoning_efforts.is_empty() {
                entry["capabilities"] =
                    json!({"effort": effort_capability(&model.reasoning_efforts)});
            }
            entry
        })
        .collect::<Vec<_>>();
    json!({"object": "list", "data": data})
}

pub(crate) fn call_profiles(
    provider_id: AgentProvider,
) -> impl Iterator<Item = &'static CallProfile> {
    catalogue()
        .call_profiles
        .iter()
        .filter(move |call| call.provider == provider_id)
}

pub(crate) fn call_profile(
    provider_id: AgentProvider,
    model: &str,
) -> Option<&'static CallProfile> {
    call_profiles(provider_id).find(|call| call.selector_model == model)
}

pub(crate) fn call_available(call: &CallProfile, live: &Value, has_chat_models: bool) -> bool {
    match call.availability.as_str() {
        "chat_catalogue" => has_chat_models,
        "all_dependencies" => live
            .get("data")
            .and_then(Value::as_array)
            .is_some_and(|models| {
                call.models.values().all(|id| {
                    models
                        .iter()
                        .any(|model| model["id"] == *id && model["active"] != false)
                })
            }),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_generated_providers_have_exactly_one_definition() {
        assert_eq!(catalogue().providers.len(), AgentProvider::ALL.len());
        for id in AgentProvider::ALL {
            assert_eq!(
                catalogue().providers.iter().filter(|p| p.id == id).count(),
                1
            );
            assert!(!provider(id).label.is_empty());
        }
    }

    #[test]
    fn coding_catalogues_exclude_audio_models_and_keep_preview_chat() {
        for id in AgentProvider::ALL {
            let list = default_model_catalogue(id);
            for model in list["data"].as_array().unwrap() {
                assert!(
                    provider(id)
                        .capabilities(model["id"].as_str().unwrap())
                        .contains(&ModelCapability::Chat)
                );
            }
        }
        assert!(!current_chat_model(
            AgentProvider::Groq,
            "whisper-large-v3-turbo"
        ));
        assert!(!current_chat_model(
            AgentProvider::Chatgpt,
            "gpt-live-1-codex"
        ));
        assert!(current_chat_model(AgentProvider::Groq, "qwen/qwen3.8-27b"));
    }

    #[test]
    fn composed_call_requires_each_active_component() {
        let call = call_profiles(AgentProvider::Groq).next().unwrap();
        let full =
            json!({"data": call.models.values().map(|id| json!({"id": id})).collect::<Vec<_>>()});
        assert!(call_available(call, &full, false));
        for index in 0..call.models.len() {
            let mut missing = full.clone();
            missing["data"].as_array_mut().unwrap().remove(index);
            assert!(!call_available(call, &missing, true));
            let mut inactive = full.clone();
            inactive["data"][index]["active"] = json!(false);
            assert!(!call_available(call, &inactive, true));
        }
    }

    #[test]
    fn native_call_preserves_its_separate_account_availability_gate() {
        let call = call_profiles(AgentProvider::Chatgpt).next().unwrap();
        assert_eq!(call.kind, CallKind::NativeRealtime);
        assert!(!call_available(call, &json!({}), false));
        assert!(call_available(call, &json!({}), true));
    }
}
