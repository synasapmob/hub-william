import createClient from "openapi-fetch";

import { apiUrl } from "@/utils/utils.api-url";

import type { components, paths } from "./api.generated";

type ErrorResponse = components["schemas"]["ErrorResponse"];

/** A call that did not do what was asked; the message is the API's own. */
export class ServiceError extends Error {
  readonly code: string | null;

  readonly status: number | null;

  constructor(message: string, status: number | null, code: string | null) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** What to say when a request could not even be made, or was not answered. */
export const SERVICE_UNAVAILABLE = "Không kết nối được tới máy chủ.";

// The paths that settle a session themselves: a 401 there means what it says, and
// the session gate does its own refresh.
const OWN_SESSION = /\/(auth\/|dashboard\/session$)/;

let refreshing: Promise<boolean> | null = null;

/** Asks for a new access session; calls made together share one request. */
function refreshSession() {
  refreshing ??= globalThis
    .fetch(apiUrl("/auth/refresh"), { credentials: "include", method: "POST" })
    .then((response) => response.ok)
    .catch(() => false)
    .finally(() => {
      refreshing = null;
    });

  return refreshing;
}

/**
 * `fetch` for the API. The access session lasts a few hours and the refresh
 * session days, so a 401 usually means "look again": the session is refreshed
 * and the request made once more. Only a refresh that fails leaves the 401 to
 * the caller, who has to sign in again.
 */
export async function sessionFetch(
  input: Request | string,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const again = request.clone();
  const response = await globalThis.fetch(request);

  if (
    response.status !== 401 ||
    OWN_SESSION.test(new URL(request.url).pathname)
  )
    return response;

  return (await refreshSession()) ? globalThis.fetch(again) : response;
}

// `fetch` is looked up on every call, so a test can replace it.
export const apiClient = createClient<paths>({
  baseUrl: apiUrl(""),
  credentials: "include",
  fetch: (request) => sessionFetch(request),
});

/** The error of a failed response, with the API's message when it sent one. */
export function serviceError(
  response: Response,
  error: ErrorResponse | undefined,
  fallback: string,
) {
  return new ServiceError(
    error?.message ?? fallback,
    response.status,
    error?.code ?? null,
  );
}

/**
 * Runs a request and turns a network failure into one clear error, while letting
 * the errors the API sent through.
 */
export async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ServiceError) throw error;

    throw new ServiceError(SERVICE_UNAVAILABLE, null, null);
  }
}
