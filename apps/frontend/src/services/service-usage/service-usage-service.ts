import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type {
  ServiceUsage,
  ServiceUsageRow,
  ServiceUsageDay,
  ServiceUsageFilters,
} from "./service-usage-types";

type ApiUsage = components["schemas"]["GatewayUsage"];
type ApiUsageDay = components["schemas"]["GatewayUsageDay"];
type ApiUsageBreakdown = components["schemas"]["GatewayUsageBreakdown"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const GATEWAY_USAGE_UNAVAILABLE = "The usage service is unavailable.";

export class ServiceUsageError extends Error {}

function dayFromApi(day: ApiUsageDay): ServiceUsageDay {
  return {
    date: day.date,
    knownTotalTokens: day.known_total_tokens,
    requests: day.requests,
    tokenKnownRequests: day.token_known_requests,
  };
}

function breakdownFromApi(row: ApiUsageBreakdown): ServiceUsageRow {
  return {
    completedRequests: row.completed_requests,
    gatewayKeyId: row.gateway_key_id ?? null,
    spentMicro: row.spent_micro,
    keyLastFour: row.key_last_four ?? null,
    knownCachedTokens: row.known_cached_tokens,
    knownInputTokens: row.known_input_tokens,
    knownOutputTokens: row.known_output_tokens,
    model: row.model ?? null,
    provider: row.provider,
    requests: row.requests,
    tokenKnownRequests: row.token_known_requests,
  };
}

function usageFromApi(usage: ApiUsage): ServiceUsage {
  return {
    breakdown: usage.breakdown.map(breakdownFromApi),
    completedRequests: usage.completed_requests,
    dailyUsage: usage.daily_usage.map(dayFromApi),
    knownCachedTokens: usage.known_cached_tokens,
    knownInputTokens: usage.known_input_tokens,
    knownOutputTokens: usage.known_output_tokens,
    periodDays: usage.period_days,
    requests: usage.requests,
    spentMicro: usage.spent_micro,
    tokenKnownRequests: usage.token_known_requests,
  };
}

function usageError(error?: ErrorResponse) {
  return new ServiceUsageError(error?.message ?? "Usage could not be loaded.");
}

class ServiceUsageService {
  readonly baseUrl: string;

  readonly queryKey = ["service-usage"] as const;

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
   * Let service errors through and replace any other failure, such as a
   * network error, with the unavailable message.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ServiceUsageError) throw error;

      throw new ServiceUsageError(GATEWAY_USAGE_UNAVAILABLE);
    }
  }

  /**
   * Get what the signed-in user sent with service keys, and what it was
   * charged, over the last `days` UTC days. Hub keys and the Playground are not
   * counted.
   */
  async usage({ days }: ServiceUsageFilters): Promise<ServiceUsage> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.GET("/service/usage", { params: { query: { days } } }),
      );

      if (!result.data) throw usageError(result.error);

      return usageFromApi(result.data);
    });
  }
}

export const serviceUsageService = new ServiceUsageService();
