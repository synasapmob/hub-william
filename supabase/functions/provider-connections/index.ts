import {
  requireAdmin,
  requireApprovedUser,
  requireOwnedConnection,
  serviceClient,
  storeCredential,
  readCredential,
} from "../_shared/database.ts";
import {
  optionsResponse,
  jsonResponse,
  ProviderRequestError,
  publicError,
} from "../_shared/http.ts";
import type { ProviderConnectionRow } from "../_shared/provider-types.ts";
import { synchronizeConnection } from "../_shared/synchronize.ts";
import {
  CODEX_VERIFICATION_URL,
  exchangeCodexDeviceCode,
  pollCodexDeviceAuth as pollCodexDeviceAuthRequest,
  revokeCodexCredential,
  startCodexDeviceAuth as startCodexDeviceAuthRequest,
} from "../_shared/providers/codex-auth.ts";
import {
  gatewayKeyHint,
  generateGatewayKey,
  hashGatewayKey,
} from "../_shared/providers/codex-proxy.ts";

interface StartCodexDeviceAuthBody {
  action: "start-codex-device-auth";
}

interface PollCodexDeviceAuthBody {
  action: "poll-codex-device-auth";
  connectionId: string;
}

interface ReconnectCodexDeviceAuthBody {
  action: "reconnect-codex-device-auth";
  connectionId: string;
}

interface DisconnectBody {
  action: "disconnect";
  connectionId: string;
}

interface UntrackProjectBody {
  action: "untrack-project";
  projectId: string;
  agent: "codex" | "claude_code";
}

interface TrackFolderBody {
  action: "track-folder";
  folderName: string;
}

interface UntrackFolderBody {
  action: "untrack-folder";
  folderName: string;
}

interface ListGatewayKeysBody {
  action: "list-gateway-keys";
}

interface CreateGatewayKeyBody {
  action: "create-gateway-key";
  label?: string;
}

interface RevokeGatewayKeyBody {
  action: "revoke-gateway-key";
  keyId: string;
}

type RequestBody =
  | StartCodexDeviceAuthBody
  | PollCodexDeviceAuthBody
  | ReconnectCodexDeviceAuthBody
  | DisconnectBody
  | UntrackProjectBody
  | TrackFolderBody
  | UntrackFolderBody
  | ListGatewayKeysBody
  | CreateGatewayKeyBody
  | RevokeGatewayKeyBody;

interface GatewayKeyRow {
  id: string;
  label: string;
  hint: string;
  created_at: string;
}

const GATEWAY_KEY_LABEL_LIMIT = 60;

function gatewayKeyEntry(row: GatewayKeyRow) {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    createdAt: row.created_at,
  };
}

// Matches the check constraint on the column. Trimming rather than rejecting
// whitespace keeps a stray space from turning into an error the owner has to
// decipher; an empty label gets a name instead of a failure.
function gatewayKeyLabel(raw: string | undefined) {
  const label = raw?.trim() ?? "";

  if (label.length === 0) {
    return "Untitled key";
  }

  return label.slice(0, GATEWAY_KEY_LABEL_LIMIT);
}

// The plaintext key exists only inside this function and only in the response
// to the call that made it: the database stores a SHA-256 and there is no RPC
// that returns a key. "Shown once" is therefore a property of the system, not
// something the dashboard is trusted to honour.
async function createGatewayKey(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: CreateGatewayKeyBody,
) {
  const key = generateGatewayKey();

  // Keys accumulate rather than replace: the hub is shared, and generating one
  // for a new person must not cut off everyone already using it.
  const { data, error } = await client.rpc("store_gateway_key", {
    p_key_hash: await hashGatewayKey(key),
    p_owner_id: ownerId,
    p_label: gatewayKeyLabel(body.label),
    p_hint: gatewayKeyHint(key),
  });

  if (error) {
    // The cap is a guard against a runaway caller, so it reaches the owner as
    // an instruction rather than as a Postgres exception.
    if (error.message?.includes("gateway key limit reached")) {
      throw new ProviderRequestError(
        "This hub already has 20 gateway keys. Revoke one before creating another.",
        409,
      );
    }

    throw error;
  }

  const row = (data as GatewayKeyRow[] | null)?.[0];

  if (!row) {
    throw new Error("The gateway key could not be stored.");
  }

  return { key, entry: gatewayKeyEntry(row) };
}

