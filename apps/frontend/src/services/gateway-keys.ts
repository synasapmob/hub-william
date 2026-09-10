import createClient from "openapi-fetch";

import type { components, paths } from "./api.generated";

type ApiGatewayKey = components["schemas"]["GatewayKey"];
type ApiCreatedGatewayKey = components["schemas"]["CreatedGatewayKey"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

export interface GatewayKey {
  createdAt: string;
  id: string;
  lastFour: string;
  lastUsedAt: string | null;
}

export interface CreatedGatewayKey extends GatewayKey {
  key: string;
}

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

export class GatewayKeyServiceError extends Error {}

function gatewayKeyFromApi(key: ApiGatewayKey): GatewayKey {
  return {
    createdAt: key.created_at,
    id: key.id,
    lastFour: key.last_four,
    lastUsedAt: key.last_used_at ?? null,
  };
}

function createdGatewayKeyFromApi(
  key: ApiCreatedGatewayKey,
): CreatedGatewayKey {
  return { ...gatewayKeyFromApi(key), key: key.key };
}

function serviceError(error?: ErrorResponse) {
  return new GatewayKeyServiceError(
    error?.message ?? "The gateway key request could not be completed.",
  );
}

async function refreshHubSession() {
  const { data } = await client.POST("/auth/refresh");
  return Boolean(data);
}

async function create() {
  try {
    let result = await client.POST("/gateway-keys");
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.POST("/gateway-keys");
    }
    if (!result.data) throw serviceError(result.error);
    return createdGatewayKeyFromApi(result.data);
  } catch (error) {
    if (error instanceof GatewayKeyServiceError) throw error;
    throw new GatewayKeyServiceError("The gateway key service is unavailable.");
  }
}

async function list() {
  try {
    let result = await client.GET("/gateway-keys");
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.GET("/gateway-keys");
    }
    if (!result.data) throw serviceError(result.error);
    return result.data.map(gatewayKeyFromApi);
  } catch (error) {
    if (error instanceof GatewayKeyServiceError) throw error;
    throw new GatewayKeyServiceError("The gateway key service is unavailable.");
  }
}

async function revoke(keyId: string) {
  try {
    let result = await client.DELETE("/gateway-keys/{key_id}", {
      params: { path: { key_id: keyId } },
    });
    if (result.response.status === 401 && (await refreshHubSession())) {
      result = await client.DELETE("/gateway-keys/{key_id}", {
        params: { path: { key_id: keyId } },
      });
    }
    if (result.error) throw serviceError(result.error);
  } catch (error) {
    if (error instanceof GatewayKeyServiceError) throw error;
    throw new GatewayKeyServiceError("The gateway key service is unavailable.");
  }
}

const gatewayKeysService = {
  create,
  list,
  queryKey: ["gateway-keys"] as const,
  revoke,
};

export default gatewayKeysService;
