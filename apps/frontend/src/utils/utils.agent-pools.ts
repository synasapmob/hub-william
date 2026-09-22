import type {
  AgentPool,
  AgentPoolAvailabilityStatus,
  AgentPoolUsageMetric,
  AgentProvider,
} from "@/services/agent-pools";

export const AGENT_PROVIDERS: AgentProvider[] = [
  "ChatGPT",
  "Claude",
  "Gemini",
  "Grok",
  "DeepSeek",
];
const quotaLabels = [
  "5-hour limit",
  "Weekly limit",
  "Monthly limit",
  "Usage limit",
  "Sonnet weekly",
];

export type AgentPoolAccess =
  "owner" | "joined" | "pending" | "rejected" | "request";

export const agentPoolAccessLabels: Record<AgentPoolAccess, string> = {
  owner: "Owner",
  joined: "Joined",
  pending: "Request pending",
  rejected: "Rejected",
  request: "Open to join",
};

export const agentPoolAvailabilityLabels: Record<
  AgentPoolAvailabilityStatus,
  string
> = {
  active: "Active",
  half_open: "Ready to retry",
  rate_limited: "Cooling down",
  reauth_required: "Reconnect required",
};

export function agentPoolAccess(pool: AgentPool, username: string | null) {
  if (username === pool.owner.username) return "owner";
  if (pool.members.some((member) => member.username === username))
    return "joined";
  const request = pool.requests.find((item) => item.username === username);
  if (request?.status === "accepted") return "joined";
  if (request) return request.status;
  return "request";
}

export function agentPoolPrimaryUsage(pool: Pick<AgentPool, "usage">) {
  return quotaLabels
    .map((label) => pool.usage.find((metric) => metric.label === label))
    .find((metric) => metric && metric.value !== "Unavailable");
}

export function agentPoolRemaining(metric: AgentPoolUsageMetric) {
  const match = /^(\d+(?:\.\d+)?)%\s+(remaining|used)$/i.exec(metric.value);
  if (!match) return null;
  const percent = Number(match[1]);
  return Math.max(
    0,
    Math.min(100, match[2].toLowerCase() === "used" ? 100 - percent : percent),
  );
}

export function agentPoolWarning(
  pool: Pick<AgentPool, "usage" | "availability">,
) {
  if (pool.availability.status !== "active")
    return agentPoolAvailabilityLabels[pool.availability.status];
  const exhausted = pool.usage.find(
    (metric) => agentPoolRemaining(metric) === 0,
  );
  return exhausted ? `${exhausted.label} exhausted` : null;
}

export function agentPoolUsageValue(metric: AgentPoolUsageMetric) {
  const remaining = agentPoolRemaining(metric);
  return remaining === null
    ? metric.value
    : `${Number(remaining.toFixed(1))}% remaining`;
}

export function agentPoolTokenDetail(pool: Pick<AgentPool, "usage">) {
  // Token counts are optional provider data, not the placeholder member shares.
  for (const metric of pool.usage) {
    const tokens = metric.detail
      ?.split(" · ")
      .find((detail) => /\btokens\b/i.test(detail));
    if (tokens) return `${tokens} · ${metric.label}`;
  }
}
