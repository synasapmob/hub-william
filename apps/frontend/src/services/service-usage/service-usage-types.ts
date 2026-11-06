export interface ServiceUsageDay {
  date: string;
  knownTotalTokens: number;
  requests: number;
  tokenKnownRequests: number;
}

export interface ServiceUsageRow {
  completedRequests: number;
  // The service key that sent the requests. Both are null for a key that has
  // since been deleted.
  gatewayKeyId: string | null;
  keyLastFour: string | null;
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  model: string | null;
  provider: string;
  requests: number;
  // What these requests were charged to the wallet, in micro-dollars.
  spentMicro: number;
  tokenKnownRequests: number;
}

export interface ServiceUsage {
  breakdown: ServiceUsageRow[];
  // Requests the provider finished; the rest were abandoned or failed.
  completedRequests: number;
  dailyUsage: ServiceUsageDay[];
  knownCachedTokens: number;
  knownInputTokens: number;
  knownOutputTokens: number;
  periodDays: number;
  requests: number;
  // What the requests were charged to the wallet, in micro-dollars.
  spentMicro: number;
  tokenKnownRequests: number;
}

export interface ServiceUsageFilters {
  days: number;
}
