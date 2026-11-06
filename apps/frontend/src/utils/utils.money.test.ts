import { describe, expect, it } from "vitest";

import { dollarsToMicro, formatDollars } from "./utils.money";

describe("formatDollars", () => {
  it("shows cents for larger amounts and four decimals for small ones", () => {
    expect(formatDollars(12_000_000)).toBe("$12.00");
    expect(formatDollars(7_260_000)).toBe("$7.26");
    expect(formatDollars(12_300)).toBe("$0.0123");
    expect(formatDollars(0)).toBe("$0.00");
  });
});

describe("dollarsToMicro", () => {
  it("reads a typed amount exactly", () => {
    expect(dollarsToMicro("10")).toBe(10_000_000);
    expect(dollarsToMicro("0.1")).toBe(100_000);
    expect(dollarsToMicro(" 2.50 ")).toBe(2_500_000);
    expect(dollarsToMicro("1.234567")).toBe(1_234_567);
  });

  it("rejects anything that is not a plain amount", () => {
    for (const text of ["", "abc", "-1", "1.2345678", "1,5", "1e3", ".5", "1."])
      expect(dollarsToMicro(text), text).toBeNull();
  });

  it("rejects an amount too large to hold exactly", () => {
    expect(dollarsToMicro("99999999999999999999")).toBeNull();
  });
});
