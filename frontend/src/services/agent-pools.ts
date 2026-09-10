import createClient from "openapi-fetch";

import type { components, paths } from "./api.generated";

export type AgentProvider = "ChatGPT" | "Claude" | "Grok";
export type AgentPoolRequestStatus =
  components["schemas"]["AgentPoolRequestStatus"];

export interface AgentPoolPerson {
  avatarLabel: string;
  username: string;
}

export interface AgentPoolUsageMetric {
  detail?: string;
  label: string;
  value: string;
}

export interface AgentPoolJoinRequest extends AgentPoolPerson {
  id: string;
  reason: string;
  status: AgentPoolRequestStatus;
  telegram: string;
}

export interface AgentPool {
  accountLabel: string;
  agent: AgentProvider;
  capacity: number;
  createdAt: string;
  id: string;
  members: AgentPoolPerson[];
  owner: AgentPoolPerson;
  plan: string;
  requests: AgentPoolJoinRequest[];
  usage: AgentPoolUsageMetric[];
}

interface CreateJoinRequest {
  reason: string;
  telegram: string;
}

type ApiAgentPool = components["schemas"]["AgentPool"];
type ApiAgentPoolPerson = components["schemas"]["AgentPoolPerson"];
type ApiAgentPoolJoinRequest = components["schemas"]["AgentPoolJoinRequest"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

export class AgentPoolServiceError extends Error {}

function personFromApi(person: ApiAgentPoolPerson): AgentPoolPerson {
  return { avatarLabel: person.avatar_label, username: person.username };
}

function requestFromApi(
  request: ApiAgentPoolJoinRequest,
): AgentPoolJoinRequest {
  return {
    avatarLabel: request.avatar_label,
    id: request.id,
    reason: request.reason,
    status: request.status,
    telegram: request.telegram,
    username: request.username,
  };
}

function poolFromApi(pool: ApiAgentPool): AgentPool {
  return {
    accountLabel: pool.account_label,
    agent: pool.agent as AgentProvider,
    capacity: pool.capacity,
    createdAt: pool.created_at,
    id: pool.id,
    members: pool.members.map(personFromApi),
    owner: personFromApi(pool.owner),
    plan: pool.plan,
    requests: pool.requests.map(requestFromApi),
    usage: pool.usage.map((metric) => ({
      detail: metric.detail ?? undefined,
      label: metric.label,
      value: metric.value,
    })),
  };
}

function serviceError(error?: ErrorResponse) {
  return new AgentPoolServiceError(
    error?.message ?? "The account pools could not be loaded.",
  );
}

async function refreshHubSession() {
  const { data } = await client.POST("/auth/refresh");
  return Boolean(data);
}

async function list() {
  try {
    const result = await client.GET("/agent-pools");
    if (!result.data) throw serviceError(result.error);
    return result.data.map(poolFromApi);
  } catch (error) {
    if (error instanceof AgentPoolServiceError) throw error;
    throw new AgentPoolServiceError("The account pool service is unavailable.");
  }
}

async function requestJoin(poolId: string, values: CreateJoinRequest) {
  try {
    let result = await client.POST("/agent-pools/{connection_id}/requests", {
      body: values,
      params: { path: { connection_id: poolId } },
    });
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.POST("/agent-pools/{connection_id}/requests", {
        body: values,
        params: { path: { connection_id: poolId } },
      });
    }
    if (!result.data) throw serviceError(result.error);
    return requestFromApi(result.data);
  } catch (error) {
    if (error instanceof AgentPoolServiceError) throw error;
    throw new AgentPoolServiceError("The join request could not be sent.");
  }
}

async function decide(
  requestId: string,
  status: Exclude<AgentPoolRequestStatus, "pending">,
) {
  try {
    let result = await client.POST(
      "/agent-pool-requests/{request_id}/decision",
      {
        body: { status },
        params: { path: { request_id: requestId } },
      },
    );
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.POST("/agent-pool-requests/{request_id}/decision", {
        body: { status },
        params: { path: { request_id: requestId } },
      });
    }
    if (!result.data) throw serviceError(result.error);
    return requestFromApi(result.data);
  } catch (error) {
    if (error instanceof AgentPoolServiceError) throw error;
    throw new AgentPoolServiceError("The join request could not be updated.");
  }
}

function createdLabel(createdAt: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
    year: "numeric",
  }).format(new Date(createdAt));
}

const agentPoolsService = {
  createdLabel,
  decide,
  list,
  queryKey: ["agent-pools"] as const,
  requestJoin,
};

export default agentPoolsService;
