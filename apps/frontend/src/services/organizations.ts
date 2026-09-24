import createClient from "openapi-fetch";

import type { components, paths } from "./api.generated";
import type { AgentPoolUsageMetric } from "./agent-pools";

type ApiOrganization = components["schemas"]["Organization"];
type ApiInvitation = components["schemas"]["OrganizationInvitation"];
type ApiAgent = components["schemas"]["OrganizationAgent"];
type ApiAgentDetails = components["schemas"]["OrganizationAgentDetails"];
type ApiMember = components["schemas"]["OrganizationMember"];
type ApiOverview = components["schemas"]["OrganizationOverview"];
type ApiUsage = components["schemas"]["OrganizationUsage"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

export interface Organization {
  createdAt: string;
  description: string | null;
  id: string;
  name: string;
  role: "owner" | "member";
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

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

export class OrganizationServiceError extends Error {}

function serviceError(error?: ErrorResponse) {
  return new OrganizationServiceError(
    error?.message ?? "The organization request could not be completed.",
  );
}

async function refreshHubSession() {
  const { data } = await client.POST("/auth/refresh");
  return Boolean(data);
}

function organizationFromApi(value: ApiOrganization): Organization {
  return {
    createdAt: value.created_at,
    description: value.description ?? null,
    id: value.id,
    name: value.name,
    role: value.role as Organization["role"],
  };
}

function invitationFromApi(value: ApiInvitation): OrganizationInvitation {
  return {
    createdAt: value.created_at,
    id: value.id,
    invitedByUsername: value.invited_by_username ?? null,
    organizationId: value.organization_id,
    organizationName: value.organization_name,
  };
}

function agentFromApi(value: ApiAgent): OrganizationAgent {
  return {
    accountLabel: value.account_label ?? null,
    availabilityStatus: value.availability_status,
    createdAt: value.created_at,
    id: value.id,
    ownerUsername: value.owner_username,
    provider: value.provider,
    rateLimitedUntil: value.rate_limited_until ?? null,
  };
}

function agentDetailsFromApi(value: ApiAgentDetails): OrganizationAgentDetails {
  return {
    ...agentFromApi(value),
    plan: value.plan,
    usage: value.usage.map((metric) => ({
      detail: metric.detail ?? undefined,
      label: metric.label,
      value: metric.value,
    })),
  };
}

function memberFromApi(value: ApiMember): OrganizationMember {
  return {
    id: value.id,
    invitedAt: value.invited_at,
    invitedByUsername: value.invited_by_username ?? null,
    joinedAt: value.joined_at ?? null,
    role: value.role as OrganizationMember["role"],
    status: value.status as OrganizationMember["status"],
    username: value.username,
  };
}

function dayFromApi(
  value: ApiOverview["daily_usage"][number],
): OrganizationUsageDay {
  return {
    date: value.date,
    knownTotalTokens: value.known_total_tokens,
    requests: value.requests,
    tokenKnownRequests: value.token_known_requests,
  };
}

function overviewFromApi(value: ApiOverview): OrganizationOverview {
  return {
    agentCount: value.agent_count,
    agents: value.agents.map(agentFromApi),
    dailyUsage: value.daily_usage.map(dayFromApi),
    knownCachedTokens: value.known_cached_tokens,
    knownInputTokens: value.known_input_tokens,
    knownOutputTokens: value.known_output_tokens,
    memberCount: value.member_count,
    organization: organizationFromApi(value.organization),
    periodDays: value.period_days,
    requests: value.requests,
    tokenKnownRequests: value.token_known_requests,
  };
}

function usageFromApi(value: ApiUsage): OrganizationUsage {
  return {
    breakdown: value.breakdown.map((item) => ({
      connectionId: item.connection_id ?? null,
      knownCachedTokens: item.known_cached_tokens,
      knownInputTokens: item.known_input_tokens,
      knownOutputTokens: item.known_output_tokens,
      memberId: item.member_id,
      model: item.model ?? null,
      provider: item.provider,
      requests: item.requests,
      tokenKnownRequests: item.token_known_requests,
      username: item.username,
    })),
    dailyUsage: value.daily_usage.map(dayFromApi),
    knownCachedTokens: value.known_cached_tokens,
    knownInputTokens: value.known_input_tokens,
    knownOutputTokens: value.known_output_tokens,
    periodDays: value.period_days,
    requests: value.requests,
    tokenKnownRequests: value.token_known_requests,
  };
}

async function list(): Promise<Organization[]> {
  let result = await client.GET("/organizations");
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organizations");
  if (!result.data) throw serviceError(result.error);
  return result.data.map(organizationFromApi);
}

async function create(input: CreateOrganizationInput): Promise<Organization> {
  const body = {
    description: input.description.trim() || null,
    name: input.name,
  };
  let result = await client.POST("/organizations", { body });
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.POST("/organizations", { body });
  if (!result.data) throw serviceError(result.error);
  return organizationFromApi(result.data);
}

async function invitations(): Promise<OrganizationInvitation[]> {
  let result = await client.GET("/organization-invitations");
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organization-invitations");
  if (!result.data) throw serviceError(result.error);
  return result.data.map(invitationFromApi);
}

async function acceptInvitation(id: string): Promise<Organization> {
  const options = { params: { path: { invitation_id: id } } };
  let result = await client.POST(
    "/organization-invitations/{invitation_id}/accept",
    options,
  );
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.POST(
      "/organization-invitations/{invitation_id}/accept",
      options,
    );
  if (!result.data) throw serviceError(result.error);
  return organizationFromApi(result.data);
}

async function declineInvitation(id: string): Promise<void> {
  const options = { params: { path: { invitation_id: id } } };
  let result = await client.DELETE(
    "/organization-invitations/{invitation_id}",
    options,
  );
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.DELETE(
      "/organization-invitations/{invitation_id}",
      options,
    );
  if (!result.response.ok) throw serviceError(result.error);
}

async function overview(
  id: string,
  days: number,
): Promise<OrganizationOverview> {
  const options = {
    params: { path: { id }, query: { days } },
  };
  let result = await client.GET("/organizations/{id}/overview", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organizations/{id}/overview", options);
  if (!result.data) throw serviceError(result.error);
  return overviewFromApi(result.data);
}

async function agents(
  id: string,
  includeUsage = false,
): Promise<OrganizationAgentDetails[]> {
  const options = {
    params: { path: { id }, query: { include_usage: includeUsage } },
  };
  let result = await client.GET("/organizations/{id}/agents", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organizations/{id}/agents", options);
  if (!result.data) throw serviceError(result.error);
  return result.data.map(agentDetailsFromApi);
}

async function addAgent(
  id: string,
  connectionId: string,
): Promise<OrganizationAgent> {
  const options = {
    body: { connection_id: connectionId },
    params: { path: { id } },
  };
  let result = await client.POST("/organizations/{id}/agents", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.POST("/organizations/{id}/agents", options);
  if (!result.data) throw serviceError(result.error);
  return agentFromApi(result.data);
}

async function removeAgent(id: string, connectionId: string): Promise<void> {
  const options = { params: { path: { id, connection_id: connectionId } } };
  let result = await client.DELETE(
    "/organizations/{id}/agents/{connection_id}",
    options,
  );
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.DELETE(
      "/organizations/{id}/agents/{connection_id}",
      options,
    );
  if (!result.response.ok) throw serviceError(result.error);
}

async function members(id: string): Promise<OrganizationMember[]> {
  const options = { params: { path: { id } } };
  let result = await client.GET("/organizations/{id}/members", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organizations/{id}/members", options);
  if (!result.data) throw serviceError(result.error);
  return result.data.map(memberFromApi);
}

async function inviteMember(
  id: string,
  username: string,
): Promise<OrganizationMember> {
  const options = { body: { username }, params: { path: { id } } };
  let result = await client.POST("/organizations/{id}/members", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.POST("/organizations/{id}/members", options);
  if (!result.data) throw serviceError(result.error);
  return memberFromApi(result.data);
}

async function removeMember(id: string, username: string): Promise<void> {
  const options = { params: { path: { id, username } } };
  let result = await client.DELETE(
    "/organizations/{id}/members/{username}",
    options,
  );
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.DELETE(
      "/organizations/{id}/members/{username}",
      options,
    );
  if (!result.response.ok) throw serviceError(result.error);
}

async function usage(
  id: string,
  filters: OrganizationUsageFilters,
): Promise<OrganizationUsage> {
  const options = {
    params: {
      path: { id },
      query: {
        days: filters.days,
        member_id: filters.memberId,
        connection_id: filters.connectionId,
        model: filters.model,
      },
    },
  };
  let result = await client.GET("/organizations/{id}/usage", options);
  if (result.response.status === 401 && (await refreshHubSession()))
    result = await client.GET("/organizations/{id}/usage", options);
  if (!result.data) throw serviceError(result.error);
  return usageFromApi(result.data);
}

const organizationsService = {
  acceptInvitation,
  addAgent,
  agents,
  create,
  declineInvitation,
  invitations,
  inviteMember,
  list,
  members,
  overview,
  queryKey: ["organizations"] as const,
  removeAgent,
  removeMember,
  usage,
};

export default organizationsService;
