import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import WorkspaceShellSession from "@/components/workspace-shell/workspace-shell-session";
import { authService } from "@/services/auth/auth-service";
import {
  ServiceBillingError,
  serviceBillingService,
} from "@/services/service-billing/service-billing-service";
import type {
  OwnedTicket,
  PurchasedTicket,
  TicketProvider,
} from "@/services/service-billing/service-billing-types";
import { copyText } from "@/utils/utils.clipboard";
import createQueryClient from "@/utils/utils.query-client";

import ServicePricingRoute from "./route";

vi.mock("@/utils/utils.clipboard", () => ({ copyText: vi.fn() }));

const MAX = "Claude Max · 7 days";
const PRO = "Claude Pro · 1 day";
const PLUS = "ChatGPT Plus · 30 days";

// Claude has two tickets, one whose account says what it has left and one whose
// provider does not; ChatGPT has one; no other agent has any.
const providers: TicketProvider[] = [
  {
    label: "ChatGPT",
    listings: [
      {
        days: 30,
        id: "listing-plus",
        name: PLUS,
        priceMicro: 9_990_000,
        quota: [{ detail: null, label: "Weekly limit", value: "65% left" }],
        quotaCapturedAt: "2026-11-06T09:30:00Z",
      },
    ],
    provider: "chatgpt",
  },
  {
    label: "Claude",
    listings: [
      {
        days: 7,
        id: "listing-max",
        name: MAX,
        priceMicro: 4_000_000,
        quota: [
          { detail: "resets in 2h", label: "5-hour limit", value: "80% left" },
          { detail: null, label: "Weekly limit", value: "50% left" },
        ],
        quotaCapturedAt: "2026-11-06T09:30:00Z",
      },
      {
        days: 1,
        id: "listing-pro",
        name: PRO,
        priceMicro: 1_500_000,
        quota: [],
        quotaCapturedAt: null,
      },
    ],
    provider: "claude",
  },
];

// A made-up key, never a real one.
const bought: PurchasedTicket = {
  days: 7,
  expiresAt: "2026-11-13T09:30:00Z",
  key: "hw_tkt_fake-not-a-secret",
  keyId: "key-1",
  lastFour: "cret",
  name: MAX,
  priceMicro: 4_000_000,
  provider: "claude",
};

const owned: OwnedTicket = {
  days: 7,
  expiresAt: "2026-11-13T09:30:00Z",
  keyId: "key-1",
  lastFour: "cret",
  name: MAX,
  priceMicro: 4_000_000,
  provider: "claude",
  purchasedAt: "2026-11-06T09:30:00Z",
  status: "active",
};

function signIn() {
  vi.spyOn(authService, "session").mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    recoveryEmail: null,
    username: "ban",
  });
}

/** A shop: tickets on sale, a wallet, and nothing bought yet. */
function shop(options: { balance?: number; owned?: OwnedTicket[] } = {}) {
  return {
    listings: vi
      .spyOn(serviceBillingService, "ticketListings")
      .mockResolvedValue(providers),
    owned: vi
      .spyOn(serviceBillingService, "ownedTickets")
      .mockResolvedValue(options.owned ?? []),
    wallet: vi
      .spyOn(serviceBillingService, "wallet")
      .mockResolvedValue({ walletMicro: options.balance ?? 20_000_000 }),
  };
}

function renderRoute() {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceShellSession>
        <MemoryRouter initialEntries={["/service/pricing"]}>
          <Routes>
            <Route path="/service/pricing" element={<ServicePricingRoute />} />
          </Routes>
        </MemoryRouter>
      </WorkspaceShellSession>
    </QueryClientProvider>,
  );
}

const card = (name: string) =>
  within(
    screen.getByRole("heading", { name }).closest("section") as HTMLElement,
  );
const buy = (name: string) =>
  screen.getByRole("button", { name: `Buy ${name}` });

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(copyText).mockClear();
});

