import catalogue, {
  type ApiKeyProviderId,
  type CatalogueCallProfile,
  type CatalogueProvider,
  type ProviderId,
  type ProviderLabel,
} from "./provider-catalogue.generated";

export const playgroundModes = ["chat", "call-live", "call-whisper"] as const;
export type PlaygroundMode = (typeof playgroundModes)[number];
const callModes: Record<
  CatalogueCallProfile["kind"],
  Exclude<PlaygroundMode, "chat">
> = {
  native_realtime: "call-live",
  local_stt_llm_tts: "call-whisper",
};

const providers = Object.fromEntries(
  catalogue.providers.map((provider) => [provider.id, provider]),
) as Record<ProviderId, CatalogueProvider>;

function list(surface: keyof typeof catalogue.surfaces) {
  return catalogue.surfaces[surface].map((id) => providers[id]);
}

function byLabel(label: ProviderLabel) {
  return catalogue.providers.find((provider) => provider.label === label)!;
}

function byIdOrLabel(value: ProviderId | ProviderLabel) {
  return catalogue.providers.find(
    (provider) => provider.id === value || provider.label === value,
  )!;
}

function isApiKeyProvider(id: ProviderId): id is ApiKeyProviderId {
  return providers[id].auth.kind === "api_key";
}

function callProfile(provider: ProviderId, model?: string) {
  return catalogue.call_profiles.find(
    (profile) =>
      profile.provider === provider && profile.selector_model === model,
  );
}

function callMode(profile: CatalogueCallProfile) {
  return callModes[profile.kind];
}

function supportsMode(provider: ProviderId, mode: PlaygroundMode | "voice") {
  return mode === "chat" || mode === "call-whisper" || mode === "voice"
    ? providers[provider].chat_capabilities.includes("chat")
    : catalogue.call_profiles.some(
        (profile) =>
          profile.provider === provider && callMode(profile) === mode,
      );
}

const providerCatalogueService = {
  byId: (id: ProviderId) => providers[id],
  byLabel,
  byIdOrLabel,
  callMode,
  callProfile,
  isApiKeyProvider,
  list,
  supportsMode,
};

export default providerCatalogueService;
