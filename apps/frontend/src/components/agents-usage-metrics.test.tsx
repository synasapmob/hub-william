import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentPoolUsageMetric } from "@/services/agent-pools";

import AgentsUsageMetrics from "./agents-usage-metrics";

const resetCredits: AgentPoolUsageMetric = {
  detail: "Resets in 5d 13h",
  label: "Reset credits",
  value: "2 available",
};

describe("AgentsUsageMetrics", () => {
  it("resets a credit and disables the action while it is in flight", async () => {
    const user = userEvent.setup();
    let settleReset = () => {};
    const onResetCredits = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settleReset = resolve;
        }),
    );
    render(
      <AgentsUsageMetrics
        onResetCredits={onResetCredits}
        provider="ChatGPT"
        usage={[resetCredits]}
      />,
    );

    const button = screen.getByRole("button", { name: "Reset" });
    await user.click(button);

    expect(onResetCredits).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Resetting…");

    settleReset();
    await waitFor(() => expect(button).toHaveTextContent("Reset"));
  });

  it("keeps the reset disabled when no credit is available", () => {
    render(
      <AgentsUsageMetrics
        onResetCredits={vi.fn()}
        provider="ChatGPT"
        usage={[{ label: "Reset credits", value: "0 available" }]}
      />,
    );

    expect(screen.getByRole("button", { name: "Reset" })).toBeDisabled();
  });

  it("shows the provider error when the reset is refused", async () => {
    const user = userEvent.setup();
    const onResetCredits = vi.fn().mockRejectedValue(new Error("No credits."));
    render(
      <AgentsUsageMetrics
        onResetCredits={onResetCredits}
        provider="ChatGPT"
        usage={[resetCredits]}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Reset" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No credits.");
  });

  it("leaves reset out when the viewer cannot spend a credit", () => {
    render(<AgentsUsageMetrics provider="ChatGPT" usage={[resetCredits]} />);

    expect(
      screen.queryByRole("button", { name: "Reset" }),
    ).not.toBeInTheDocument();
  });
});
