import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type { CreatedGatewayKey, GatewayKey } from "./gateway-keys-types";

type ApiGatewayKey = components["schemas"]["GatewayKey"];
type ApiCreatedGatewayKey = components["schemas"]["CreatedGatewayKey"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const GATEWAY_KEYS_UNAVAILABLE = "The gateway key service is unavailable.";

export class GatewayKeyServiceError extends Error {}

function gatewayKeyFromApi(key: ApiGatewayKey): GatewayKey {
  return {
    createdAt: key.created_at,
    id: key.id,
    lastFour: key.last_four,
    lastUsedAt: key.last_used_at ?? null,
  };
}

function createdGatewayKeyFromApi(
  key: ApiCreatedGatewayKey,
): CreatedGatewayKey {
  return { ...gatewayKeyFromApi(key), key: key.key };
}

function gatewayKeyError(error?: ErrorResponse) {
  return new GatewayKeyServiceError(
    error?.message ?? "The gateway key request could not be completed.",
  );
}

class GatewayKeysService {
  readonly baseUrl: string;

  readonly queryKey = ["gateway-keys"] as const;

  private readonly client: Client<paths>;

  constructor() {
    this.baseUrl = (
      import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
    ).replace(/\/$/, "");

    this.client = createClient<paths>({
      baseUrl: this.baseUrl,
      credentials: "include",
      fetch: (...args) => globalThis.fetch(...args),
    });
  }

  private async refreshSession() {
    const { data } = await this.client.POST("/auth/refresh");

    return Boolean(data);
  }

  /**
   * Run an API call and repeat it once when the Hub session had expired and
   * could be refreshed.
   */
  private async request<T extends { response: Response }>(
    call: () => Promise<T>,
  ): Promise<T> {
    const result = await call();

    if (result.response.status === 401 && (await this.refreshSession()))
      return call();

    return result;
  }

  /**
   * Let service errors through and replace any other failure, such as a
   * network error, with the unavailable message.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof GatewayKeyServiceError) throw error;

      throw new GatewayKeyServiceError(GATEWAY_KEYS_UNAVAILABLE);
    }
  }

  /**
   * Create a gateway key. The full key is only returned here.
   */
  async create(): Promise<CreatedGatewayKey> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.POST("/gateway-keys"),
      );

      if (!result.data) throw gatewayKeyError(result.error);

      return createdGatewayKeyFromApi(result.data);
    });
  }

  /**
   * List the signed-in user's gateway keys
   */
  async list(): Promise<GatewayKey[]> {
    return this.guard(async () => {
      const result = await this.request(() => this.client.GET("/gateway-keys"));

      if (!result.data) throw gatewayKeyError(result.error);

      return result.data.map(gatewayKeyFromApi);
    });
  }

  /**
   * Revoke a gateway key
   */
  async revoke(keyId: string): Promise<void> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.DELETE("/gateway-keys/{key_id}", {
          params: { path: { key_id: keyId } },
        }),
      );

      if (result.error) throw gatewayKeyError(result.error);
    });
  }
}

export const gatewayKeysService = new GatewayKeysService();
