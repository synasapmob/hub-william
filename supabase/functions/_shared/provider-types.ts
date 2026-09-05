export type ProviderId = "openai";
export type ConnectionMethod = "admin_key" | "oauth" | "collector";

export interface ProviderConnectionRow {
  id: string;
  owner_id: string;
  provider: ProviderId;
  connection_method: ConnectionMethod;
  status: "verifying" | "connected" | "needs_attention" | "disconnected";
  display_name: string;
  external_account_id: string | null;
  email: string | null;
  workspace_name: string | null;
  history_starts_at: string;
  capabilities: Record<string, boolean>;
  metadata: Record<string, unknown>;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface UsageBucketInput {
  period_start: string;
  period_end: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_input_tokens: number;
  request_count: number;
  source_key: string;
  // Codex reports one account-wide total per day with no input/output split.
  total_tokens?: number | null;
}

export interface CostBucketInput {
  period_start: string;
  period_end: string;
  amount: number;
  currency: string;
  cost_type: "reported" | "estimated";
  line_item: string;
  source_key: string;
}

export interface UsageLimitInput {
  metric_key: string;
  label: string;
  kind: string;
  unit: string;
  scope: string;
  model: string;
  window: string | null;
  used: number | null;
  limit_value: number | null;
  remaining: number | null;
  resets_at: string | null;
}

export interface ProviderIdentityUpdate {
  externalAccountId?: string;
  email?: string;
  workspaceName?: string;
  // Set only by providers that name the connection from the authenticated
  // account itself, so the user is never asked to invent a label.
  displayName?: string;
}

export interface ProviderUsageSummaryInput {
  lifetime_tokens: number | null;
  peak_daily_tokens: number | null;
  longest_running_turn_seconds: number | null;
  current_streak_days: number | null;
  longest_streak_days: number | null;
}

export interface ProviderResetCreditsInput {
  available_count: number;
  total_earned_count: number;
  credits: unknown[];
}

export interface ProviderSyncResult {
  usage: UsageBucketInput[];
  costs: CostBucketInput[];
  limits: UsageLimitInput[];
  capabilities: Record<string, boolean>;
  identity?: ProviderIdentityUpdate;
  updatedCredential?: StoredCredential;
  summary?: ProviderUsageSummaryInput;
  resetCredits?: ProviderResetCreditsInput;
  metadata?: Record<string, unknown>;
}

export interface CodexOAuthCredential {
  type: "codex_oauth";
  accessToken: string;
  refreshToken: string;
  idToken: string | null;
  expiresAt: string;
  chatgptAccountId: string | null;
}

export type StoredCredential = CodexOAuthCredential;
