import type { components } from "@/services/api/api.generated";
import type { ProviderLabel } from "@/services/provider-catalogue/provider-catalogue.generated";

// Display name of a provider ("Claude"), as a pool labels its agent.
export type AgentProvider = ProviderLabel;

// Catalogue id of a provider ("claude"), as the API addresses a connection.
export type AgentProviderId = components["schemas"]["AgentProvider"];

export type AgentConnectionStatus =
  components["schemas"]["AgentConnectionStatus"];

export type AgentPoolRequestStatus =
  components["schemas"]["AgentPoolRequestStatus"];

export type AgentPoolAvailabilityStatus =
  components["schemas"]["AgentPoolAvailabilityStatus"];

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
  availabilityStatus: string;
  createdAt: string;
  failureMessage: string | null;
  id: string;
  plan: string | null;
  provider: AgentProviderId;
  status: AgentConnectionStatus;
  updatedAt: string;
  validationUrl: string | null;
}

export interface AgentPoolAvailability {
  retryAt?: string;
  status: AgentPoolAvailabilityStatus;
  validationUrl?: string;
}

export interface AgentPoolShareEvidence {
  availablePercent: number;
  budgetUnits?: number;
  capUnits?: number;
  failOpenReason?: string;
  memberCount: number;
  poolCachedTokens: number;
  poolInputTokens: number;
  poolOutputTokens: number;
  poolUnits: number;
  providerUsedPercent?: number;
  remainingUnits?: number;
  userCachedTokens: number;
  userInputTokens: number;
  userOutputTokens: number;
  userUnits: number;
  windowLabel?: string;
}

export interface AgentPoolPerson {
  avatarLabel: string;
  joinedAt: string;
  share: AgentPoolShareEvidence;
  usageAvailablePercent: number;
  username: string;
}

export interface AgentPoolUsageMetric {
  detail?: string;
  label: string;
  value: string;
}

export interface AgentPoolJoinRequest {
  avatarLabel: string;
  id: string;
  reason: string;
  status: AgentPoolRequestStatus;
  telegram: string;
  username: string;
}

export interface AgentPoolJoinInput {
  reason: string;
  telegram: string;
}

export interface AgentPool {
  accountLabel: string;
  agent: AgentProvider;
  availability: AgentPoolAvailability;
  capacity: number;
  createdAt: string;
  id: string;
  members: AgentPoolPerson[];
  owner: AgentPoolPerson;
  plan: string;
  requests: AgentPoolJoinRequest[];
  usage: AgentPoolUsageMetric[];
}
