import { describe, expect, it } from "vitest";

import {
  checkPackageName,
  composePackageName,
  parsePackageName,
} from "./package-name";

describe("parsePackageName", () => {
  it("takes the last brackets as the variant and the rest as the plan", () => {
    expect(
      parsePackageName("AI Pro, Argon 4 + YTB premium (Personal)"),
    ).toEqual({ plan: "AI Pro, Argon 4 + YTB premium", variant: "Personal" });
  });

  it("reads a line without brackets as all plan", () => {
    expect(parsePackageName("Plus 1 tháng")).toEqual({
      plan: "Plus 1 tháng",
      variant: null,
    });
  });

  it("keeps earlier brackets in the plan", () => {
    expect(parsePackageName("Plus (1 tháng) (Gia đình)")).toEqual({
      plan: "Plus (1 tháng)",
      variant: "Gia đình",
    });
  });

  it("tidies the spaces the way the server does", () => {
    expect(parsePackageName("  Plus   1  tháng   ( Gia đình )  ")).toEqual({
      plan: "Plus 1 tháng",
      variant: "Gia đình",
    });
  });

  it("does not make a plan of nothing: brackets alone are the plan", () => {
    expect(parsePackageName("(Personal)")).toEqual({
      plan: "(Personal)",
      variant: null,
    });
  });

  it("has no variant for empty brackets", () => {
    expect(parsePackageName("Plus ()")).toEqual({
      plan: "Plus",
      variant: null,
    });
  });

  it("reads an empty line as an empty plan", () => {
    expect(parsePackageName("   ")).toEqual({ plan: "", variant: null });
  });
});

describe("composePackageName", () => {
  it.each([
    [{ plan: "Plus 1 tháng", variant: null }, "Plus 1 tháng"],
    [{ plan: "Heavy", variant: "Gia đình" }, "Heavy (Gia đình)"],
  ])("writes %o as %s, and reads it back", (name, line) => {
    expect(composePackageName(name)).toBe(line);
    expect(parsePackageName(line)).toEqual(name);
  });
});

describe("checkPackageName", () => {
  it("accepts a plan of 64 characters and a variant of 32", () => {
    expect(
      checkPackageName({ plan: "p".repeat(64), variant: "v".repeat(32) }),
    ).toBeNull();
  });

  it("refuses a plan over 64 characters", () => {
    expect(checkPackageName({ plan: "p".repeat(65), variant: null })).toBe(
      "Tên gói dài tối đa 64 ký tự.",
    );
  });

  it("refuses a variant over 32 characters", () => {
    expect(checkPackageName({ plan: "Plus", variant: "v".repeat(33) })).toBe(
      "Biến thể trong ngoặc dài tối đa 32 ký tự.",
    );
  });

  it("counts a character, not a UTF-16 unit", () => {
    expect(
      checkPackageName({ plan: "😀".repeat(64), variant: null }),
    ).toBeNull();
  });
});