// Everything about a key except the key: enough to tell one row from another,
// and to revoke the right one.
async function listGatewayKeys(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
) {
  const { data, error } = await client.rpc("list_gateway_keys", {
    p_owner_id: ownerId,
  });

  if (error) {
    throw error;
  }

  return {
    keys: ((data as GatewayKeyRow[] | null) ?? []).map(gatewayKeyEntry),
  };
}

async function revokeGatewayKey(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: RevokeGatewayKeyBody,
) {
  if (!body.keyId) {
    throw new ProviderRequestError("A gateway key id is required.");
  }

  const { data, error } = await client.rpc("delete_gateway_key", {
    p_owner_id: ownerId,
    p_key_id: body.keyId,
  });

  if (error) {
    throw error;
  }

  if (data !== true) {
    throw new ProviderRequestError("That gateway key was not found.", 404);
  }

  return { revoked: true };
}

async function startCodexDeviceAuth(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
) {
  // Placeholder only. The first sync rewrites display_name from the ChatGPT
  // account the user actually authorized, so no name is asked for up front.
  const displayName = "ChatGPT account";
  const device = await startCodexDeviceAuthRequest();
  const historyStartsAt = new Date(
    Date.UTC(new Date().getUTCFullYear(), 0, 1),
  ).toISOString();

  const { data, error } = await client.rpc("create_codex_device_auth", {
    p_owner_id: ownerId,
    p_display_name: displayName,
    p_device_auth_id: device.deviceAuthId,
    p_user_code: device.userCode,
    p_expires_at: device.expiresAt,
    p_history_starts_at: historyStartsAt,
  });

  if (error) {
    throw error;
  }

  const connectionId = (data as Array<{ connection_id: string }> | null)?.[0]
    ?.connection_id;

  if (!connectionId) {
    throw new Error("Codex sign-in could not be started.");
  }

  return {
    connectionId,
    userCode: device.userCode,
    verificationUrl: CODEX_VERIFICATION_URL,
    intervalSeconds: device.intervalSeconds,
  };
}

interface DeviceAuthSessionRow {
  device_auth_id: string;
  user_code: string;
  expires_at: string;
  consumed_at: string | null;
}

// Any other Codex connection this owner already has for the same ChatGPT
// account. Excludes the in-flight placeholder so it never matches itself.
async function findExistingCodexConnection(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  pendingConnectionId: string,
  chatgptAccountId: string | null,
) {
  if (!chatgptAccountId) {
    return null;
  }

  const { data, error } = await client
    .from("provider_connections")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("external_account_id", chatgptAccountId)
    .neq("id", pendingConnectionId)
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as ProviderConnectionRow | null) ?? null;
}

