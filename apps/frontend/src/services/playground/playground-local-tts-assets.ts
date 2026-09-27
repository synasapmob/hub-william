export interface PlaygroundLocalTtsAsset {
  url: string;
  bytes: number;
  sha256: string;
}

async function verifiedBytes(
  response: Response,
  asset: PlaygroundLocalTtsAsset,
) {
  if (!response.ok || !response.body)
    throw new Error("Local voice download failed.");
  const bytes = new Uint8Array(asset.bytes);
  const reader = response.body.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.length > bytes.length)
        throw new Error("Invalid local voice asset size.");
      bytes.set(value, offset);
      offset += value.length;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (offset !== asset.bytes) throw new Error("Incomplete local voice asset.");
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (hash !== asset.sha256)
    throw new Error("Local voice asset integrity check failed.");
  return bytes.buffer;
}

async function load(asset: PlaygroundLocalTtsAsset) {
  let cache: Cache | undefined;
  try {
    cache = await caches.open("hub-piper-speech-v1");
  } catch {
    // Private browsing or storage limits must not prevent local synthesis.
  }
  const cached = await cache?.match(asset.url).catch(() => undefined);
  if (cached) {
    try {
      return await verifiedBytes(cached, asset);
    } catch {
      await cache?.delete(asset.url).catch(() => false);
    }
  }
  const response = await fetch(asset.url, { credentials: "omit" });
  const bytes = await verifiedBytes(response, asset);
  await cache?.put(asset.url, new Response(bytes)).catch(() => {});
  return bytes;
}

export default { load };
