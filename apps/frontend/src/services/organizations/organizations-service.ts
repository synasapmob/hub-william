import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type {
  CreateOrganizationInput,
  Organization,
  OrganizationAgent,
  OrganizationAgentDetails,
  OrganizationInvitation,
  OrganizationMember,
  OrganizationOverview,
  OrganizationSummary,
  OrganizationUsage,
  OrganizationUsageDay,
  OrganizationUsageFilters,
} from "./organizations-types";

type ApiOrganization = components["schemas"]["Organization"];
type ApiOrganizationSummary = components["schemas"]["OrganizationSummary"];
type ApiInvitation = components["schemas"]["OrganizationInvitation"];
type ApiAgent = components["schemas"]["OrganizationAgent"];
type ApiAgentDetails = components["schemas"]["OrganizationAgentDetails"];
type ApiMember = components["schemas"]["OrganizationMember"];
type ApiOverview = components["schemas"]["OrganizationOverview"];
type ApiUsage = components["schemas"]["OrganizationUsage"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

// Usage window of the My organizations table, in UTC days.
export const ORGANIZATION_SUMMARY_DAYS = 30;

export class OrganizationServiceError extends Error {}

function organizationError(error?: ErrorResponse) {
  return new OrganizationServiceError(
    error?.message ?? "The organization request could not be completed.",
  );
}

function organizationFromApi(value: ApiOrganization): Organization {
  return {
    createdAt: value.created_at,
    description: value.description ?? null,
    id: value.id,
    isDefault: value.is_default,
    name: value.name,
    role: value.role as Organization["role"],
  };
}

function summaryFromApi(value: ApiOrganizationSummary): OrganizationSummary {
  return {
    ...organizationFromApi(value),
    agentCount: value.agent_count,
    knownCachedTokens: value.known_cached_tokens,
    knownInputTokens: value.known_input_tokens,
    knownOutputTokens: value.known_output_tokens,
    memberCount: value.member_count,
    ownerUsername: value.owner_username,
    periodDays: value.period_days,
    requests: value.requests,
    tokenKnownRequests: value.token_known_requests,
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
    validationUrl: value.validation_url ?? undefined,
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

class OrganizationsService {
  readonly baseUrl: string;

  readonly queryKey = ["organizations"] as const;

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
   * List the organizations the signed-in user belongs to
   */
  async list(): Promise<Organization[]> {
    const result = await this.request(() => this.client.GET("/organizations"));

    if (!result.data) throw organizationError(result.error);

    return result.data.map(organizationFromApi);
  }

  /**
   * List the organizations with their usage over the last
   * `ORGANIZATION_SUMMARY_DAYS` days
   */
  async summaries(): Promise<OrganizationSummary[]> {
    const result = await this.request(() =>
      this.client.GET("/organization-summaries", {
        params: { query: { days: ORGANIZATION_SUMMARY_DAYS } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return result.data.map(summaryFromApi);
  }

  /**
   * Create an organization owned by the signed-in user
   */
  async create(input: CreateOrganizationInput): Promise<Organization> {
    const body = {
      description: input.description.trim() || null,
      name: input.name,
    };
    const result = await this.request(() =>
      this.client.POST("/organizations", { body }),
    );

    if (!result.data) throw organizationError(result.error);

    return organizationFromApi(result.data);
  }

  /**
   * Make an organization the one the Organization pages open with
   */
  async setDefault(id: string): Promise<void> {
    const result = await this.request(() =>
      this.client.PUT("/organizations/{id}/default", {
        params: { path: { id } },
      }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * Delete an organization
   */
  async deleteOrganization(id: string): Promise<void> {
    const result = await this.request(() =>
      this.client.DELETE("/organizations/{id}", { params: { path: { id } } }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * Leave an organization the signed-in user is a member of
   */
  async leave(id: string): Promise<void> {
    const result = await this.request(() =>
      this.client.DELETE("/organizations/{id}/membership", {
        params: { path: { id } },
      }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * List the pending invitations addressed to the signed-in user
   */
  async invitations(): Promise<OrganizationInvitation[]> {
    const result = await this.request(() =>
      this.client.GET("/organization-invitations"),
    );

    if (!result.data) throw organizationError(result.error);

    return result.data.map(invitationFromApi);
  }

  /**
   * Accept an invitation and join its organization
   */
  async acceptInvitation(id: string): Promise<Organization> {
    const result = await this.request(() =>
      this.client.POST("/organization-invitations/{invitation_id}/accept", {
        params: { path: { invitation_id: id } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return organizationFromApi(result.data);
  }

  /**
   * Decline an invitation
   */
  async declineInvitation(id: string): Promise<void> {
    const result = await this.request(() =>
      this.client.DELETE("/organization-invitations/{invitation_id}", {
        params: { path: { invitation_id: id } },
      }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * Get an organization's overview over the last `days` UTC days
   */
  async overview(id: string, days: number): Promise<OrganizationOverview> {
    const result = await this.request(() =>
      this.client.GET("/organizations/{id}/overview", {
        params: { path: { id }, query: { days } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return overviewFromApi(result.data);
  }

  /**
   * List the agents an organization shares, optionally with their usage
   */
  async agents(
    id: string,
    includeUsage = false,
  ): Promise<OrganizationAgentDetails[]> {
    const result = await this.request(() =>
      this.client.GET("/organizations/{id}/agents", {
        params: { path: { id }, query: { include_usage: includeUsage } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return result.data.map(agentDetailsFromApi);
  }

  /**
   * Share a connected agent with an organization
   */
  async addAgent(id: string, connectionId: string): Promise<OrganizationAgent> {
    const result = await this.request(() =>
      this.client.POST("/organizations/{id}/agents", {
        body: { connection_id: connectionId },
        params: { path: { id } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return agentFromApi(result.data);
  }

  /**
   * Stop sharing an agent with an organization
   */
  async removeAgent(id: string, connectionId: string): Promise<void> {
    const result = await this.request(() =>
      this.client.DELETE("/organizations/{id}/agents/{connection_id}", {
        params: { path: { id, connection_id: connectionId } },
      }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * List the members and pending invitees of an organization
   */
  async members(id: string): Promise<OrganizationMember[]> {
    const result = await this.request(() =>
      this.client.GET("/organizations/{id}/members", {
        params: { path: { id } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return result.data.map(memberFromApi);
  }

  /**
   * Invite a user into an organization by username
   */
  async inviteMember(
    id: string,
    username: string,
  ): Promise<OrganizationMember> {
    const result = await this.request(() =>
      this.client.POST("/organizations/{id}/members", {
        body: { username },
        params: { path: { id } },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return memberFromApi(result.data);
  }

  /**
   * Remove a member from an organization
   */
  async removeMember(id: string, username: string): Promise<void> {
    const result = await this.request(() =>
      this.client.DELETE("/organizations/{id}/members/{username}", {
        params: { path: { id, username } },
      }),
    );

    if (!result.response.ok) throw organizationError(result.error);
  }

  /**
   * Get an organization's usage, optionally narrowed by member, agent or model
   */
  async usage(
    id: string,
    filters: OrganizationUsageFilters,
  ): Promise<OrganizationUsage> {
    const result = await this.request(() =>
      this.client.GET("/organizations/{id}/usage", {
        params: {
          path: { id },
          query: {
            days: filters.days,
            member_id: filters.memberId,
            connection_id: filters.connectionId,
            model: filters.model,
          },
        },
      }),
    );

    if (!result.data) throw organizationError(result.error);

    return usageFromApi(result.data);
  }
}

export const organizationsService = new OrganizationsService();
