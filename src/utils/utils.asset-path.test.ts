import { describe, expect, it } from "vitest";

import assetPath from "./utils.asset-path";

describe("assetPath", () => {
  it("addresses public assets from the configured app base", () => {
    expect(assetPath("logo.png")).toBe(`${import.meta.env.BASE_URL}logo.png`);
    expect(assetPath("/logo.png")).toBe(`${import.meta.env.BASE_URL}logo.png`);
    expect(assetPath("logo.png")).not.toContain("/public/");
  });
});
