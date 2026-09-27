import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import playgroundLocalTtsAssets, {
  type PlaygroundLocalTtsAsset,
} from "./playground-local-tts-assets";

const asset: PlaygroundLocalTtsAsset = {
  url: "https://models.example.test/pinned/model.onnx",
  bytes: 3,
  sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
};
const cache = {
  match: vi.fn<() => Promise<Response | undefined>>(),
  put: vi.fn<() => Promise<void>>(),
  delete: vi.fn<() => Promise<boolean>>(),
};
const fetchAsset = vi.fn<() => Promise<Response>>();

beforeEach(() => {
  vi.resetAllMocks();
  cache.match.mockResolvedValue(undefined);
  cache.put.mockResolvedValue(undefined);
  cache.delete.mockResolvedValue(true);
  fetchAsset.mockImplementation(async () => new Response("abc"));
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("fetch", fetchAsset);
  vi.stubGlobal("caches", { open: async () => cache });
});
afterEach(() => vi.unstubAllGlobals());

describe("verified local speech assets", () => {
  it("verifies and persists a credential-free download, then reuses the cache", async () => {
    const bytes = await playgroundLocalTtsAssets.load(asset);
    expect(new TextDecoder().decode(bytes)).toBe("abc");
    expect(fetchAsset).toHaveBeenCalledWith(asset.url, { credentials: "omit" });
    expect(cache.put).toHaveBeenCalledWith(asset.url, expect.any(Response));
    cache.match.mockResolvedValue(new Response(bytes));
    await playgroundLocalTtsAssets.load(asset);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it("evicts corrupted cached bytes and verifies a fresh download", async () => {
    cache.match.mockResolvedValue(new Response("bad"));
    const bytes = await playgroundLocalTtsAssets.load(asset);
    expect(new TextDecoder().decode(bytes)).toBe("abc");
    expect(cache.delete).toHaveBeenCalledWith(asset.url);
    expect(fetchAsset).toHaveBeenCalledOnce();
  });

  it.each(["bad", "ab", "abcd"])(
    "rejects incorrect or oversized network bytes: %s",
    async (body) => {
      fetchAsset.mockResolvedValue(new Response(body));
      await expect(playgroundLocalTtsAssets.load(asset)).rejects.toThrow();
      expect(cache.put).not.toHaveBeenCalled();
      expect(fetchAsset).toHaveBeenCalledOnce();
    },
  );

  it("continues when cache storage is unavailable or full", async () => {
    vi.stubGlobal("caches", {
      open: async () => {
        throw new Error("Storage unavailable");
      },
    });
    await expect(playgroundLocalTtsAssets.load(asset)).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
    vi.stubGlobal("caches", { open: async () => cache });
    cache.put.mockRejectedValue(new Error("Quota exceeded"));
    await expect(playgroundLocalTtsAssets.load(asset)).resolves.toBeInstanceOf(
      ArrayBuffer,
    );
  });
});
