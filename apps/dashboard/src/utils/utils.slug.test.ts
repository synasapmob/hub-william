import { describe, expect, it } from "vitest";

import slugify from "./utils.slug";

describe("slugify", () => {
  it("folds Vietnamese accents to lowercase ASCII joined by hyphens", () => {
    expect(slugify("ChatGPT", "Plus 1 tháng", "Gia đình")).toBe(
      "chatgpt-plus-1-thang-gia-dinh",
    );
  });

  it("skips an empty or missing variant", () => {
    expect(slugify("Claude", "Pro 1 tháng", null)).toBe("claude-pro-1-thang");
    expect(slugify("Claude", "Pro 1 tháng", "")).toBe("claude-pro-1-thang");
  });

  it("is empty when nothing usable is typed", () => {
    expect(slugify("", "  ", undefined)).toBe("");
    expect(slugify("!!!")).toBe("");
  });

  it("stops at 64 characters without leaving a trailing hyphen", () => {
    const slug = slugify("a".repeat(63), "b");

    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });
});
