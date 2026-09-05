// The apex redirects to www, so www is the origin browsers actually send.
// Omitting it made every Edge Function call from production fail CORS.
const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "https://hub-william.site",
  "https://www.hub-william.site",
  "https://hub-william.vercel.app",
];

function configuredOrigins() {
  const configured = Deno.env
    .get("APP_URLS")
    ?.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return configured?.length ? configured : defaultOrigins;
}

// Vite takes the next free port when 5173 is busy, so a second checkout or a
// stale process silently moves the dev server to 5174, 5175, 5176. Listing
// ports one at a time meant the app worked until it didn't, and the symptom is
// the least obvious one CORS has: the preflight succeeds, the browser compares
// the returned origin against its own, and drops the real request without ever
// sending it. No error reaches the function, so its logs show OPTIONS 204 and
// no POST at all.
//
// Allowing any loopback port is not a hole. CORS is not what protects these
// endpoints — every one of them requires a bearer token in the Authorization
// header, and a page on another origin cannot read the token this app stores.
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+$/;

function isAllowedOrigin(origin: string) {
  return configuredOrigins().includes(origin) || LOOPBACK_ORIGIN.test(origin);
}

export function corsHeaders(request: Request) {
  const origin = request.headers.get("origin");
  const allowedOrigin =
    origin && isAllowedOrigin(origin) ? origin : configuredOrigins()[0];

  return {
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Origin": allowedOrigin,
    Vary: "Origin",
  };
}

export function jsonResponse(
  request: Request,
  body: Record<string, unknown>,
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(request),
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

export function optionsResponse(request: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export function publicError(error: unknown) {
  if (error instanceof ProviderRequestError) {
    return error.message;
  }

  return "The provider connection could not be completed.";
}

export class ProviderRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ProviderRequestError";
    this.status = status;
  }
}
