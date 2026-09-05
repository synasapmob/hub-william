// OAuth for ChatGPT-subscription Codex accounts.
//
// Codex's device flow is proprietary, not RFC 8628: auth.openai.com advertises
// only authorization_code and refresh_token in its OIDC discovery document, and
// exposes no device_authorization_endpoint. The real flow lives under
// /api/accounts/deviceauth/* and hands back an authorization_code plus the
// code_verifier that matches it, which is then exchanged normally.
// Verified against codex-cli 0.146.0 (codex-rs/login/src/device_code_auth.rs).
//
// None of this is a documented, supported API. Every response is parsed
// defensively and every field is treated as optional.

import { ProviderRequestError } from "../http.ts";
import type { CodexOAuthCredential } from "../provider-types.ts";

const ISSUER = "https://auth.openai.com";
const API_BASE = `${ISSUER}/api/accounts`;
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

// The backend gates on originator and a matching User-Agent; a mismatch is a
// 403 from the edge rather than an application error.
const CODEX_UA = "codex_cli_rs/0.146.0";

export const CODEX_VERIFICATION_URL = `${ISSUER}/codex/device`;
const DEVICE_REDIRECT_URI = `${ISSUER}/deviceauth/callback`;

function codexHeaders(contentType?: string) {
  const headers: Record<string, string> = {
    "User-Agent": CODEX_UA,
    originator: "codex_cli_rs",
    Accept: "application/json",
  };
  if (contentType) headers["Content-Type"] = contentType;
  return headers;
}

export interface CodexDeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  expiresAt: string;
}

export async function startCodexDeviceAuth(): Promise<CodexDeviceAuthStart> {
  const response = await fetch(`${API_BASE}/deviceauth/usercode`, {
    method: "POST",
    headers: codexHeaders("application/json"),
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });

  if (!response.ok) {
    throw new ProviderRequestError(
      "OpenAI could not start the sign-in. Try again in a moment.",
      502,
    );
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const deviceAuthId = payload.device_auth_id;
  const userCode = payload.user_code ?? payload.usercode;

  if (typeof deviceAuthId !== "string" || typeof userCode !== "string") {
    throw new ProviderRequestError(
      "OpenAI returned an unexpected sign-in response.",
      502,
    );
  }

  const intervalSeconds = Math.min(
    Math.max(Number(payload.interval) || 5, 2),
    30,
  );
  const expiresAt =
    typeof payload.expires_at === "string"
      ? new Date(payload.expires_at).toISOString()
      : new Date(Date.now() + 15 * 60_000).toISOString();

  return { deviceAuthId, userCode, intervalSeconds, expiresAt };
}

export type CodexDevicePoll =
  | { state: "pending" }
  | { state: "expired" }
  | { state: "approved"; authorizationCode: string; codeVerifier: string };

// One poll attempt. The browser drives the cadence so the Edge Function never
// blocks on a human; 403 with deviceauth_authorization_pending is the normal
// not-yet-approved answer, not an error.
export async function pollCodexDeviceAuth(
  deviceAuthId: string,
  userCode: string,
): Promise<CodexDevicePoll> {
  const response = await fetch(`${API_BASE}/deviceauth/token`, {
    method: "POST",
    headers: codexHeaders("application/json"),
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
  });

  const text = await response.text();
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // A non-JSON body means an edge block, handled as pending-or-expired below.
  }

  if (response.ok) {
    const authorizationCode = payload.authorization_code;
    const codeVerifier = payload.code_verifier;

    if (
      typeof authorizationCode === "string" &&
      typeof codeVerifier === "string"
    ) {
      return { state: "approved", authorizationCode, codeVerifier };
    }
    return { state: "pending" };
  }

  const code = (payload.error as Record<string, unknown> | undefined)?.code;

  if (code === "deviceauth_authorization_pending") {
    return { state: "pending" };
  }

  if (
    code === "deviceauth_expired" ||
    code === "deviceauth_not_found" ||
    response.status === 404
  ) {
    return { state: "expired" };
  }

  // 403 without a recognised code is still most likely "not approved yet".
  if (response.status === 403) {
    return { state: "pending" };
  }

  throw new ProviderRequestError(
    "OpenAI rejected the sign-in attempt. Start again.",
    502,
  );
}

