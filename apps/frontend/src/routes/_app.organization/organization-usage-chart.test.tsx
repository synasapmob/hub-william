import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import OrganizationUsageChart from "./organization-usage-chart";

describe("OrganizationUsageChart", () => {
  it("reveals exact daily values through its disclosure", async () => {
    render(
      <OrganizationUsageChart
        days={[
          {
            date: "2026-09-23",
            knownTotalTokens: 120,
            requests: 7,
            tokenKnownRequests: 7,
          },
          {
            date: "2026-09-24",
            knownTotalTokens: 0,
            requests: 0,
            tokenKnownRequests: 0,
          },
        ]}
      />,
    );

    const user = userEvent.setup();
    const disclosure = screen.getByText("Daily values");
    const details = disclosure.closest("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");

    await user.click(disclosure);
    expect(details).toHaveAttribute("open");
    expect(within(details!).getByText("7 requests")).toBeVisible();
    expect(within(details!).getByText("0 requests")).toBeVisible();

    await user.click(disclosure);
    expect(details).not.toHaveAttribute("open");
  });
});
