import { describe, expect, it } from "vitest";

import type { ServiceListing } from "@/services/sales/sales-types";

import {
  daysFromTyped,
  listingName,
  listingSearchText,
  priceMicroFromTyped,
  quotaLine,
  typedFromPriceMicro,
} from "./service-listing-text";

describe("priceMicroFromTyped", () => {
  it.each([
    ["4", 4_000_000],
    ["4.5", 4_500_000],
    ["4.50", 4_500_000],
    ["9.99", 9_990_000],
    ["0.01", 10_000],
    ["10000", 10_000_000_000],
    ["  7  ", 7_000_000],
  ])("turns %s into micro-dollars, exactly", (typed, micro) => {
    expect(priceMicroFromTyped(typed)).toBe(micro);
  });

  it("does not go through a float: 0.07 and 1.15 are exact", () => {
    expect(priceMicroFromTyped("0.07")).toBe(70_000);
    expect(priceMicroFromTyped("1.15")).toBe(1_150_000);
  });

  it.each([
    ["nothing", ""],
    ["a price of nothing", "0"],
    ["a price under a cent", "0.00"],
    ["a fraction of a cent", "4.005"],
    ["above $10,000", "10000.01"],
    ["a negative amount", "-1"],
    ["a comma", "4,5"],
    ["words", "four"],
    ["a currency sign", "$4"],
  ])("refuses %s", (_, typed) => {
    expect(priceMicroFromTyped(typed)).toBeNull();
  });
});

describe("typedFromPriceMicro", () => {
  it.each([
    [4_000_000, "4"],
    [9_990_000, "9.99"],
    [4_500_000, "4.50"],
    [10_000, "0.01"],
  ])("writes %i as %s", (micro, typed) => {
    expect(typedFromPriceMicro(micro)).toBe(typed);
  });

  it("writes what priceMicroFromTyped reads", () => {
    for (const micro of [10_000, 1_230_000, 4_000_000, 10_000_000_000])
      expect(priceMicroFromTyped(typedFromPriceMicro(micro))).toBe(micro);
  });
});

describe("daysFromTyped", () => {
  it.each([
    ["1", 1],
    ["7", 7],
    ["365", 365],
    [" 30 ", 30],
  ])("reads %s as %i days", (typed, days) => {
    expect(daysFromTyped(typed)).toBe(days);
  });

  it.each(["", "0", "366", "-1", "1.5", "7 ngày", "abc"])(
    "refuses %j",
    (typed) => {
      expect(daysFromTyped(typed)).toBeNull();
    },
  );
});

describe("listingName", () => {
  it("names the agent, the plan and the days", () => {
    expect(listingName("claude", "Max 5x", 7)).toBe("Claude Max 5x · 7 ngày");
  });

  it("leaves out a plan the account does not have", () => {
    expect(listingName("deepseek", null, 30)).toBe("DeepSeek · 30 ngày");
  });
});

describe("quotaLine", () => {
  it("puts what an account has left on one line, in the provider's words", () => {
    expect(
      quotaLine([
        { detail: "resets in 2h", label: "5-hour limit", value: "80% left" },
        { detail: null, label: "Weekly limit", value: "50% left" },
      ]),
    ).toBe("5-hour limit 80% left · Weekly limit 50% left");
  });

  it("is empty when the provider says nothing", () => {
    expect(quotaLine([])).toBe("");
  });
});

describe("listingSearchText", () => {
  const listing = {
    account_label: "Shop Claude",
    name: "Claude Max · 7 ngày",
    plan: "Max",
    provider: "claude",
  } as ServiceListing;

  it("has what a search looks at, in lower case", () => {
    const text = listingSearchText(listing);

    for (const part of ["claude max · 7 ngày", "shop claude", "max"])
      expect(text).toContain(part);
  });

  it("copes with an account that has no name or plan", () => {
    expect(
      listingSearchText({ ...listing, account_label: null, plan: null }),
    ).toContain("claude");
  });
});