interface CodexTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function chatgptAccountIdFromIdToken(idToken: string | null) {
  if (!idToken) return null;

  try {
    const segment = idToken.split(".")[1];
    if (!segment) return null;

    const normalized = segment.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "=",
    );
    const claims = JSON.parse(atob(padded)) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"] as
      Record<string, unknown> | undefined;
    const accountId = auth?.chatgpt_account_id ?? auth?.organization_id;

    return typeof accountId === "string" ? accountId : null;
  } catch {
    return null;
  }
}

function toCredential(payload: CodexTokenResponse): CodexOAuthCredential {
  if (!payload.access_token || !payload.refresh_token) {
    throw new ProviderRequestError(
      "OpenAI did not return a usable authorization.",
      502,
    );
  }

  const idToken = payload.id_token ?? null;
  const expiresIn = Number(payload.expires_in) || 3600;

  return {
    type: "codex_oauth",
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    idToken,
    expiresAt: new Date(Date.now() + expiresIn * 1_000).toISOString(),
    chatgptAccountId: chatgptAccountIdFromIdToken(idToken),
  };
}

export async function exchangeCodexDeviceCode(
  authorizationCode: string,
  codeVerifier: string,
): Promise<CodexOAuthCredential> {
  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: codexHeaders("application/x-www-form-urlencoded"),
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code: authorizationCode,
      code_verifier: codeVerifier,
      redirect_uri: DEVICE_REDIRECT_URI,
    }).toString(),
  });

  if (!response.ok) {
    throw new ProviderRequestError(
      "OpenAI declined to complete the sign-in.",
      502,
    );
  }

  return toCredential((await response.json()) as CodexTokenResponse);
}

// A refresh that fails permanently must surface as "reconnect", not as a
// transient sync error, otherwise the connection retries a dead token forever.
const permanentRefreshErrors = [
  "refresh_token_expired",
  "refresh_token_reused",
  "refresh_token_invalidated",
  "invalid_grant",
];

// Extends ProviderRequestError so publicError() surfaces the actionable
// message to the dashboard instead of a generic sync failure.
export class CodexReauthRequiredError extends ProviderRequestError {
  constructor() {
    super("Codex sign-in expired. Reconnect this account.", 401);
    this.name = "CodexReauthRequiredError";
  }
}

export async function refreshCodexCredential(
  credential: CodexOAuthCredential,
): Promise<CodexOAuthCredential> {
  const response = await fetch(`${API_BASE}/oauth/token`, {
    method: "POST",
    headers: codexHeaders("application/json"),
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    if (permanentRefreshErrors.some((marker) => text.includes(marker))) {
      throw new CodexReauthRequiredError();
    }
    throw new ProviderRequestError(
      "Codex authorization could not be refreshed.",
      502,
    );
  }

  const payload = JSON.parse(text) as CodexTokenResponse;
  const refreshed = toCredential({
    ...payload,
    // OpenAI may omit a rotated refresh token; keep the working one.
    refresh_token: payload.refresh_token ?? credential.refreshToken,
    id_token: payload.id_token ?? credential.idToken ?? undefined,
  });

  return {
    ...refreshed,
    chatgptAccountId: refreshed.chatgptAccountId ?? credential.chatgptAccountId,
  };
}

// Revocation must use the same originator/User-Agent as every other call to
// auth.openai.com, or the edge rejects it before the revoke handler runs.
// Returns whether OpenAI actually accepted the revocation.
export async function revokeCodexCredential(
  credential: CodexOAuthCredential,
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/oauth/revoke`, {
      method: "POST",
      headers: codexHeaders("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        token: credential.refreshToken,
      }).toString(),
    });

    return response.ok;
  } catch {
    return false;
  }
}

export async function activeCodexCredential(credential: CodexOAuthCredential) {
  const expiresAt = new Date(credential.expiresAt).getTime();

  if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 120_000) {
    return credential;
  }

  return refreshCodexCredential(credential);
}
