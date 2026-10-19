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

class ProviderCatalogueService {
  /**
   * List the providers offered on a surface, in catalogue order
   */
  list(surface: keyof typeof catalogue.surfaces) {
    return catalogue.surfaces[surface].map((id) => providers[id]);
  }

  /**
   * Get a provider by its id
   */
  byId(id: ProviderId) {
    return providers[id];
  }

  /**
   * Get a provider by its display label
   */
  byLabel(label: ProviderLabel) {
    return catalogue.providers.find((provider) => provider.label === label)!;
  }

  /**
   * Get a provider by either its id or its display label
   */
  byIdOrLabel(value: ProviderId | ProviderLabel) {
    return catalogue.providers.find(
      (provider) => provider.id === value || provider.label === value,
    )!;
  }

  /**
   * Whether a provider authenticates with an API key
   */
  isApiKeyProvider(id: ProviderId): id is ApiKeyProviderId {
    return providers[id].auth.kind === "api_key";
  }

  /**
   * Find the call profile of a provider, optionally for one selector model
   */
  callProfile(provider: ProviderId, model?: string) {
    return catalogue.call_profiles.find(
      (profile) =>
        profile.provider === provider && profile.selector_model === model,
    );
  }

  /**
   * Playground call mode a call profile runs in
   */
  callMode(profile: CatalogueCallProfile) {
    return callModes[profile.kind];
  }

  /**
   * Whether a provider can run the given playground mode
   */
  supportsMode(provider: ProviderId, mode: PlaygroundMode | "voice") {
    return mode === "chat" || mode === "call-whisper" || mode === "voice"
      ? providers[provider].chat_capabilities.includes("chat")
      : catalogue.call_profiles.some(
          (profile) =>
            profile.provider === provider && this.callMode(profile) === mode,
        );
  }
}

export const providerCatalogueService = new ProviderCatalogueService();