describe("Service pricing, the tickets for sale", () => {
  it("asks for the tickets once, and shows a card for each agent that has some", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    const { listings } = shop();

    renderRoute();

    await screen.findByRole("heading", { name: "Claude" });

    expect(listings).toHaveBeenCalledTimes(1);
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["ChatGPT", "Claude"]);
    expect(card("Claude").getByText("2 plans")).toBeVisible();
    expect(card("ChatGPT").getByText("1 plan")).toBeVisible();
  });

  it("shows each ticket's name, its days, what its account had left and its price", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    shop();

    renderRoute();

    await screen.findByRole("heading", { name: "Claude" });

    const claude = card("Claude");
    const max = claude.getByText(MAX).closest("li") as HTMLElement;

    expect(max).toHaveTextContent("7 days");
    expect(max).toHaveTextContent(
      "5-hour limit 80% left · Weekly limit 50% left",
    );
    expect(max).toHaveTextContent("$4.00");
    // Said as it was read, so nobody takes it for live.
    expect(max).toHaveTextContent("Read Nov 6, 2026");
    expect(claude.getByText(PRO).closest("li")).toHaveTextContent("1 day");
    expect(claude.getByText(PRO).closest("li")).toHaveTextContent("$1.50");
  });

  it("says nothing of the quota for a ticket whose provider does not say", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    shop();

    renderRoute();

    const pro = (await screen.findByText(PRO)).closest("li") as HTMLElement;

    expect(pro).not.toHaveTextContent("limit");
    expect(pro).not.toHaveTextContent("Read");
  });

  it("shows no card at all when nothing is for sale", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    vi.spyOn(serviceBillingService, "ticketListings").mockResolvedValue([]);

    renderRoute();

    expect(
      await screen.findByText("No plans are for sale right now."),
    ).toBeVisible();
    expect(screen.queryAllByRole("heading", { level: 2 })).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("explains that a plan is paid once, and not by the token", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    shop();

    renderRoute();

    expect(
      await screen.findByText(/Nothing is charged by the token\./),
    ).toBeVisible();
    expect(screen.queryByText(/per million tokens/)).not.toBeInTheDocument();
  });

  it("reports a failure to load the plans and loads again on Retry", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    const listings = vi
      .spyOn(serviceBillingService, "ticketListings")
      .mockRejectedValueOnce(new Error("The service is unavailable."))
      .mockResolvedValue(providers);
    const user = userEvent.setup();

    renderRoute();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The service is unavailable.",
    );

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByRole("heading", { name: "Claude" }),
    ).toBeVisible();
    expect(listings).toHaveBeenCalledTimes(2);
  });

  it("shows nothing about who sells a ticket or which account it is", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    shop();

    renderRoute();

    await screen.findByText(MAX);

    expect(document.body.textContent).not.toMatch(/seller|@|connection/i);
  });
});