// One poll attempt, driven by the browser. Returns immediately so the Edge
// Function never sits waiting on a human approving in another tab.
async function pollCodexDeviceAuth(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: PollCodexDeviceAuthBody,
) {
  const connection = await requireOwnedConnection(
    client,
    ownerId,
    body.connectionId,
  );

  if (connection.status === "connected") {
    return { status: "connected" as const, connectionId: connection.id };
  }

  const { data, error } = await client.rpc("read_codex_device_auth", {
    p_connection_id: connection.id,
    p_owner_id: ownerId,
  });

  if (error) {
    throw error;
  }

  const session = (data as DeviceAuthSessionRow[] | null)?.[0];

  // A consumed session means the authorization already succeeded. Report the
  // real connection state rather than 409-ing forever: the credential is
  // stored, so only the first sync can still be outstanding.
  if (!session) {
    return { status: "expired" as const, connectionId: connection.id };
  }

  if (session.consumed_at) {
    return {
      status:
        connection.status === "verifying"
          ? ("pending" as const)
          : ("connected" as const),
      connectionId: connection.id,
    };
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    return { status: "expired" as const, connectionId: connection.id };
  }

  const poll = await pollCodexDeviceAuthRequest(
    session.device_auth_id,
    session.user_code,
  );

  if (poll.state === "pending") {
    return { status: "pending" as const, connectionId: connection.id };
  }

  if (poll.state === "expired") {
    return { status: "expired" as const, connectionId: connection.id };
  }

  // Consume before exchanging so two concurrent polls cannot both redeem it.
  const { data: consumed, error: consumeError } = await client.rpc(
    "consume_codex_device_auth",
    { p_connection_id: connection.id, p_owner_id: ownerId },
  );

  if (consumeError) {
    throw consumeError;
  }

  if (consumed !== true) {
    return { status: "pending" as const, connectionId: connection.id };
  }

  const credential = await exchangeCodexDeviceCode(
    poll.authorizationCode,
    poll.codeVerifier,
  );

  // The id_token identifies the account before any sync runs, so the same
  // ChatGPT account cannot be connected twice. Adopting the existing row keeps
  // its history instead of stranding it beside a duplicate.
  const existing = await findExistingCodexConnection(
    client,
    ownerId,
    connection.id,
    credential.chatgptAccountId,
  );

  if (existing) {
    await storeCredential(client, existing.id, credential);
    await client.from("provider_connections").delete().eq("id", connection.id);

    try {
      await synchronizeConnection(client, existing);
    } catch (syncError) {
      console.error(
        "Codex refresh after duplicate failed",
        publicError(syncError),
      );
    }

    return {
      status: "connected" as const,
      connectionId: existing.id,
      alreadyConnected: true,
    };
  }

  await storeCredential(client, connection.id, credential);

  // Recorded now rather than after the first sync, so an account whose sync
  // fails is still matchable and cannot be connected a second time.
  if (credential.chatgptAccountId) {
    await client
      .from("provider_connections")
      .update({ external_account_id: credential.chatgptAccountId })
      .eq("id", connection.id);
  }

  // The account is authorized the moment the credential is stored. A failing
  // first sync is a data problem, not an auth problem, so it must not strand
  // the connection in 'verifying' — mark it connected and let the normal sync
  // path report and retry the failure.
  try {
    await synchronizeConnection(client, connection);
  } catch (syncError) {
    console.error("Codex first sync failed", publicError(syncError));
    await client
      .from("provider_connections")
      .update({ status: "needs_attention", last_error: publicError(syncError) })
      .eq("id", connection.id);
  }

  return { status: "connected" as const, connectionId: connection.id };
}

// Re-opens device authorization for a connection that already exists, so an
// expired or stranded sign-in can be recovered without losing its history.
async function reconnectCodexDeviceAuth(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: ReconnectCodexDeviceAuthBody,
) {
  const connection = await requireOwnedConnection(
    client,
    ownerId,
    body.connectionId,
  );

  if (connection.metadata?.product !== "codex") {
    throw new ProviderRequestError("This connection is not a Codex account.");
  }

  const device = await startCodexDeviceAuthRequest();
  const { data, error } = await client.rpc("restart_codex_device_auth", {
    p_connection_id: connection.id,
    p_owner_id: ownerId,
    p_device_auth_id: device.deviceAuthId,
    p_user_code: device.userCode,
    p_expires_at: device.expiresAt,
  });

  if (error) {
    throw error;
  }

  if (data !== true) {
    throw new ProviderRequestError("Provider connection was not found.", 404);
  }

  return {
    connectionId: connection.id,
    userCode: device.userCode,
    verificationUrl: CODEX_VERIFICATION_URL,
    intervalSeconds: device.intervalSeconds,
  };
}

