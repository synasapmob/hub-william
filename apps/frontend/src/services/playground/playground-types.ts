import type { components } from "@/services/api/api.generated";
import type {
  CatalogueCallProfile,
  ModelCapability,
} from "@/services/provider-catalogue/provider-catalogue.generated";

import type { PlaygroundGroqEvent } from "./playground-groq-stream";

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
