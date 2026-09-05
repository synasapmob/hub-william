import {
  requireApprovedUser,
  requireOwnedConnection,
  serviceClient,
} from "../_shared/database.ts";
import {
  jsonResponse,
  optionsResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import type { ProviderConnectionRow } from "../_shared/provider-types.ts";
import { synchronizeConnection } from "../_shared/synchronize.ts";

interface SyncBody {
  connectionId?: string;
}

async function synchronizeDueConnections(
  client: ReturnType<typeof serviceClient>,
) {
  const cutoff = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  const { data, error } = await client
    .from("provider_connections")
    .select("*")
    // A collector has nothing to pull: Claude Code pushes its own telemetry and
    // the connection carries no credential by design, so syncing one can only
    // ever fail. Left in the sweep it would mark every project needs_attention
    // once a day and undo itself only when the next session happened to report.
    .neq("connection_method", "collector")
    .in("status", ["connected", "needs_attention"])
    .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`)
    .limit(20);

  if (error) {
    throw error;
  }

  let synchronized = 0;
  let failed = 0;

  for (const row of data ?? []) {
    try {
      await synchronizeConnection(client, row as ProviderConnectionRow);
      synchronized += 1;
    } catch {
      failed += 1;
    }
  }

  return { synchronized, failed };
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return optionsResponse(request);
  }

  if (request.method !== "POST") {
    return jsonResponse(request, { error: "Method not allowed." }, 405);
  }

  try {
    const client = serviceClient();
    const syncSecret = Deno.env.get("PROVIDER_SYNC_SECRET");
    const scheduled = Boolean(
      syncSecret && request.headers.get("x-sync-secret") === syncSecret,
    );

    if (scheduled) {
      return jsonResponse(request, await synchronizeDueConnections(client));
    }

    const { user } = await requireApprovedUser(request, client);
    const body = (await request.json()) as SyncBody;

    if (!body.connectionId) {
      throw new ProviderRequestError("Provider connection is required.");
    }

    const connection = await requireOwnedConnection(
      client,
      user.id,
      body.connectionId,
    );
    await synchronizeConnection(client, connection);

    return jsonResponse(request, { synchronized: true });
  } catch (error) {
    console.error("Provider synchronization failed", publicError(error));
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
