import { apiClient, guarded, serviceError } from "@/services/api/api-client";
import type { components } from "@/services/api/api.generated";
import type { Permission, Role } from "@/services/sales/sales-types";

type ApiSession = components["schemas"]["DashboardSession"];

/** Who is signed in, and what their role lets them open. */
export interface DashboardIdentity {
  id: string;
  username: string;
  role: Role;
  permissions: Permission[];
}

/**
 * Where a visit stands. `signed-out` shows the sign-in form; `forbidden` means
 * the account is fine but is not (or is no longer) allowed into the dashboard.
 */
export type SessionState =
  | { status: "ready"; identity: DashboardIdentity }
  | { status: "signed-out" }
  | { status: "forbidden"; username: string | null }
  | { status: "unavailable" };

export interface LoginCredentials {
  username: string;
  password: string;
}

/** What a new account is made from; the API lowercases the username itself. */
export interface RegisterDetails {
  username: string;
  password: string;
  recoveryEmail: string;
}

function identityOf(session: ApiSession): DashboardIdentity {
  return {
    id: session.user.id,
    username: session.user.username,
    role: session.role,
    permissions: session.permissions,
  };
}

class SessionService {
  /** The query key of the visit's state, so the screens that change it can refresh it. */
  readonly queryKey = ["dashboard", "session"] as const;

  /**
   * Where this visit stands. An expired access session is refreshed once, the way
   * the storefront does: the API answers 401 only when a refresh cookie may still
   * restore it.
   */
  async load(): Promise<SessionState> {
    try {
      const current = await apiClient.GET("/dashboard/session");

      if (current.data)
        return { status: "ready", identity: identityOf(current.data) };

      if (current.response.status === 403)
        return { status: "forbidden", username: await this.accountName() };

      if (current.response.status !== 401) return { status: "unavailable" };

      const refreshed = await apiClient.POST("/auth/refresh");

      if (!refreshed.data) return { status: "signed-out" };

      const retried = await apiClient.GET("/dashboard/session");

      if (retried.data)
        return { status: "ready", identity: identityOf(retried.data) };

      return retried.response.status === 403
        ? { status: "forbidden", username: refreshed.data.user.username }
        : { status: "signed-out" };
    } catch {
      return { status: "unavailable" };
    }
  }

  /**
   * The username of the signed-in account, so a refusal can say whose it is. The
   * refusal itself does not carry it, and not knowing it changes nothing else.
   */
  private async accountName(): Promise<string | null> {
    try {
      const { data } = await apiClient.GET("/auth/session");

      return data?.user.username ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Makes a Hub William account, the same one the storefront makes, and signs it
   * in, and answers its username as the API keeps it (lowercased). It is not
   * staff until the owner adds it.
   */
  async register(details: RegisterDetails): Promise<string> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST("/auth/register", {
        body: {
          password: details.password,
          recovery_email: details.recoveryEmail,
          username: details.username,
        },
      });

      if (!data)
        throw serviceError(response, error, "Could not register the account.");

      return data.user.username;
    });
  }

  /** Signs in with an account's own username and password; answers the username. */
  async login(credentials: LoginCredentials): Promise<string> {
    return guarded(async () => {
      const { data, error, response } = await apiClient.POST("/auth/login", {
        body: credentials,
      });

      if (!data) throw serviceError(response, error, "Could not log in.");

      return data.user.username;
    });
  }

  async logout(): Promise<void> {
    return guarded(async () => {
      const { error, response } = await apiClient.POST("/auth/logout");

      if (error) throw serviceError(response, error, "Could not log out.");
    });
  }
}

export const sessionService = new SessionService();
