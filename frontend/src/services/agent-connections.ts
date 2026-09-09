import createClient from "openapi-fetch";

import type { components, paths } from "./api.generated";

export type AgentProvider = components["schemas"]["AgentProvider"];
export type AgentConnectionStatus =
  components["schemas"]["AgentConnectionStatus"];

type ApiAgentConnection = components["schemas"]["AgentConnection"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

export interface AgentAuthorizationPrompt {
  authorizationUrl: string;
  expiresAt: string;
  pollAfterSeconds: number;
  requiresCallbackUrl: boolean;
  userCode: string | null;
}

export interface AgentConnection {
  accountLabel: string | null;
  authorization: AgentAuthorizationPrompt | null;
  createdAt: string;
  failureMessage: string | null;
  id: string;
  plan: string | null;
  provider: AgentProvider;
  status: AgentConnectionStatus;
  updatedAt: string;
}

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

export class AgentConnectionServiceError extends Error {}

function connectionFromApi(connection: ApiAgentConnection): AgentConnection {
  return {
    accountLabel: connection.account_label ?? null,
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
  };
}

function serviceError(error?: ErrorResponse) {
  return new AgentConnectionServiceError(
    error?.message ?? "The provider connection could not be completed.",
  );
}

async function refreshHubSession() {
  const { data } = await client.POST("/auth/refresh");
  return Boolean(data);
}

async function start(provider: AgentProvider) {
  try {
    let result = await client.POST("/agent-connections/start", {
      body: { provider },
    });
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.POST("/agent-connections/start", {
        body: { provider },
      });
    }
    if (!result.data) throw serviceError(result.error);
    return connectionFromApi(result.data);
  } catch (error) {
    if (error instanceof AgentConnectionServiceError) throw error;
    throw new AgentConnectionServiceError(
      "The provider connection service is unavailable.",
    );
  }
}

async function get(connectionId: string) {
  try {
    let result = await client.GET("/agent-connections/{connection_id}", {
      params: { path: { connection_id: connectionId } },
    });
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.GET("/agent-connections/{connection_id}", {
        params: { path: { connection_id: connectionId } },
      });
    }
    if (!result.data) throw serviceError(result.error);
    return connectionFromApi(result.data);
  } catch (error) {
    if (error instanceof AgentConnectionServiceError) throw error;
    throw new AgentConnectionServiceError(
      "The provider connection service is unavailable.",
    );
  }
}

async function complete(connectionId: string, callbackUrl: string) {
  try {
    let result = await client.POST(
      "/agent-connections/{connection_id}/complete",
      {
        body: { callback_url: callbackUrl },
        params: { path: { connection_id: connectionId } },
      },
    );
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.POST(
        "/agent-connections/{connection_id}/complete",
        {
          body: { callback_url: callbackUrl },
          params: { path: { connection_id: connectionId } },
        },
      );
    }
    if (!result.data) throw serviceError(result.error);
    return connectionFromApi(result.data);
  } catch (error) {
    if (error instanceof AgentConnectionServiceError) throw error;
    throw new AgentConnectionServiceError(
      "The provider connection service is unavailable.",
    );
  }
}

async function list() {
  try {
    let result = await client.GET("/agent-connections");
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.GET("/agent-connections");
    }
    if (!result.data) throw serviceError(result.error);
    return result.data.map(connectionFromApi);
  } catch (error) {
    if (error instanceof AgentConnectionServiceError) throw error;
    throw new AgentConnectionServiceError(
      "The provider connection service is unavailable.",
    );
  }
}

async function disconnect(connectionId: string) {
  try {
    let result = await client.DELETE("/agent-connections/{connection_id}", {
      params: { path: { connection_id: connectionId } },
    });
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.DELETE("/agent-connections/{connection_id}", {
        params: { path: { connection_id: connectionId } },
      });
    }
    if (result.error) throw serviceError(result.error);
  } catch (error) {
    if (error instanceof AgentConnectionServiceError) throw error;
    throw new AgentConnectionServiceError(
      "The provider connection service is unavailable.",
    );
  }
}

const agentConnectionsService = { complete, disconnect, get, list, start };

export default agentConnectionsService;
