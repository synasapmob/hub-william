import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type {
  AuthenticatedUser,
  LoginCredentials,
  RegisterCredentials,
} from "./auth-types";

type ApiUser = components["schemas"]["AuthenticatedUser"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const AUTH_UNAVAILABLE = "The authentication service is unavailable.";

export class AuthServiceError extends Error {}

function userFromApi(user: ApiUser): AuthenticatedUser {
  return {
    id: user.id,
    recoveryEmail: user.recovery_email ?? null,
    username: user.username,
  };
}

function authError(error?: ErrorResponse) {
  return new AuthServiceError(error?.message ?? "Authentication failed.");
}

class AuthService {
  readonly baseUrl: string;

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

  /**
   * Let service errors through and replace any other failure, such as a
   * network error, with the unavailable message.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AuthServiceError) throw error;

      throw new AuthServiceError(AUTH_UNAVAILABLE);
    }
  }

  /**
   * Sign in with a username and password
   */
  async login(credentials: LoginCredentials): Promise<AuthenticatedUser> {
    return this.guard(async () => {
      const { data, error } = await this.client.POST("/auth/login", {
        body: credentials,
      });

      if (!data) throw authError(error);

      return userFromApi(data.user);
    });
  }

  /**
   * Create an account and sign in
   */
  async register(credentials: RegisterCredentials): Promise<AuthenticatedUser> {
    return this.guard(async () => {
      const { data, error } = await this.client.POST("/auth/register", {
        body: {
          password: credentials.password,
          recovery_email: credentials.recoveryEmail || null,
          username: credentials.username,
        },
      });

      if (!data) throw authError(error);

      return userFromApi(data.user);
    });
  }

  /**
   * Resolve the signed-in user, refreshing an expired access session once. The
   * API answers 401 only when a refresh cookie can restore the session and 204
   * when the browser holds no session cookie, so a visitor who never signed in
   * makes one request and no refresh. Resolves to null when signed out or when
   * the service cannot be reached.
   */
  async session(): Promise<AuthenticatedUser | null> {
    try {
      const current = await this.client.GET("/auth/session");

      if (current.data) return userFromApi(current.data.user);

      if (current.response.status !== 401) return null;

      const refreshed = await this.client.POST("/auth/refresh");

      return refreshed.data ? userFromApi(refreshed.data.user) : null;
    } catch {
      return null;
    }
  }

  /**
   * End the current session
   */
  async logout(): Promise<void> {
    return this.guard(async () => {
      const { error } = await this.client.POST("/auth/logout");

      if (error) throw authError(error);
    });
  }

  /**
   * Build the GitHub avatar URL for a username, or null when the name is not a
   * valid GitHub login
   */
  githubAvatarUrl(username: string): string | null {
    if (
      !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(username) ||
      username.includes("--")
    )
      return null;

    return `https://github.com/${encodeURIComponent(username)}.png?size=64`;
  }
}

export const authService = new AuthService();
