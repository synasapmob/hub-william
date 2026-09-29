import createClient from "openapi-fetch";
import { z } from "zod";

import type { components, paths } from "@/services/api.generated";

import readGroqStream, {
  type PlaygroundGroqEvent,
} from "./playground-groq-stream";
import readPlaygroundStream from "./playground-stream";

import providerCatalogue from "@/services/provider-catalogue";
import {
  callAvailabilityRules,
  callKinds,
  callTransports,
  modelCapabilities,
} from "@/services/provider-catalogue.generated";
import type {
  CatalogueCallProfile,
  ModelCapability,
} from "@/services/provider-catalogue.generated";

export type PlaygroundProviderId = components["schemas"]["AgentProvider"];
export interface PlaygroundModel {
  id: string;
  name: string;
  modes: ("chat" | "voice")[];
  capabilities?: ModelCapability[];
  call?: CatalogueCallProfile;
}
export type PlaygroundAttachment =
  components["schemas"]["PlaygroundAttachment"];

export interface PlaygroundMessage {
  attachments?: PlaygroundAttachment[];
  role: "user" | "assistant";
  content: string;
}
export interface PlaygroundChatOptions {
  connectionId: string;
  organizationId?: string;
  provider: PlaygroundProviderId;
  model: string;
  messages: PlaygroundMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

export interface PlaygroundChatResult {
  // The API may answer from another account of the same provider and scope
  // when the selected one cannot serve; this names the account that did.
  servedConnectionId: string | null;
}

export interface PlaygroundVoiceSessionOptions {
  connectionId: string;
  organizationId?: string;
  provider: PlaygroundProviderId;
  model: string;
  sdp: string;
  signal: AbortSignal;
}

export interface PlaygroundGroqTurnMessage {
  role: "user" | "assistant";
  content: string;
}

export interface PlaygroundGroqTurnOptions {
  onEvent?: (event: PlaygroundGroqEvent) => void;
  connectionId: string;
  organizationId?: string;
  model: string;
  transcript: string;
  messages: PlaygroundGroqTurnMessage[];
  signal: AbortSignal;
}

export interface PlaygroundGroqTurnResult {
  transcript: string;
  reply: string;
  audio: string[];
}

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

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

async function refreshSession(signal?: AbortSignal) {
  const result = await client.POST("/auth/refresh", { signal });
  return Boolean(result.data);
}

async function models(
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
  let result = await client.GET(
    "/playground/{provider}/accounts/{connection_id}/models",
    options,
  );
  if (result.response.status === 401 && (await refreshSession(signal)))
    result = await client.GET(
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
  // that known contract while frontend/backend deployments roll forward.
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
              providerCatalogue
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
          .optional(),
      }),
    )
    .parse(result.data);
}

async function chat({
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
  let result = await client.POST("/playground/chat", options);
  // Only the Hub session's explicit unauthorized response can trigger one
  // refresh. Never replay a generation after upstream work or streaming begins.
  if (result.response.status === 401) {
    const payload = result.error;
    if (payload?.code === "unauthorized" && (await refreshSession(signal)))
      result = await client.POST("/playground/chat", options);
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

const playgroundService = {
  models,
  chat,
  voiceSession,
  groqTurn,
  queryKey: ["playground"] as const,
};
export default playgroundService;

async function groqTurn({
  connectionId,
  organizationId,
  signal,
  onEvent,
  ...input
}: PlaygroundGroqTurnOptions): Promise<PlaygroundGroqTurnResult | null> {
  const options = {
    signal,
    parseAs: "stream" as const,
    body: {
      ...input,
      stream: true,
      stream_audio: true,
      connection_id: connectionId,
      organization_id: organizationId,
    },
  };
  let result = await client.POST("/playground/groq/voice/turn", options);
  if (
    result.response.status === 401 &&
    result.error?.code === "unauthorized" &&
    (await refreshSession(signal))
  )
    result = await client.POST("/playground/groq/voice/turn", options);
  if (!result.data)
    throw new PlaygroundServiceError(
      result.response.status === 429
        ? "Groq's rate limit was reached. Try again after the account cooldown."
        : (providerErrorMessage(result.error) ??
            "Groq could not complete this turn. Start a new call to retry."),
      result.response.status,
    );
  return readGroqStream({ stream: result.data, signal, onEvent });
}

async function voiceSession({
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
  let result = await client.POST("/playground/voice", options);
  if (
    result.response.status === 401 &&
    result.error?.code === "unauthorized" &&
    (await refreshSession(signal))
  )
    result = await client.POST("/playground/voice", options);
  if (!result.data)
    throw new PlaygroundServiceError(
      providerErrorMessage(result.error) ??
        "The voice call could not start. Please try again.",
      result.response.status,
    );
  return result.data.sdp;
}
