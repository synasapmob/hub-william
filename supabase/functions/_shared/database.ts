import {
  createClient,
  type SupabaseClient,
  type User,
} from "jsr:@supabase/supabase-js@2";

import { decryptCredential, encryptCredential } from "./crypto.ts";
import { ProviderRequestError } from "./http.ts";
import type {
  ProviderConnectionRow,
  StoredCredential,
} from "./provider-types.ts";

export type UserRole = "admin" | "moderator" | "member";

export interface ApprovedUser {
  user: User;
  role: UserRole;
}

interface CredentialRpcRow {
  credential_kind: string;
  ciphertext: string;
  initialization_vector: string;
  expires_at: string | null;
}

function requiredEnvironment(name: string) {
  const value = Deno.env.get(name);

  if (!value) {
    throw new Error("Backend configuration is required.");
  }

  return value;
}

export function serviceClient() {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
}

/** One atomic write prevents another collector from pruning a half-written row. */
export async function storeNewsItems(
  client: SupabaseClient,
  items: Array<Record<string, unknown>>,
  metrics: Array<Record<string, unknown>>,
  payloads: Array<Record<string, unknown>>,
) {
  const { data, error } = await client.rpc("store_news_items", {
    p_items: items,
    p_metrics: metrics,
    p_payloads: payloads,
  });
  if (error) throw error;

  return (data ?? []) as Array<{ stored_external_id: string }>;
}

export async function requireApprovedUser(
  request: Request,
  client = serviceClient(),
): Promise<ApprovedUser> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.replace(/^Bearer\s+/i, "");

  if (!token) {
    throw new ProviderRequestError("Authentication is required.", 401);
  }

  const { data, error } = await client.auth.getUser(token);

  if (error || !data.user) {
    throw new ProviderRequestError("Your session is no longer valid.", 401);
  }

  const { data: profile, error: profileError } = await client
    .from("profiles")
    .select("status, role")
    .eq("id", data.user.id)
    .maybeSingle();

  if (profileError || profile?.status !== "approved") {
    throw new ProviderRequestError(
      "This account cannot access the workspace.",
      403,
    );
  }

  // An unrecognised role is read as the least privileged one. The column is an
  // enum so this cannot happen today, but the alternative — trusting whatever
  // arrives — is the wrong default for the one value that decides who can mint
  // a key to every connected account.
  const role = profile.role as UserRole;

  return {
    user: data.user,
    role: role === "admin" || role === "moderator" ? role : "member",
  };
}

// Gateway keys are the one thing here an approved account is not automatically
// entitled to: a key proxies to every connected account and bills them. The
// database refuses the same write, so this exists to answer with something the
// dashboard can show rather than a 500 from a raised exception.
export function requireAdmin({ role }: ApprovedUser) {
  if (role !== "admin") {
    throw new ProviderRequestError(
      "Only an admin can manage gateway keys.",
      403,
    );
  }
}

export async function requireOwnedConnection(
  client: SupabaseClient,
  ownerId: string,
  connectionId: string,
) {
  const { data, error } = await client
    .from("provider_connections")
    .select("*")
    .eq("id", connectionId)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    throw new ProviderRequestError("Provider connection was not found.", 404);
  }

  return data as ProviderConnectionRow;
}

export async function storeCredential(
  client: SupabaseClient,
  connectionId: string,
  credential: StoredCredential,
) {
  const encrypted = await encryptCredential(credential);
  const expiresAt = credential.expiresAt;
  const { error } = await client.rpc("store_provider_credential", {
    p_connection_id: connectionId,
    p_credential_kind: credential.type,
    p_ciphertext: encrypted.ciphertext,
    p_initialization_vector: encrypted.initializationVector,
    p_expires_at: expiresAt,
  });

  if (error) {
    throw error;
  }
}

export async function readCredential(
  client: SupabaseClient,
  connectionId: string,
) {
  const { data, error } = await client.rpc("read_provider_credential", {
    p_connection_id: connectionId,
  });

  if (error) {
    throw error;
  }

  const row = (data as CredentialRpcRow[] | null)?.[0];

  if (!row) {
    throw new ProviderRequestError("Provider authorization is missing.", 409);
  }

  return decryptCredential({
    ciphertext: row.ciphertext,
    initializationVector: row.initialization_vector,
  });
}
