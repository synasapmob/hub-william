import { describe, expect, it } from "vitest";

import { providerIconUrl } from "./utils.provider-icon";

const AGENTS = ["chatgpt", "claude", "deepseek", "gemini", "grok", "groq"];

describe("providerIconUrl", () => {
  it.each(AGENTS)("has an icon for %s", (agent) => {
    expect(providerIconUrl(agent)).toMatch(
      new RegExp(`/assets/${agent}-icon\\.(png|svg)$`),
    );
  });

  it("finds the icon however the shop wrote the name", () => {
    expect(providerIconUrl("ChatGPT")).toBe(providerIconUrl("chatgpt"));
    expect(providerIconUrl("  Claude ")).toBe(providerIconUrl("claude"));
    expect(providerIconUrl("DEEPSEEK")).toBe(providerIconUrl("deepseek"));
  });

  it("has none for an agent Hub William has no icon for", () => {
    expect(providerIconUrl("Perplexity")).toBeNull();
    expect(providerIconUrl("")).toBeNull();
  });
});
