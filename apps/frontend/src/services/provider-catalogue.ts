import catalogue, {
  type ApiKeyProviderId,
  type CatalogueProvider,
  type ProviderId,
  type ProviderLabel,
} from "./provider-catalogue.generated";

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

function supportsMode(provider: ProviderId, mode: "chat" | "voice") {
  return mode === "chat"
    ? providers[provider].chat_capabilities.includes("chat")
    : catalogue.call_profiles.some((profile) => profile.provider === provider);
}

const providerCatalogueService = {
  byId: (id: ProviderId) => providers[id],
  byLabel,
  byIdOrLabel,
  callProfile,
  isApiKeyProvider,
  list,
  supportsMode,
};

export default providerCatalogueService;
