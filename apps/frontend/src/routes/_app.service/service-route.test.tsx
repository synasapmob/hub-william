import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import { authService } from "@/services/auth/auth-service";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import type {
  ServicePricing,
  ServiceWallet,
} from "@/services/service-billing/service-billing-types";
import { redirectTo } from "@/utils/utils.navigation";
import createQueryClient from "@/utils/utils.query-client";

import ServiceRoute from "./route";

vi.mock("@/utils/utils.navigation", () => ({ redirectTo: vi.fn() }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn() }),
}));

function pricingWith(testTopUp: boolean, cardTopUp = false): ServicePricing {
  return {
    cardTopUp,
    currency: "USD",
    minBalanceMicro: 50_000,
    providers: [],
    testTopUp,
  };
}

const wallet: ServiceWallet = { walletMicro: 2_000_000 };

function Where() {
  const location = useLocation();

  return <p data-testid="where">{location.pathname + location.search}</p>;
}

function renderRoute(entry = "/service/pricing", client = createQueryClient()) {
  return render(
    <QueryClientProvider client={client}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/service" element={<ServiceRoute />}>
              <Route
                path="pricing"
                element={
                  <>
                    <p>Page content</p>

                    <Where />
                  </>
                }
              />
            </Route>
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

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(redirectTo).mockClear();
  vi.mocked(toast).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe("Service layout", () => {
  it("shows the balance and a Top up button above every page", async () => {
    signIn();
    vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
      pricingWith(false),
    );
    vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);

    renderRoute();

    expect(await screen.findByText("$2.00")).toBeVisible();
    expect(screen.getByText("Your balance")).toBeVisible();
    expect(screen.getByRole("button", { name: "Top up" })).toBeVisible();
    expect(screen.getByText("Page content")).toBeVisible();
    // There is no credit, and no tokens to estimate: the balance is all there is.
    expect(screen.queryByText("Credit")).not.toBeInTheDocument();
    expect(screen.queryByText(/tokens/)).not.toBeInTheDocument();
  });

  it("shows a visitor the page and nothing in place of the wallet", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
      pricingWith(false),
    );
    const walletMock = vi.spyOn(serviceBillingService, "wallet");

    renderRoute();

    expect(await screen.findByText("Page content")).toBeVisible();
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Sign in" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByText(/Sign in to top up/)).not.toBeInTheDocument();
    expect(screen.queryByText("Your balance")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Top up/ })).toBeNull();
    expect(walletMock).not.toHaveBeenCalled();
  });

  it("says top up is not available yet when payments do not exist", async () => {
    signIn();
    vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
      pricingWith(false),
    );
    vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
    const topUpMock = vi.spyOn(serviceBillingService, "topUp");
    const user = userEvent.setup();

    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Top up" }));

    expect(
      await screen.findByText(
        "Top up is not available yet. Payments are coming soon.",
      ),
    ).toBeVisible();
    expect(screen.queryByLabelText("Amount (USD)")).not.toBeInTheDocument();
    expect(topUpMock).not.toHaveBeenCalled();
  });

  it("tops up the chosen amount and updates the wallet", async () => {
    signIn();
    vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
      pricingWith(true),
    );
    vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
    const topUpMock = vi
      .spyOn(serviceBillingService, "topUp")
      .mockResolvedValue({ checkoutUrl: null, walletMicro: 22_000_000 });
    const user = userEvent.setup();

    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Top up" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "$20" }));
    await user.click(
      within(dialog).getByRole("button", { name: "Top up $20.00" }),
    );

    await waitFor(() => expect(topUpMock).toHaveBeenCalledWith(20_000_000));
    expect(await screen.findByText("$22.00")).toBeVisible();
  });

  it("will not top up an amount outside the allowed range", async () => {
    signIn();
    vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
      pricingWith(true),
    );
    vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
    const user = userEvent.setup();

    renderRoute();

    await user.click(await screen.findByRole("button", { name: "Top up" }));
    const input = await screen.findByLabelText("Amount (USD)");
    await user.clear(input);
    await user.type(input, "5000");

    expect(
      screen.getByRole("button", { name: "Amount out of range" }),
    ).toBeDisabled();
  });

  describe("paying by card", () => {
    it("sends the customer to Stripe for the amount, and leaves the balance to the webhook", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(false, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
      const topUpMock = vi
        .spyOn(serviceBillingService, "topUp")
        .mockResolvedValue({
          checkoutUrl: "https://checkout.stripe.test/c/pay/cs_test_a1",
          walletMicro: 2_000_000,
        });
      const user = userEvent.setup();

      renderRoute();

      await user.click(await screen.findByRole("button", { name: "Top up" }));
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByText(/You pay on Stripe's page/),
      ).toBeVisible();
      await user.click(within(dialog).getByRole("button", { name: "$20" }));
      await user.click(
        within(dialog).getByRole("button", { name: "Pay $20.00 by card" }),
      );

      await waitFor(() => expect(topUpMock).toHaveBeenCalledWith(20_000_000));
      await waitFor(() =>
        expect(redirectTo).toHaveBeenCalledWith(
          "https://checkout.stripe.test/c/pay/cs_test_a1",
        ),
      );
      expect(
        within(dialog).getByRole("button", { name: "Opening Stripe…" }),
      ).toBeDisabled();
      expect(screen.getByText("$2.00")).toBeVisible();
    });

    it("asks for whole cents, which is what a card payment is", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(false, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
      const topUpMock = vi.spyOn(serviceBillingService, "topUp");
      const user = userEvent.setup();

      renderRoute();

      await user.click(await screen.findByRole("button", { name: "Top up" }));
      const input = await screen.findByLabelText("Amount (USD)");
      await user.clear(input);
      await user.type(input, "10.505");

      expect(
        screen.getByRole("button", { name: "Use whole cents" }),
      ).toBeDisabled();
      await user.clear(input);
      await user.type(input, "10.5");
      expect(
        screen.getByRole("button", { name: "Pay $10.50 by card" }),
      ).toBeEnabled();
      expect(topUpMock).not.toHaveBeenCalled();
    });

    it("pays by card even where test top-ups are on, since Stripe is set up", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(true, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
      const user = userEvent.setup();

      renderRoute();

      await user.click(await screen.findByRole("button", { name: "Top up" }));

      expect(
        await screen.findByRole("button", { name: "Pay $10.00 by card" }),
      ).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Top up $10.00" }),
      ).not.toBeInTheDocument();
    });

    it("says the payment was received when Stripe sends the customer back, and looks for the new balance", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(false, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
      const client = createQueryClient();
      const invalidateMock = vi.spyOn(client, "invalidateQueries");

      renderRoute("/service/pricing?topup=success", client);

      await waitFor(() =>
        expect(toast.success).toHaveBeenCalledWith(
          "Payment received. Your balance updates in a moment.",
        ),
      );
      expect(toast.success).toHaveBeenCalledOnce();
      await waitFor(() =>
        expect(invalidateMock).toHaveBeenCalledWith({
          queryKey: serviceBillingService.walletQueryKey(
            "33333333-3333-4333-8333-333333333333",
          ),
        }),
      );
      // The mark is taken off the address, so a reload says nothing more.
      expect(screen.getByTestId("where")).toHaveTextContent("/service/pricing");
      expect(screen.getByTestId("where")).not.toHaveTextContent("topup");
    });

    it("says nothing was charged when the customer comes back without paying", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(false, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);
      const client = createQueryClient();
      const invalidateMock = vi.spyOn(client, "invalidateQueries");

      renderRoute("/service/pricing?topup=cancelled", client);

      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          "Payment cancelled. Nothing was charged.",
        ),
      );
      expect(toast.success).not.toHaveBeenCalled();
      expect(invalidateMock).not.toHaveBeenCalled();
      expect(screen.getByTestId("where")).not.toHaveTextContent("topup");
    });

    it("says nothing on an ordinary visit, or for a mark it does not know", async () => {
      signIn();
      vi.spyOn(serviceBillingService, "pricing").mockResolvedValue(
        pricingWith(false, true),
      );
      vi.spyOn(serviceBillingService, "wallet").mockResolvedValue(wallet);

      renderRoute("/service/pricing?topup=whatever");

      expect(await screen.findByText("$2.00")).toBeVisible();
      expect(toast).not.toHaveBeenCalled();
      expect(toast.success).not.toHaveBeenCalled();
    });
  });
});
