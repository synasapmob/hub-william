import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type { ServiceProvider } from "@/services/sales/sales-types";

type ApiConnection = components["schemas"]["AgentConnection"];

/** Where a person has to go to let Hub William use their account, and how it ends. */
export interface Authorization {
  /** Where to sign in to the provider. */
  url: string;
  /** Whether the person pastes the address the provider sends them back to. */
  needsCallbackUrl: boolean;
  /** The code to type at the provider, for a device sign-in. */
  userCode: string | null;
  /** Seconds to wait between asking whether it is done. */
  pollAfterSeconds: number;
}

export type ConnectionStatus =
  "pending" | "connected" | "failed" | "disconnected";

/** An agent account being connected, or connected, to the signed-in member. */
export interface AgentConnection {
  id: string;
  provider: ServiceProvider;
  status: ConnectionStatus;
  label: string | null;
  plan: string | null;
  authorization: Authorization | null;
  failureMessage: string | null;
}

function connectionFromApi(connection: ApiConnection): AgentConnection {
  const prompt = connection.authorization;

  return {
    authorization: prompt
      ? {
          needsCallbackUrl: prompt.requires_callback_url,
          pollAfterSeconds: prompt.poll_after_seconds,
          url: prompt.authorization_url,
          userCode: prompt.user_code ?? null,
        }
      : null,
    failureMessage: connection.failure_message ?? null,
    id: connection.id,
    label: connection.account_label ?? null,
    plan: connection.plan ?? null,
    provider: connection.provider as ServiceProvider,
    status: connection.status,
  };
}

/**
 * Connecting an agent account is what Hub William's own Agents page does, with the
 * same session: the dashboard asks the same endpoints, so an account is connected
 * here the way it is there.
 */
class AgentConnectionService {
  /**
   * Starts signing in to an agent that is connected by signing in at the provider
   * (ChatGPT, Claude, Gemini: paste the address it sends back; Grok: a code).
   */
  async start(provider: ServiceProvider): Promise<AgentConnection> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/agent-connections/start",
        { body: { provider } },
      );

      if (!data)
        throw serviceError(response, error, "Không bắt đầu kết nối được.");

      return connectionFromApi(data);
    });
  }

  /** Finishes a sign-in with the address the provider sent the person back to. */
  async complete(id: string, callbackUrl: string): Promise<AgentConnection> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST(
        "/agent-connections/{connection_id}/complete",
        {
          body: { callback_url: callbackUrl.trim() },
          params: { path: { connection_id: id } },
        },
      );

      if (!data)
        throw serviceError(response, error, "Không hoàn tất kết nối được.");

      return connectionFromApi(data);
    });
  }

  /** Connects DeepSeek or Groq with an API key. */
  async connectKey(
    provider: "deepseek" | "groq",
    apiKey: string,
  ): Promise<AgentConnection> {
    return guarded(async () => {
      const body = { api_key: apiKey.trim() };
      const { data, error, response } =
        provider === "deepseek"
          ? await apiClient.POST("/agent-connections/deepseek", { body })
          : await apiClient.POST("/agent-connections/groq", { body });

      if (!data)
        throw serviceError(response, error, "Không kết nối được bằng key này.");

      return connectionFromApi(data);
    });
  }

  /** Where a connection stands, for a sign-in that finishes on its own. */
  async get(id: string): Promise<AgentConnection> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.GET(
        "/agent-connections/{connection_id}",
        { params: { path: { connection_id: id } } },
      );

      if (!data) throw serviceError(response, error, "Không đọc được kết nối.");

      return connectionFromApi(data);
    });
  }

  /** Lets go of an account that was connected here and is not used. */
  async disconnect(id: string): Promise<void> {
    return guarded(async () => {
      const { error, response } = await apiClient.DELETE(
        "/agent-connections/{connection_id}",
        { params: { path: { connection_id: id } } },
      );

      if (error)
        throw serviceError(response, error, "Không ngắt kết nối được.");
    });
  }
}

export const agentConnectionService = new AgentConnectionService();
