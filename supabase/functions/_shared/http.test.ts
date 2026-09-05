import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { corsHeaders } from "./http";

// http.ts reads APP_URLS off Deno.env, which vitest does not provide. Stubbed
// empty so these cases exercise the built-in origin list rather than whatever
// the deployed project happens to be configured with.
beforeEach(() => {
  vi.stubGlobal("Deno", { env: { get: () => undefined } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function originOf(origin: string | null) {
  const headers = new Headers();
  if (origin !== null) headers.set("origin", origin);
  return corsHeaders(
    new Request("https://example.supabase.co/functions/v1/x", { headers }),
  )["Access-Control-Allow-Origin"];
}

/**
 * The failure this guards against is the quietest one CORS has: the preflight
 * succeeds, the browser compares the returned origin to its own, and never
 * sends the real request. Nothing reaches the function, so its logs show an
 * OPTIONS with no POST after it and the page just says "failed".
 */
describe("corsHeaders", () => {
  it.each([
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:4173",
    "http://127.0.0.1:5175",
  ])("reflects the dev server on %s", (origin) => {
    // Vite moves to the next free port whenever one is busy, so listing them
    // individually means the app works until a second checkout is running.
    expect(originOf(origin)).toBe(origin);
  });

  it.each([
    "https://hub-william.site",
    "https://www.hub-william.site",
    "https://hub-william.vercel.app",
  ])("reflects the production origin %s", (origin) => {
    expect(originOf(origin)).toBe(origin);
  });

  it("refuses an unrelated origin rather than reflecting it", () => {
    expect(originOf("https://evil.example")).not.toBe("https://evil.example");
  });

  it("refuses https on loopback, which is not what a dev server serves", () => {
    expect(originOf("https://localhost:5175")).not.toBe(
      "https://localhost:5175",
    );
  });

  it("refuses a host that merely starts with localhost", () => {
    expect(originOf("http://localhost.evil.example:5175")).not.toBe(
      "http://localhost.evil.example:5175",
    );
  });

  it("falls back to a configured origin when the request carries none", () => {
    expect(originOf(null)).toBe("http://localhost:5173");
  });
});