async function disconnect(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  connectionId: string,
) {
  const connection = await requireOwnedConnection(
    client,
    ownerId,
    connectionId,
  );

  {
    try {
      const credential = await readCredential(client, connection.id);

      if (credential.type === "codex_oauth") {
        const revoked = await revokeCodexCredential(credential);

        if (!revoked) {
          // Local deletion still proceeds, but this must not be silent: the
          // refresh token may remain live at OpenAI.
          console.error(
            "Codex revocation was not accepted by OpenAI; the local credential was still deleted.",
          );
        }
      }
    } catch {
      // Revocation is best-effort; local deletion remains mandatory.
    }
  }

  const { error } = await client
    .from("provider_connections")
    .delete()
    .eq("id", connection.id)
    .eq("owner_id", ownerId);

  if (error) {
    throw error;
  }
}

async function untrackProject(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: UntrackProjectBody,
) {
  const { data, error } = await client.rpc("untrack_agent_project", {
    p_owner_id: ownerId,
    p_project_id: body.projectId,
    p_agent: body.agent,
  });

  if (error) throw error;
  if (data !== true) {
    throw new ProviderRequestError("Project was not found.", 404);
  }
}

const FOLDER_NAME_LIMIT = 120;

// A folder name, not a path: the hub matches on the last segment of the working
// directory an agent reports, so a leading path here would never match anything.
function folderName(value: unknown) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const name = trimmed.replaceAll("\\", "/").split("/").filter(Boolean).at(-1);

  if (!name || name.length > FOLDER_NAME_LIMIT) {
    throw new ProviderRequestError("A folder name is required.");
  }

  return name;
}

// The list starts empty and empty means "collect everything", so the first entry
// is the moment collection narrows. Everything unlisted stops being stored from
// that point on, which is the whole purpose of adding one.
async function trackFolder(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: TrackFolderBody,
) {
  const name = folderName(body.folderName);
  const { error } = await client
    .from("tracked_projects")
    .upsert(
      { owner_id: ownerId, folder_name: name },
      { onConflict: "owner_id,folder_name" },
    );

  if (error) throw error;

  return { folderName: name };
}

async function untrackFolder(
  client: ReturnType<typeof serviceClient>,
  ownerId: string,
  body: UntrackFolderBody,
) {
  const name = folderName(body.folderName);
  const { error } = await client
    .from("tracked_projects")
    .delete()
    .eq("owner_id", ownerId)
    .eq("folder_name", name);

  if (error) throw error;

  return { folderName: name };
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
    const approved = await requireApprovedUser(request, client);
    const { user } = approved;
    const body = (await request.json()) as RequestBody;

    switch (body.action) {
      case "start-codex-device-auth": {
        const device = await startCodexDeviceAuth(client, user.id);
        return jsonResponse(request, device, 201);
      }
      case "poll-codex-device-auth": {
        const result = await pollCodexDeviceAuth(client, user.id, body);
        return jsonResponse(request, result);
      }
      case "reconnect-codex-device-auth": {
        const device = await reconnectCodexDeviceAuth(client, user.id, body);
        return jsonResponse(request, device, 201);
      }
      case "disconnect":
        await disconnect(client, user.id, body.connectionId);
        return jsonResponse(request, { disconnected: true });
      case "untrack-project":
        await untrackProject(client, user.id, body);
        return jsonResponse(request, { untracked: true });
      case "track-folder":
        return jsonResponse(
          request,
          await trackFolder(client, user.id, body),
          201,
        );
      case "untrack-folder":
        return jsonResponse(
          request,
          await untrackFolder(client, user.id, body),
        );
      case "list-gateway-keys":
        return jsonResponse(request, await listGatewayKeys(client, user.id));
      case "create-gateway-key":
        requireAdmin(approved);
        return jsonResponse(
          request,
          await createGatewayKey(client, user.id, body),
          201,
        );
      case "revoke-gateway-key":
        requireAdmin(approved);
        return jsonResponse(
          request,
          await revokeGatewayKey(client, user.id, body),
        );
      default:
        throw new ProviderRequestError("Unsupported provider action.");
    }
  } catch (error) {
    console.error("Provider connection request failed", publicError(error));
    const status = error instanceof ProviderRequestError ? error.status : 500;
    return jsonResponse(request, { error: publicError(error) }, status);
  }
});
