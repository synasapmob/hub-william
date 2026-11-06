import { ServiceError } from "@/services/api/api-client";
import type {
  AgentConnection,
  ConnectionStatus,
} from "@/services/agent-connection/agent-connection-service";
import type { ServiceProvider } from "@/services/sales/sales-types";

let counter = 0;

/** Puts the counter back, so every test starts with the same ids. */
export function resetFakeAgentConnections() {
  counter = 0;
}

/** The agent a fake connection id was made for: ids read `connection-<agent>-<n>`. */
export function providerOfConnection(id: string) {
  return id.split("-")[1] as ServiceProvider;
}

function connection(
  id: string,
  status: ConnectionStatus,
  extra: Partial<AgentConnection> = {},
): AgentConnection {
  return {
    authorization: null,
    failureMessage: null,
    id,
    label: status === "connected" ? "Account mới" : null,
    plan: status === "connected" ? "Plus" : null,
    provider: providerOfConnection(id),
    status,
    ...extra,
  };
}

/**
 * The Agents page's connect flow as the server would answer it, kept in memory: a
 * sign-in that needs the address pasted back, one that finishes on its own, and a
 * key. A test replaces one method with a spy to see what was asked, or to make it fail.
 */
export const fakeAgentConnectionService = {
  async start(provider: ServiceProvider): Promise<AgentConnection> {
    counter += 1;

    return connection(`connection-${provider}-${counter}`, "pending", {
      authorization: {
        needsCallbackUrl: provider !== "grok",
        pollAfterSeconds: 1,
        url: `https://auth.example/${provider}/login`,
        userCode: provider === "grok" ? "ABCD-1234" : null,
      },
    });
  },

  /** The address the provider sends the person back to carries a `code`. */
  async complete(id: string, callbackUrl: string): Promise<AgentConnection> {
    if (!callbackUrl.includes("code="))
      throw new ServiceError(
        "The callback URL does not contain an authorization code.",
        422,
        "validation_error",
      );

    return connection(id, "connected");
  },

  /** A key that starts with `bad` is one the provider does not accept. */
  async connectKey(
    provider: "deepseek" | "groq",
    apiKey: string,
  ): Promise<AgentConnection> {
    if (apiKey.trim().startsWith("bad"))
      throw new ServiceError(
        "The provider did not accept that key.",
        422,
        "validation_error",
      );

    counter += 1;

    return connection(`connection-${provider}-${counter}`, "connected");
  },

  /** A sign-in that finishes on its own is done by the time it is asked. */
  async get(id: string): Promise<AgentConnection> {
    return connection(id, "connected");
  },

  async disconnect(): Promise<void> {},
};