describe("Service pricing, buying", () => {
  it("asks a guest to sign in, and asks the server nothing about money", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    const { wallet, owned: ownedQuery } = shop();
    const purchase = vi.spyOn(serviceBillingService, "purchaseTicket");
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));

    expect(await screen.findByText("Join the sharing community")).toBeVisible();
    expect(screen.queryByText(`Buy ${MAX}?`)).not.toBeInTheDocument();
    expect(purchase).not.toHaveBeenCalled();
    expect(wallet).not.toHaveBeenCalled();
    expect(ownedQuery).not.toHaveBeenCalled();
  });

  it("asks before it takes the money, and says how much, from what, and for how long", async () => {
    signIn();
    shop({ balance: 20_000_000 });
    const purchase = vi.spyOn(serviceBillingService, "purchaseTicket");
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));

    const dialog = await screen.findByRole("dialog");

    expect(dialog).toHaveTextContent(`Buy ${MAX}?`);
    expect(dialog).toHaveTextContent("$4.00 is taken from your balance");
    expect(dialog).toHaveTextContent("$20.00 now");
    expect(dialog).toHaveTextContent("only on this Claude account");
    expect(dialog).toHaveTextContent("7 days from now");
    expect(dialog).toHaveTextContent("shown once");
    expect(purchase).not.toHaveBeenCalled();
  });

  it("buys it, shows the key once to copy, and leaves the shop without that ticket", async () => {
    signIn();
    const { listings, wallet, owned: ownedQuery } = shop();
    const purchase = vi
      .spyOn(serviceBillingService, "purchaseTicket")
      .mockResolvedValue(bought);
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));
    await user.click(
      await screen.findByRole("button", { name: "Buy for $4.00" }),
    );

    expect(await screen.findByText("Your key")).toBeVisible();
    expect(purchase).toHaveBeenCalledWith("listing-max");
    expect(screen.getByLabelText(/Copy now/)).toHaveValue(
      "hw_tkt_fake-not-a-secret",
    );
    expect(screen.getByRole("dialog")).toHaveTextContent("until Nov 13, 2026");

    await user.click(screen.getByRole("button", { name: "Copy key" }));

    expect(copyText).toHaveBeenCalledWith("hw_tkt_fake-not-a-secret");
    // What changed is asked again: the ticket, the balance, the tickets owned.
    await waitFor(() => expect(listings).toHaveBeenCalledTimes(2));
    expect(wallet.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(ownedQuery.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("forgets the key once the dialog is closed", async () => {
    signIn();
    shop();
    vi.spyOn(serviceBillingService, "purchaseTicket").mockResolvedValue(bought);
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));
    await user.click(
      await screen.findByRole("button", { name: "Buy for $4.00" }),
    );
    await screen.findByText("Your key");
    await user.click(screen.getByRole("button", { name: "I have copied it" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("hw_tkt_");
  });

  it("cannot be bought twice, nor closed, while the purchase is on its way", async () => {
    signIn();
    shop();
    let finish: () => void = () => {};
    const purchase = vi
      .spyOn(serviceBillingService, "purchaseTicket")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(bought);
          }),
      );
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));
    await user.click(
      await screen.findByRole("button", { name: "Buy for $4.00" }),
    );

    expect(
      screen.getByRole("button", { name: "Buy for $4.00" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog")).toBeInTheDocument();

    finish();

    expect(await screen.findByText("Your key")).toBeVisible();
    expect(purchase).toHaveBeenCalledTimes(1);
  });

  it("asks nothing of the server when the customer backs out", async () => {
    signIn();
    shop();
    const purchase = vi.spyOn(serviceBillingService, "purchaseTicket");
    const user = userEvent.setup();

    renderRoute();
    await user.click(await screen.findByRole("button", { name: `Buy ${MAX}` }));
    await user.click(await screen.findByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(purchase).not.toHaveBeenCalled();
  });

  it.each([
    [
      404,
      "The requested resource was not found.",
      "This plan was just sold or is no longer for sale.",
    ],
    [402, "The wallet cannot cover that.", "The wallet cannot cover that."],
    [
      502,
      "The claude account did not answer a test request: the provider answered 401",
      "The claude account did not answer a test request: the provider answered 401",
    ],
  ])(
    "says why when the server answers %i, and takes nothing",
    async (status, apiMessage, shown) => {
      signIn();
      shop();
      vi.spyOn(serviceBillingService, "purchaseTicket").mockRejectedValue(
        new ServiceBillingError(apiMessage, status),
      );
      const user = userEvent.setup();

      renderRoute();
      await user.click(
        await screen.findByRole("button", { name: `Buy ${MAX}` }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Buy for $4.00" }),
      );

      expect(await screen.findByRole("alert")).toHaveTextContent(shown);
      expect(screen.queryByText("Your key")).not.toBeInTheDocument();
      // The dialog stays, and the customer can try again or back out.
      expect(
        screen.getByRole("button", { name: "Buy for $4.00" }),
      ).toBeEnabled();
    },
  );

  it("says a balance that is too low, and what is missing, and does not let it be pressed", async () => {
    signIn();
    shop({ balance: 3_000_000 });
    const user = userEvent.setup();

    renderRoute();

    await screen.findByText("Top up $1.00 more to buy");

    expect(buy(MAX)).toBeDisabled();
    // The cheaper ticket is within reach.
    expect(buy(PRO)).toBeEnabled();
    expect(buy(PLUS)).toBeDisabled();

    await user.click(buy(PRO));

    expect(await screen.findByRole("dialog")).toHaveTextContent(`Buy ${PRO}?`);
  });

  it("lets a balance that is exactly the price buy it", async () => {
    signIn();
    shop({ balance: 4_000_000 });

    renderRoute();

    await screen.findByText("Top up $5.99 more to buy");

    expect(buy(MAX)).toBeEnabled();
    expect(buy(PRO)).toBeEnabled();
    expect(buy(PLUS)).toBeDisabled();
  });

  it("does not say the balance is low before the wallet has been read", async () => {
    signIn();
    vi.spyOn(serviceBillingService, "ticketListings").mockResolvedValue(
      providers,
    );
    vi.spyOn(serviceBillingService, "ownedTickets").mockResolvedValue([]);
    vi.spyOn(serviceBillingService, "wallet").mockReturnValue(
      new Promise(() => {}),
    );

    renderRoute();

    await screen.findByText(MAX);

    expect(screen.queryByText(/Top up .* more to buy/)).not.toBeInTheDocument();
    expect(buy(MAX)).toBeEnabled();
  });
});

describe("Service pricing, the tickets already bought", () => {
  it("shows them without a key, and only to the signed-in user who bought them", async () => {
    signIn();
    shop({ owned: [owned] });

    renderRoute();

    const section = within(
      (await screen.findByRole("heading", { name: "Your tickets" })).closest(
        "section",
      ) as HTMLElement,
    );

    expect(section.getByText(MAX)).toBeVisible();
    expect(section.getByText(/hw_tkt_\*+cret/)).toBeVisible();
    expect(section.getByText(/ends Nov 13, 2026/)).toBeVisible();
    expect(section.getByText("Active")).toBeVisible();
    expect(document.body.textContent).not.toContain("hw_tkt_fake");
  });

  it("is not there for a guest, nor when nothing was bought", async () => {
    vi.spyOn(authService, "session").mockResolvedValue(null);
    shop();

    renderRoute();

    await screen.findByText(MAX);

    expect(
      screen.queryByRole("heading", { name: "Your tickets" }),
    ).not.toBeInTheDocument();
  });

  it("lets an ended ticket stay, but not have its key replaced", async () => {
    signIn();
    shop({ owned: [{ ...owned, status: "expired" }] });

    renderRoute();

    const section = within(
      (await screen.findByRole("heading", { name: "Your tickets" })).closest(
        "section",
      ) as HTMLElement,
    );

    expect(section.getByText("Ended")).toBeVisible();
    expect(section.getByText(/ended Nov 13, 2026/)).toBeVisible();
    expect(section.queryByRole("button")).not.toBeInTheDocument();
  });

  it("asks before it kills the key that was, then shows the new one once", async () => {
    signIn();
    shop({ owned: [owned] });
    const reissue = vi
      .spyOn(serviceBillingService, "reissueTicket")
      .mockResolvedValue({ ...bought, key: "hw_tkt_fake-replacement-key" });
    const user = userEvent.setup();

    renderRoute();
    await user.click(
      await screen.findByRole("button", { name: `Get a new key for ${MAX}` }),
    );

    const dialog = await screen.findByRole("dialog");

    expect(dialog).toHaveTextContent(`New key for ${MAX}?`);
    expect(dialog).toHaveTextContent("The key you have stops working at once");
    expect(reissue).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Get a new key" }));

    expect(await screen.findByText("Your key")).toBeVisible();
    expect(reissue).toHaveBeenCalledWith("key-1");
    expect(screen.getByLabelText(/Copy now/)).toHaveValue(
      "hw_tkt_fake-replacement-key",
    );
  });

  it("says when the ticket has ended and its key cannot be replaced", async () => {
    signIn();
    shop({ owned: [owned] });
    vi.spyOn(serviceBillingService, "reissueTicket").mockRejectedValue(
      new ServiceBillingError("The requested resource was not found.", 404),
    );
    const user = userEvent.setup();

    renderRoute();
    await user.click(
      await screen.findByRole("button", { name: `Get a new key for ${MAX}` }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Get a new key" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This ticket has ended, so its key cannot be replaced.",
    );
  });
});
