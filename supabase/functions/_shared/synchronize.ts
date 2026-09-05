import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

import { ProviderRequestError, publicError } from "./http.ts";
import { readCredential, storeCredential } from "./database.ts";
import type {
  CodexOAuthCredential,
  ProviderConnectionRow,
  ProviderSyncResult,
  StoredCredential,
} from "./provider-types.ts";
import { syncCodex } from "./providers/codex.ts";

export function isCodexConnection(connection: ProviderConnectionRow) {
  return connection.metadata?.product === "codex";
}

function assertCodexCredential(
  credential: StoredCredential,
): asserts credential is CodexOAuthCredential {
  if (credential.type !== "codex_oauth") {
    throw new Error("Provider authorization type is invalid.");
  }
}

async function fetchProviderUsage(
  connection: ProviderConnectionRow,
  credential: StoredCredential,
  persistCredential?: (credential: StoredCredential) => Promise<void>,
) {
  assertCodexCredential(credential);
  return syncCodex(connection, credential, persistCredential);
}

async function persistSyncResult(
  client: SupabaseClient,
  connectionId: string,
  result: ProviderSyncResult,
) {
  const observedAt = new Date().toISOString();

  if (result.usage.length > 0) {
    const firstPeriod = result.usage.reduce(
      (earliest, bucket) =>
        bucket.period_start < earliest ? bucket.period_start : earliest,
      result.usage[0].period_start,
    );
    for (let index = 0; index < result.usage.length; index += 500) {
      const chunk = result.usage.slice(index, index + 500);
      const { error: upsertError } = await client.from("usage_buckets").upsert(
        chunk.map((bucket) => ({
          ...bucket,
          connection_id: connectionId,
          observed_at: observedAt,
        })),
        {
          onConflict: "connection_id,period_start,period_end,model,source_key",
        },
      );

      if (upsertError) {
        throw upsertError;
      }
    }

    const { error: deleteError } = await client
      .from("usage_buckets")
      .delete()
      .eq("connection_id", connectionId)
      .gte("period_start", firstPeriod)
      .lt("observed_at", observedAt);

    if (deleteError) {
      throw deleteError;
    }
  }

  if (result.costs.length > 0) {
    const firstPeriod = result.costs.reduce(
      (earliest, bucket) =>
        bucket.period_start < earliest ? bucket.period_start : earliest,
      result.costs[0].period_start,
    );
    for (let index = 0; index < result.costs.length; index += 500) {
      const chunk = result.costs.slice(index, index + 500);
      const { error: upsertError } = await client.from("cost_buckets").upsert(
        chunk.map((bucket) => ({
          ...bucket,
          connection_id: connectionId,
          observed_at: observedAt,
        })),
        {
          onConflict:
            "connection_id,period_start,period_end,line_item,source_key",
        },
      );

      if (upsertError) {
        throw upsertError;
      }
    }

    const { error: deleteError } = await client
      .from("cost_buckets")
      .delete()
      .eq("connection_id", connectionId)
      .gte("period_start", firstPeriod)
      .lt("observed_at", observedAt);

    if (deleteError) {
      throw deleteError;
    }
  }

  if (result.limits.length > 0) {
    const { error: upsertLimitError } = await client
      .from("usage_limits")
      .upsert(
        result.limits.map((limit) => {
          const { window, ...storedLimit } = limit;

          return {
            ...storedLimit,
            window_name: window,
            connection_id: connectionId,
            observed_at: observedAt,
          };
        }),
        { onConflict: "connection_id,metric_key,model" },
      );

    if (upsertLimitError) {
      throw upsertLimitError;
    }
  }

  if (result.summary) {
    const { error: summaryError } = await client
      .from("provider_usage_summaries")
      .upsert(
        {
          ...result.summary,
          connection_id: connectionId,
          observed_at: observedAt,
        },
        { onConflict: "connection_id" },
      );

    if (summaryError) {
      throw summaryError;
    }
  }

  if (result.resetCredits) {
    const { error: creditsError } = await client
      .from("provider_reset_credits")
      .upsert(
        {
          ...result.resetCredits,
          connection_id: connectionId,
          observed_at: observedAt,
        },
        { onConflict: "connection_id" },
      );

    if (creditsError) {
      throw creditsError;
    }
  }

  let deleteLimits = client
    .from("usage_limits")
    .delete()
    .eq("connection_id", connectionId);

  if (result.limits.length > 0) {
    deleteLimits = deleteLimits.lt("observed_at", observedAt);
  }

  const { error: deleteLimitError } = await deleteLimits;

  if (deleteLimitError) {
    throw deleteLimitError;
  }
}

export async function synchronizeConnection(
  client: SupabaseClient,
  connection: ProviderConnectionRow,
) {
  const staleRunCutoff = new Date(Date.now() - 10 * 60 * 1_000).toISOString();
  const { error: staleRunError } = await client
    .from("provider_sync_runs")
    .update({
      status: "failed",
      completed_at: new Date().toISOString(),
      error: "Synchronization timed out.",
    })
    .eq("connection_id", connection.id)
    .eq("status", "running")
    .lt("started_at", staleRunCutoff);

  if (staleRunError) {
    throw staleRunError;
  }

  const { data: syncRun, error: syncRunError } = await client
    .from("provider_sync_runs")
    .insert({ connection_id: connection.id, status: "running" })
    .select("id")
    .single();

  if (syncRunError) {
    if (syncRunError.code === "23505") {
      throw new ProviderRequestError(
        "This provider is already synchronizing.",
        409,
      );
    }

    throw syncRunError;
  }

  try {
    const credential = await readCredential(client, connection.id);
    const result = await fetchProviderUsage(connection, credential, (rotated) =>
      storeCredential(client, connection.id, rotated),
    );

    await persistSyncResult(client, connection.id, result);

    if (result.updatedCredential) {
      await storeCredential(client, connection.id, result.updatedCredential);
    }

    const identity = result.identity;
    const { error: connectionError } = await client
      .from("provider_connections")
      .update({
        status: "connected",
        capabilities: result.capabilities,
        external_account_id:
          identity?.externalAccountId ?? connection.external_account_id,
        email: identity?.email ?? connection.email,
        display_name: identity?.displayName ?? connection.display_name,
        workspace_name: identity?.workspaceName ?? connection.workspace_name,
        metadata: result.metadata
          ? { ...connection.metadata, ...result.metadata }
          : connection.metadata,
        last_synced_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", connection.id);

    if (connectionError) {
      throw connectionError;
    }

    await client
      .from("provider_sync_runs")
      .update({ status: "succeeded", completed_at: new Date().toISOString() })
      .eq("id", syncRun.id);

    return result;
  } catch (error) {
    const message = publicError(error);

    await Promise.all([
      client
        .from("provider_connections")
        .update({ status: "needs_attention", last_error: message })
        .eq("id", connection.id),
      client
        .from("provider_sync_runs")
        .update({
          status: "failed",
          completed_at: new Date().toISOString(),
          error: message,
        })
        .eq("id", syncRun.id),
    ]);

    throw error;
  }
}
