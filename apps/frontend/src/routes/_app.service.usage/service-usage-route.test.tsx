import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import { authService } from "@/services/auth/auth-service";
import { serviceUsageService } from "@/services/service-usage/service-usage-service";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import type { ServiceWallet } from "@/services/service-billing/service-billing-types";
import type { ServiceUsage } from "@/services/service-usage/service-usage-types";
import createQueryClient from "@/utils/utils.query-client";

import ServiceUsageRoute from "./route";

const usage: ServiceUsage = {
  breakdown: [
    {
      completedRequests: 2,
      gatewayKeyId: "11111111-1111-4111-8111-111111111111",
      keyLastFour: "a1b2",
      knownCachedTokens: 0,
      knownInputTokens: 1500,
      knownOutputTokens: 300,
      model: "gpt-test",
      provider: "chatgpt",
      requests: 3,
      spentMicro: 1_500_000,
      tokenKnownRequests: 3,
    },
    {
      completedRequests: 1,
      gatewayKeyId: null,
      keyLastFour: null,
      knownCachedTokens: 0,
      knownInputTokens: 0,
      knownOutputTokens: 0,
      model: null,
      provider: "claude",
      requests: 1,
      spentMicro: 0,
      tokenKnownRequests: 0,
    },
  ],
  completedRequests: 3,
  dailyUsage: [
    {
      date: "2026-11-04",
      knownTotalTokens: 0,
      requests: 1,
      tokenKnownRequests: 0,
    },
    {
      date: "2026-11-05",
      knownTotalTokens: 1800,
      requests: 3,
      tokenKnownRequests: 3,
    },
  ],
  knownCachedTokens: 0,
  knownInputTokens: 1500,
  knownOutputTokens: 300,
  periodDays: 30,
  requests: 4,
  spentMicro: 1_500_000,
  tokenKnownRequests: 3,
};

const wallet: ServiceWallet = { walletMicro: 2_000_000 };

function renderRoute() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={["/service/usage"]}>
          <Routes>
            <Route path="/service/usage" element={<ServiceUsageRoute />} />

            <Route path="/service/pricing" element={<p>Pricing page</p>} />
          </Routes>
        </MemoryRouter>
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

function signIn() {
  vi.spyOn(authService, "session").mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    recoveryEmail: null,
    username: "ban",
  });
}

beforeEach(() => {
  vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Service usage", () => {
  it("sends a visitor to Pricing and requests nothing", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    const usageMock = vi.spyOn(serviceUsageService, "usage");

    renderRoute();

    expect(await screen.findByText("Pricing page")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Sign in" }),
    ).not.toBeInTheDocument();
    expect(usageMock).not.toHaveBeenCalled();
  });

  it("does not send a signed-in user away", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue(usage);

    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "By key and model" }),
    ).toBeVisible();
    expect(screen.queryByText("Pricing page")).not.toBeInTheDocument();
  });

  it("shows the totals, the daily chart and the usage by key and model", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue(usage);

    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "By key and model" }),
    ).toBeVisible();
    expect(screen.getByRole("heading", { name: "Requests" })).toBeVisible();
    expect(screen.getAllByText("1.5K").length).toBeGreaterThan(0);
    expect(screen.getByRole("list", { name: "Requests by day" })).toBeVisible();
    expect(screen.getAllByText("Key …a1b2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Removed key").length).toBeGreaterThan(0);
    // The request that reported no usage shows a dash, not zero tokens.
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("says how many requests did not finish and that their usage is included", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue(usage);

    renderRoute();

    expect(
      await screen.findByText(
        /1 did not finish, because the connection closed/,
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Token counts were reported for 3 of 4 requests/),
    ).toBeVisible();
  });

  it("omits the unfinished note when every request finished", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue({
      ...usage,
      completedRequests: usage.requests,
    });

    renderRoute();

    await screen.findByRole("heading", { name: "By key and model" });
    expect(screen.queryByText(/did not finish/)).not.toBeInTheDocument();
  });

  it("asks again for the chosen range", async () => {
    signIn();
    const usageMock = vi
      .spyOn(serviceUsageService, "usage")
      .mockResolvedValue(usage);
    const user = userEvent.setup();

    renderRoute();

    await user.click(
      await screen.findByRole("combobox", { name: "Time range" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Last 7 days" }),
    );

    await waitFor(() =>
      expect(usageMock).toHaveBeenLastCalledWith({ days: 7 }),
    );
    expect(usageMock).toHaveBeenCalledWith({ days: 30 });
  });

  it("explains an empty period", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue({
      ...usage,
      breakdown: [],
      completedRequests: 0,
      dailyUsage: [],
      knownInputTokens: 0,
      knownOutputTokens: 0,
      requests: 0,
      tokenKnownRequests: 0,
    });

    renderRoute();

    expect(
      await screen.findByText("No requests in this period."),
    ).toBeVisible();
  });

  it("reports a failure and loads again on Retry", async () => {
    signIn();
    const usageMock = vi
      .spyOn(serviceUsageService, "usage")
      .mockRejectedValueOnce(new Error("The usage service is unavailable."))
      .mockResolvedValue(usage);
    const user = userEvent.setup();

    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The usage service is unavailable.",
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("heading", { name: "By key and model" }),
    ).toBeVisible();
    expect(usageMock).toHaveBeenCalledTimes(2);
  });

  it("has no credit card and no way to withdraw: the balance is in the header", async () => {
    signIn();
    vi.spyOn(serviceUsageService, "usage").mockResolvedValue(usage);

    renderRoute();

    expect(
      await screen.findByRole("heading", { name: "By key and model" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("progressbar", { name: "Credit left" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Withdraw" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/credit/i)).not.toBeInTheDocument();
  });
});
