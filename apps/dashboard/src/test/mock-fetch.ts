import { vi } from "vitest";

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });

/** Answers the next call to `fetch`, and returns the spy to inspect it. */
export function answer(response: Response | Error) {
  const spy = vi.spyOn(globalThis, "fetch");

  if (response instanceof Error) spy.mockRejectedValueOnce(response);
  else spy.mockResolvedValueOnce(response);

  return spy;
}

/** The first request `fetch` was given, as the server would read it. */
export async function sent(spy: ReturnType<typeof answer>) {
  const [first, init] = spy.mock.calls[0] as [Request | string, RequestInit?];
  const request = first instanceof Request ? first : undefined;
  const url = new URL(request?.url ?? (first as string));

  return {
    body: request
      ? await request.clone().text()
      : (init?.body as BodyInit | null | undefined),
    contentType:
      request?.headers.get("content-type") ??
      new Headers(init?.headers).get("content-type"),
    credentials: request?.credentials ?? init?.credentials,
    method: request?.method ?? init?.method,
    path: url.pathname,
    query: url.searchParams,
  };
}
