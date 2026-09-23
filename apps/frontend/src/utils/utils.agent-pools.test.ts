import { describe, expect, it } from "vitest";

import type {
  AgentPoolAvailability,
  AgentPoolUsageMetric,
} from "@/services/agent-pools";

import {
  agentPoolPrimaryUsage,
  agentPoolRemaining,
  agentPoolTokenDetail,
  agentPoolWarning,
} from "./utils.agent-pools";

function poolWithUsage(usage: AgentPoolUsageMetric[]) {
  const availability: AgentPoolAvailability = { status: "active" };
  return { agent: "ChatGPT" as const, usage, availability };
}

describe("agent pool usage summaries", () => {
  it.each(["Weekly limit", "Monthly limit", "Usage limit", "Sonnet weekly"])(
    "uses the reported %s when 5-hour usage is unavailable",
    (label) => {
      const pool = poolWithUsage([
        { label: "5-hour limit", value: "Unavailable" },
        { label: "Prepaid balance", value: "$20.00" },
        { label, value: "60% remaining" },
      ]);
      expect(agentPoolPrimaryUsage(pool)).toEqual({
        label,
        value: "60% remaining",
      });
    },
  );

  it("prefers a reported 5-hour limit regardless of metric order", () => {
    const pool = poolWithUsage([
      { label: "Weekly limit", value: "40% remaining" },
      { label: "5-hour limit", value: "72% remaining" },
    ]);
    expect(agentPoolPrimaryUsage(pool)?.label).toBe("5-hour limit");
  });

  it.each([
    { usage: [] },
    { usage: [{ label: "Usage", value: "Unavailable" }] },
    { usage: [{ label: "Reset credits", value: "2 available" }] },
  ])(
    "does not invent a quota from unavailable or non-quota fields",
    ({ usage }) => {
      expect(agentPoolPrimaryUsage(poolWithUsage(usage))).toBeUndefined();
      expect(agentPoolWarning(poolWithUsage(usage))).toBeNull();
    },
  );

  it.each([
    ["68% used", 32],
    ["32% remaining", 32],
    ["100% used", 0],
    ["$20.00", null],
    ["2 available", null],
    ["Unavailable", null],
  ] as const)(
    "interprets %s without treating other units as percentages",
    (value, expected) => {
      expect(agentPoolRemaining({ label: "Usage", value })).toBe(expected);
    },
  );

  it("reports exhausted secondary limits and prioritizes connection recovery", () => {
    const pool = poolWithUsage([
      { label: "5-hour limit", value: "72% remaining" },
      { label: "Weekly limit", value: "0% remaining" },
    ]);
    expect(agentPoolWarning(pool)).toBe("Weekly limit exhausted");
    pool.availability.status = "reauth_required";
    expect(agentPoolWarning(pool)).toBe("Reconnect required");
    pool.availability.status = "rate_limited";
    expect(agentPoolWarning(pool)).toBe("Cooling down");
    pool.availability.status = "half_open";
    expect(agentPoolWarning(pool)).toBe("Ready to retry");
  });

  it("shows tokens only when a provider actually reports them", () => {
    expect(
      agentPoolTokenDetail(
        poolWithUsage([{ label: "Weekly limit", value: "72% remaining" }]),
      ),
    ).toBeUndefined();
    expect(
      agentPoolTokenDetail(
        poolWithUsage([
          {
            label: "5-hour limit",
            value: "72% remaining",
            detail: "Resets in 3h · 120000 / 500000 tokens",
          },
        ]),
      ),
    ).toBe("120000 / 500000 tokens · 5-hour limit");
  });
});
