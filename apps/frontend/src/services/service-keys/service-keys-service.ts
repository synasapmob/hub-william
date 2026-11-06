import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type { CreatedServiceKey, ServiceKey } from "./service-keys-types";

type ApiKey = components["schemas"]["GatewayKey"];
type ApiCreatedKey = components["schemas"]["CreatedGatewayKey"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const SERVICE_KEYS_UNAVAILABLE = "The service key service is unavailable.";

export class ServiceKeysError extends Error {}

function keyFromApi(key: ApiKey): ServiceKey {
  return {
    createdAt: key.created_at,
    id: key.id,
    lastFour: key.last_four,
    lastUsedAt: key.last_used_at ?? null,
  };
}

function keyError(error?: ErrorResponse) {
  return new ServiceKeysError(
    error?.message ?? "The service key request could not be completed.",
  );
}

class ServiceKeysService {
  readonly baseUrl: string;

  readonly queryKey = ["service-keys"] as const;

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
      if (error instanceof ServiceKeysError) throw error;

      throw new ServiceKeysError(SERVICE_KEYS_UNAVAILABLE);
    }
  }

  /**
   * Create a service key. The whole key is returned only here.
   */
  async create(): Promise<CreatedServiceKey> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.POST("/service/keys"),
      );

      if (!result.data) throw keyError(result.error);

      const created: ApiCreatedKey = result.data;

      return { ...keyFromApi(created), key: created.key };
    });
  }

  /**
   * The signed-in user's active service keys, newest first.
   */
  async list(): Promise<ServiceKey[]> {
    return this.guard(async () => {
      const result = await this.request(() => this.client.GET("/service/keys"));

      if (!result.data) throw keyError(result.error);

      return result.data.map(keyFromApi);
    });
  }

  /**
   * Revoke a service key; a request that presents it is refused from then on.
   */
  async revoke(keyId: string): Promise<void> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.DELETE("/service/keys/{key_id}", {
          params: { path: { key_id: keyId } },
        }),
      );

      if (result.error) throw keyError(result.error);
    });
  }
}

export const serviceKeysService = new ServiceKeysService();
