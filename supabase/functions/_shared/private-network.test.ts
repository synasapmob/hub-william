import { describe, expect, it } from "vitest";

import { assertPublicHttpUrl, isPrivateHost } from "./private-network";

/**
 * The guard that decides whether the extractor is allowed to fetch a URL. Item
 * URLs come from public feeds and every one of them is somebody else's string,
 * so this is the boundary between "fetch an article" and "fetch the cloud
 * metadata service and hand it to a model".
 */
describe("isPrivateHost", () => {
  it.each([
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "192.168.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
  ])("rejects the IPv4 private address %s", (host) => {
    expect(isPrivateHost(host)).toBe(true);
  });

  it.each(["::1", "[::1]", "fc00::1", "fd12:3456::1", "fe80::1"])(
    "rejects the IPv6 private address %s",
    (host) => {
      expect(isPrivateHost(host)).toBe(true);
    },
  );

  it("rejects the metadata service wearing an IPv6 hat", () => {
    // The string form of this check missed it entirely.
    expect(isPrivateHost("[::ffff:169.254.169.254]")).toBe(true);
  });

  it("rejects a bare name with no dot, which is a host on the network", () => {
    expect(isPrivateHost("metadata")).toBe(true);
    expect(isPrivateHost("redis")).toBe(true);
  });

  it("rejects internal suffixes", () => {
    expect(isPrivateHost("metadata.internal")).toBe(true);
    expect(isPrivateHost("printer.local")).toBe(true);
  });

  it.each([
    "example.com",
    "news.ycombinator.com",
    "huggingface.co",
    "172.15.0.1",
    "172.32.0.1",
    "11.0.0.1",
    "2606:4700::1111",
  ])("allows the public host %s", (host) => {
    expect(isPrivateHost(host)).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isPrivateHost("LOCALHOST")).toBe(true);
    expect(isPrivateHost("Metadata.Internal")).toBe(true);
  });
});

describe("assertPublicHttpUrl", () => {
  it("returns the URL for an ordinary article", () => {
    expect(assertPublicHttpUrl("https://example.com/post").hostname).toBe(
      "example.com",
    );
  });

  it("refuses a non-http scheme", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(
      /http and https/i,
    );
    expect(() => assertPublicHttpUrl("gopher://example.com")).toThrow(
      /http and https/i,
    );
  });

  it("refuses something that is not a URL at all", () => {
    expect(() => assertPublicHttpUrl("not a url")).toThrow(/not a URL/i);
  });

  it("refuses a private target", () => {
    expect(() =>
      assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"),
    ).toThrow(/private-network/i);
  });
});
