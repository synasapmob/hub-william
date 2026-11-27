import createClient, { type Client } from "openapi-fetch";
import { z } from "zod";

import type { paths } from "@/services/api/api.generated";

import { providerCatalogueService } from "@/services/provider-catalogue/provider-catalogue-service";
import {
  callAvailabilityRules,
  callKinds,
  callTransports,
  modelCapabilities,
} from "@/services/provider-catalogue/provider-catalogue.generated";

import readPlaygroundStream from "./playground-stream";
import type {
  PlaygroundChatOptions,
  PlaygroundChatResult,
  PlaygroundModel,
  PlaygroundProviderId,
  PlaygroundVoiceSessionOptions,
} from "./playground-types";

export class PlaygroundServiceError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const providerErrorSchema = z.object({
  message: z.string().optional(),
  error: z.unknown().optional(),
});
const providerErrorDetailSchema = z.object({ message: z.string() });

function providerErrorMessage(error: unknown): string | undefined {
  const parsed = providerErrorSchema.safeParse(error);
  if (!parsed.success) return undefined;
  const direct = parsed.data.message?.trim();
  if (direct) return direct;
  const nested = providerErrorDetailSchema.safeParse(parsed.data.error);
  return nested.success ? nested.data.message.trim() || undefined : undefined;
}

class PlaygroundService {
  readonly baseUrl: string;

  readonly queryKey = ["playground"] as const;

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

  private async refreshSession(signal?: AbortSignal) {
    const result = await this.client.POST("/auth/refresh", { signal });

    return Boolean(result.data);
  }

  /**
   * List the models an account can serve for a provider
   */
  async models(
    provider: PlaygroundProviderId,
    connectionId: string,
    signal: AbortSignal,
    organizationId?: string,
  ): Promise<PlaygroundModel[]> {
    const options = {
      params: {
        path: { provider, connection_id: connectionId },
        query: { organization_id: organizationId },
      },
      signal,
    };
    let result = await this.client.GET(
      "/playground/{provider}/accounts/{connection_id}/models",
      options,
    );
    if (result.response.status === 401 && (await this.refreshSession(signal)))
      result = await this.client.GET(
        "/playground/{provider}/accounts/{connection_id}/models",
        options,
      );
    if (!result.data)
      throw new PlaygroundServiceError(
        result.response.status === 404
          ? "Playground is temporarily unavailable. Please try again shortly."
          : (providerErrorMessage(result.error) ??
              "Models could not be loaded. Please retry or choose another account."),
        result.response.status,
      );
    // A previously deployed API only offered chat and omitted modes. Preserve
    // that known contract while frontend/backend deployments roll forward. A
    // call profile this build does not know (an older or newer API) is dropped
    // so the model stays listed for Chat instead of failing the whole list.
    return z
      .array(
        z.object({
          id: z.string(),
          name: z.string(),
          modes: z.array(z.enum(["chat", "voice"])).default(["chat"]),
          capabilities: z.array(z.enum(modelCapabilities)).optional(),
          call: z
            .object({
              id: z.string(),
              provider: z.enum(
                providerCatalogueService
                  .list("playground")
                  .map((provider) => provider.id),
              ),
              name: z.string(),
              kind: z.enum(callKinds),
              transport: z.enum(callTransports),
              selector_model: z.string(),
              availability: z.enum(callAvailabilityRules),
              models: z.record(z.string(), z.string()),
            })
            .optional()
            .catch(undefined),
        }),
      )
      .parse(result.data);
  }

  /**
   * Stream a chat completion into `onDelta` and report which account served it
   */
  async chat({
    signal,
    onDelta,
    connectionId,
    organizationId,
    ...input
  }: PlaygroundChatOptions): Promise<PlaygroundChatResult> {
    const body = {
      ...input,
      connection_id: connectionId,
      organization_id: organizationId,
    };
    if (new Blob([JSON.stringify(body)]).size > 32 * 1024 * 1024)
      throw new PlaygroundServiceError(
        "This conversation is too large to send. Start a new conversation or use smaller attachments.",
      );
    const options = { body, signal, parseAs: "stream" as const };
    let result = await this.client.POST("/playground/chat", options);
    // Only the Hub session's explicit unauthorized response can trigger one
    // refresh. Never replay a generation after upstream work or streaming begins.
    if (result.response.status === 401) {
      const payload = result.error;
      if (
        payload?.code === "unauthorized" &&
        (await this.refreshSession(signal))
      )
        result = await this.client.POST("/playground/chat", options);
    }
    if (!result.response.ok || !result.data) {
      const providerMessage = providerErrorMessage(result.error);
      const message =
        result.response.status === 403
          ? (providerMessage ??
            "The provider or server rejected this request (HTTP 403).")
          : result.response.status === 429
            ? "Your available pools are rate limited. Please try again later."
            : result.response.status === 413
              ? "This conversation is too large to send. Start a new conversation or use smaller attachments."
              : (providerMessage ??
                "The provider could not complete this request. Check your pool or try another model.");
      throw new PlaygroundServiceError(message, result.response.status);
    }
    const servedConnectionId =
      result.response.headers.get("x-hub-connection-id")?.trim() || null;
    await readPlaygroundStream({
      provider: body.provider,
      stream: result.data,
      signal,
      onDelta,
    });
    return { servedConnectionId };
  }

  /**
   * Start a realtime voice call and return the answer SDP
   */
  async voiceSession({
    connectionId,
    organizationId,
    signal,
    ...input
  }: PlaygroundVoiceSessionOptions): Promise<string> {
    const options = {
      body: {
        ...input,
        connection_id: connectionId,
        organization_id: organizationId,
      },
      signal,
    };
    let result = await this.client.POST("/playground/voice", options);
    if (
      result.response.status === 401 &&
      result.error?.code === "unauthorized" &&
      (await this.refreshSession(signal))
    )
      result = await this.client.POST("/playground/voice", options);
    if (!result.data)
      throw new PlaygroundServiceError(
        providerErrorMessage(result.error) ??
          "The voice call could not start. Please try again.",
        result.response.status,
      );
    return result.data.sdp;
  }
}

export const playgroundService = new PlaygroundService();
