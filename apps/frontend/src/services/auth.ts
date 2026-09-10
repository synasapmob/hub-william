import createClient from "openapi-fetch";

import type { components, paths } from "./api.generated";

export interface AuthenticatedUser {
  id: string;
  recoveryEmail: string | null;
  username: string;
}

export interface LoginCredentials {
  password: string;
  username: string;
}

export interface RegisterCredentials extends LoginCredentials {
  recoveryEmail: string;
}

type ApiUser = components["schemas"]["AuthenticatedUser"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
).replace(/\/$/, "");
const client = createClient<paths>({
  baseUrl: apiBaseUrl,
  credentials: "include",
  fetch: (...args) => globalThis.fetch(...args),
});

export class AuthServiceError extends Error {}

function userFromApi(user: ApiUser): AuthenticatedUser {
  return {
    id: user.id,
    recoveryEmail: user.recovery_email ?? null,
    username: user.username,
  };
}

function serviceError(error?: ErrorResponse) {
  return new AuthServiceError(error?.message ?? "Authentication failed.");
}

async function login(credentials: LoginCredentials) {
  try {
    const { data, error } = await client.POST("/auth/login", {
      body: credentials,
    });

    if (!data) throw serviceError(error);

    return userFromApi(data.user);
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError("The authentication service is unavailable.");
  }
}

async function register(credentials: RegisterCredentials) {
  try {
    const { data, error } = await client.POST("/auth/register", {
      body: {
        password: credentials.password,
        recovery_email: credentials.recoveryEmail || null,
        username: credentials.username,
      },
    });

    if (!data) throw serviceError(error);

    return userFromApi(data.user);
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError("The authentication service is unavailable.");
  }
}

async function session() {
  try {
    const current = await client.GET("/auth/session");
    if (current.data) return userFromApi(current.data.user);
    if (current.response.status !== 401) return null;

    const refreshed = await client.POST("/auth/refresh");
    return refreshed.data ? userFromApi(refreshed.data.user) : null;
  } catch {
    return null;
  }
}

async function logout() {
  try {
    const { error } = await client.POST("/auth/logout");
    if (error) throw serviceError(error);
  } catch (error) {
    if (error instanceof AuthServiceError) throw error;
    throw new AuthServiceError("The authentication service is unavailable.");
  }
}

const authService = { login, logout, register, session };

export default authService;
