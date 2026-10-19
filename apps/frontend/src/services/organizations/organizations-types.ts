import type { AgentPoolUsageMetric } from "@/services/agent/agent-types";

export interface Organization {
  createdAt: string;
  description: string | null;
  id: string;
  // The organization the viewer's Organization pages open with. Creating or
  // joining one, or choosing it, makes it the default; none is until then.
  isDefault: boolean;
  name: string;
  role: "owner" | "member";
}

// An organization as My organizations lists it: its owner, its agent and member
// counts and its recorded usage over the last `periodDays` UTC days, the same
// figures its Overview reports.
export interface OrganizationSummary extends Organization {
  agentCount: number;
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  memberCount: number;
  ownerUsername: string;
  periodDays: number;
  requests: number;
  tokenKnownRequests: number;
}

export interface CreateOrganizationInput {
  description: string;
  name: string;
}

export interface OrganizationInvitation {
  createdAt: string;
  id: string;
  invitedByUsername: string | null;
  organizationId: string;
  organizationName: string;
}

export interface OrganizationAgent {
  accountLabel: string | null;
  availabilityStatus: string;
  createdAt: string;
  id: string;
  ownerUsername: string;
  provider: string;
  rateLimitedUntil: string | null;
  validationUrl?: string;
}

export interface OrganizationAgentDetails extends OrganizationAgent {
  plan: string;
  usage: AgentPoolUsageMetric[];
}

export interface OrganizationMember {
  id: string;
  invitedAt: string;
  invitedByUsername: string | null;
  joinedAt: string | null;
  role: "owner" | "member";
  status: "accepted" | "pending";
  username: string;
}

export interface OrganizationUsageDay {
  date: string;
  knownTotalTokens: number;
  requests: number;
  tokenKnownRequests: number;
}

export interface OrganizationOverview {
  agentCount: number;
  agents: OrganizationAgent[];
  dailyUsage: OrganizationUsageDay[];
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  memberCount: number;
  organization: Organization;
  periodDays: number;
  requests: number;
  tokenKnownRequests: number;
}

export interface OrganizationUsageBreakdown {
  connectionId: string | null;
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  memberId: string;
  model: string | null;
  provider: string;
  requests: number;
  tokenKnownRequests: number;
  username: string;
}

export interface OrganizationUsage {
  breakdown: OrganizationUsageBreakdown[];
  dailyUsage: OrganizationUsageDay[];
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  periodDays: number;
  requests: number;
  tokenKnownRequests: number;
}

export interface OrganizationUsageFilters {
  connectionId?: string;
  days: number;
  memberId?: string;
  model?: string;
}
