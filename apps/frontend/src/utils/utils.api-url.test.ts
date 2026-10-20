import { afterEach, describe, expect, it, vi } from "vitest";

describe("apiUrl", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("joins a path onto the configured API base", async () => {
    vi.stubEnv("VITE_API_BASE_URL", "/api/");
    const { apiUrl } = await import("./utils.api-url");

    expect(apiUrl("/tts")).toBe("/api/tts");
  });

  it("falls back to the local API when no base is configured", async () => {
    vi.stubEnv("VITE_API_BASE_URL", undefined);
    const { apiUrl } = await import("./utils.api-url");

    expect(apiUrl("/reel/resolve")).toBe("http://localhost:8080/reel/resolve");
  });
});
