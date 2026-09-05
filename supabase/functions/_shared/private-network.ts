// Deciding whether a URL may be fetched at all.
//
// Its own module, and free of the extractor's Deno-only imports, so the one
// function standing between a public feed's URL and the cloud metadata service
// can be exercised by the test runner rather than reasoned about.

const PRIVATE_IPV4 =
  /^(?:127\.|0\.|10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

/**
 * Parses the host as an address rather than prefix-matching a string.
 *
 * The string form misses more than it catches: an IPv4-mapped IPv6 literal
 * (`[::ffff:169.254.169.254]`), IPv6 unique-local (`fc00::/7`) and link-local
 * (`fe80::/10`), and internal names with no dot at all.
 *
 * It cannot cover everything — this does not resolve DNS, so a public name
 * pointing into private space still passes, and nothing here defeats a rebind
 * between the check and the connection. That residual risk is accepted: URLs
 * come from public feeds and an admin, the response is never shown to the
 * requester, and the alternative is resolving and pinning addresses inside an
 * Edge Function.
 */
export function isPrivateHost(hostname: string) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host === "0.0.0.0") return true;
  // A name with no dot is not a public host, it is something on the network.
  if (!host.includes(":") && !host.includes(".")) return true;
  if (/\.(?:internal|local|localdomain|home|lan)$/.test(host)) return true;

  if (host.includes(":")) {
    // ::ffff:169.254.169.254 is the metadata service wearing an IPv6 hat.
    const mapped = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return PRIVATE_IPV4.test(mapped[1]);
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(host)) return true; // fe80::/10 link-local
    return false;
  }

  return PRIVATE_IPV4.test(host);
}

export function assertPublicHttpUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The article URL is not a URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http and https articles are fetched.");
  }
  if (isPrivateHost(url.hostname)) {
    throw new Error("Refusing to fetch a private-network address.");
  }
  return url;
}
