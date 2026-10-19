import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import { providerCatalogueService } from "@/services/provider-catalogue/provider-catalogue-service";
import type { ApiKeyProviderId } from "@/services/provider-catalogue/provider-catalogue.generated";
import type {
  AgentConnection,
  AgentPool,
  AgentPoolJoinInput,
  AgentPoolJoinRequest,
  AgentPoolPerson,
  AgentPoolRequestStatus,
  AgentPoolShareEvidence,
  AgentProvider,
  AgentProviderId,
} from "./agent-types";

type ApiAgentConnection = components["schemas"]["AgentConnection"];
type ApiAgentPool = components["schemas"]["AgentPool"];
type ApiAgentPoolPerson = components["schemas"]["AgentPoolPerson"];
type ApiAgentPoolJoinRequest = components["schemas"]["AgentPoolJoinRequest"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const CONNECTION_UNAVAILABLE =
  "The provider connection service is unavailable.";
const POOL_UNAVAILABLE = "The account pool service is unavailable.";

export class AgentServiceError extends Error {}

function connectionError(error?: ErrorResponse) {
  return new AgentServiceError(
    error?.message ?? "The provider connection could not be completed.",
  );
}

function poolError(error?: ErrorResponse) {
  return new AgentServiceError(
    error?.message ?? "The account pools could not be loaded.",
  );
}

function connectionFromApi(connection: ApiAgentConnection): AgentConnection {
  return {
    accountLabel: connection.account_label ?? null,
    availabilityStatus: connection.availability_status,
    authorization: connection.authorization
      ? {
          authorizationUrl: connection.authorization.authorization_url,
          expiresAt: connection.authorization.expires_at,
          pollAfterSeconds: connection.authorization.poll_after_seconds,
          requiresCallbackUrl: connection.authorization.requires_callback_url,
          userCode: connection.authorization.user_code ?? null,
        }
      : null,
    createdAt: connection.created_at,
    failureMessage: connection.failure_message ?? null,
    id: connection.id,
    plan: connection.plan ?? null,
    provider: connection.provider,
    status: connection.status,
    updatedAt: connection.updated_at,
    validationUrl: connection.validation_url ?? null,
  };
}

function shareFromApi(
  share: ApiAgentPoolPerson["share"],
): AgentPoolShareEvidence {
  return {
    availablePercent: share.available_percent,
    budgetUnits: share.budget_units ?? undefined,
    capUnits: share.cap_units ?? undefined,
    failOpenReason: share.fail_open_reason ?? undefined,
    memberCount: share.member_count,
    poolCachedTokens: share.pool_cached_tokens,
    poolInputTokens: share.pool_input_tokens,
    poolOutputTokens: share.pool_output_tokens,
    poolUnits: share.pool_units,
    providerUsedPercent: share.provider_used_percent ?? undefined,
    remainingUnits: share.remaining_units ?? undefined,
    userCachedTokens: share.user_cached_tokens,
    userInputTokens: share.user_input_tokens,
    userOutputTokens: share.user_output_tokens,
    userUnits: share.user_units,
    windowLabel: share.window_label ?? undefined,
  };
}

function personFromApi(person: ApiAgentPoolPerson): AgentPoolPerson {
  return {
    avatarLabel: person.avatar_label,
    joinedAt: person.joined_at,
    share: shareFromApi(person.share),
    usageAvailablePercent: person.usage_available_percent,
    username: person.username,
  };
}

function requestFromApi(
  request: ApiAgentPoolJoinRequest,
): AgentPoolJoinRequest {
  return {
    avatarLabel: request.avatar_label,
    id: request.id,
    reason: request.reason,
    status: request.status,
    telegram: request.telegram,
    username: request.username,
  };
}

function poolFromApi(pool: ApiAgentPool): AgentPool {
  return {
    accountLabel: pool.account_label,
    agent: pool.agent as AgentProvider,
    availability: {
      retryAt: pool.availability.retry_at ?? undefined,
      status: pool.availability.status,
      validationUrl: pool.availability.validation_url ?? undefined,
    },
    capacity: pool.capacity,
    createdAt: pool.created_at,
    id: pool.id,
    members: pool.members.map(personFromApi),
    owner: personFromApi(pool.owner),
    plan: pool.plan,
    requests: pool.requests.map(requestFromApi),
    usage: pool.usage.map((metric) => ({
      detail: metric.detail ?? undefined,
      label: metric.label,
      value: metric.value,
    })),
  };
}

class AgentService {
  readonly baseUrl: string;

  readonly connectionsQueryKey = ["agent-connections"] as const;

  readonly poolsQueryKey = ["agent-pools"] as const;

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
   * network error, with `message`.
   */
  private async guard<T>(message: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AgentServiceError) throw error;

      throw new AgentServiceError(message);
    }
  }

  /**
   * List the connections owned by the signed-in user
   */
  async listConnections(): Promise<AgentConnection[]> {
    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.GET("/agent-connections"),
      );

      if (!result.data) throw connectionError(result.error);

      return result.data.map(connectionFromApi);
    });
  }

  /**
   * Get one connection, including its authorization prompt while pending
   */
  async getConnection(connectionId: string): Promise<AgentConnection> {
    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.GET("/agent-connections/{connection_id}", {
          params: { path: { connection_id: connectionId } },
        }),
      );

      if (!result.data) throw connectionError(result.error);

      return connectionFromApi(result.data);
    });
  }

  /**
   * Start an authorization flow for a provider
   */
  async startConnection(provider: AgentProviderId): Promise<AgentConnection> {
    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-connections/start", { body: { provider } }),
      );

      if (!result.data) throw connectionError(result.error);

      return connectionFromApi(result.data);
    });
  }

  /**
   * Connect a provider that authenticates with an API key
   */
  async connectApiKey(
    provider: ApiKeyProviderId,
    apiKey: string,
  ): Promise<AgentConnection> {
    const path = providerCatalogueService.byId(provider).auth.connect_path;

    if (!path)
      throw new AgentServiceError("This provider does not accept API keys.");

    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.POST(path, { body: { api_key: apiKey } }),
      );

      if (!result.data) throw connectionError(result.error);

      return connectionFromApi(result.data);
    });
  }

  /**
   * Finish an authorization flow with the callback URL the provider returned
   */
  async completeConnection(
    connectionId: string,
    callbackUrl: string,
  ): Promise<AgentConnection> {
    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-connections/{connection_id}/complete", {
          body: { callback_url: callbackUrl },
          params: { path: { connection_id: connectionId } },
        }),
      );

      if (!result.data) throw connectionError(result.error);

      return connectionFromApi(result.data);
    });
  }

  /**
   * Refresh the stored credential of a connection
   */
  async refreshConnection(connectionId: string): Promise<AgentConnection> {
    return this.guard(
      "The provider credential could not be refreshed.",
      async () => {
        const result = await this.request(() =>
          this.client.POST("/agent-connections/{connection_id}/refresh", {
            params: { path: { connection_id: connectionId } },
          }),
        );

        if (!result.data) throw connectionError(result.error);

        return connectionFromApi(result.data);
      },
    );
  }

  /**
   * Use a reset credit on a connection
   */
  async resetCredits(connectionId: string): Promise<void> {
    return this.guard("The reset credit could not be used.", async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-connections/{connection_id}/reset-credits", {
          params: { path: { connection_id: connectionId } },
        }),
      );

      if (!result.response.ok) throw connectionError(result.error);
    });
  }

  /**
   * Remove a connection
   */
  async disconnect(connectionId: string): Promise<void> {
    return this.guard(CONNECTION_UNAVAILABLE, async () => {
      const result = await this.request(() =>
        this.client.DELETE("/agent-connections/{connection_id}", {
          params: { path: { connection_id: connectionId } },
        }),
      );

      if (result.error) throw connectionError(result.error);
    });
  }

  /**
   * List the pools the signed-in user owns or belongs to
   */
  async listPools(): Promise<AgentPool[]> {
    return this.guard(POOL_UNAVAILABLE, async () => {
      const result = await this.client.GET("/agent-pools");

      if (!result.data) throw poolError(result.error);

      return result.data.map(poolFromApi);
    });
  }

  /**
   * Ask to join a pool
   */
  async requestJoin(
    poolId: string,
    values: AgentPoolJoinInput,
  ): Promise<AgentPoolJoinRequest> {
    return this.guard("The join request could not be sent.", async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-pools/{connection_id}/requests", {
          body: values,
          params: { path: { connection_id: poolId } },
        }),
      );

      if (!result.data) throw poolError(result.error);

      return requestFromApi(result.data);
    });
  }

  /**
   * Approve or reject a join request
   */
  async decideJoinRequest(
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ): Promise<AgentPoolJoinRequest> {
    return this.guard("The join request could not be updated.", async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-pool-requests/{request_id}/decision", {
          body: { status },
          params: { path: { request_id: requestId } },
        }),
      );

      if (!result.data) throw poolError(result.error);

      return requestFromApi(result.data);
    });
  }

  /**
   * Invite a user into a pool by username
   */
  async inviteMember(
    poolId: string,
    username: string,
  ): Promise<AgentPoolPerson> {
    return this.guard("The member could not be invited.", async () => {
      const result = await this.request(() =>
        this.client.POST("/agent-pools/{connection_id}/members", {
          body: { username },
          params: { path: { connection_id: poolId } },
        }),
      );

      if (!result.data) throw poolError(result.error);

      return personFromApi(result.data);
    });
  }

  /**
   * Remove a member from a pool
   */
  async removeMember(poolId: string, username: string): Promise<void> {
    return this.guard("The member could not be removed.", async () => {
      const result = await this.request(() =>
        this.client.DELETE("/agent-pools/{connection_id}/members/{username}", {
          params: { path: { connection_id: poolId, username } },
        }),
      );

      if (!result.response.ok) throw poolError(result.error);
    });
  }

  /**
   * Format a pool or member date as "Mar 05, 2026"
   */
  createdLabel(createdAt: string): string {
    return new Intl.DateTimeFormat("en", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
      year: "numeric",
    }).format(new Date(createdAt));
  }
}

export const agentService = new AgentService();
