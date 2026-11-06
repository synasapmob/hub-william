import type { AgentProviderId } from "@/services/agent/agent-types";

// Every amount is a whole number of micro-dollars (1 USD = 1,000,000).

export interface ServicePrice {
  cachedMicroPerMillion: number;
  inputMicroPerMillion: number;
  outputMicroPerMillion: number;
}

export interface ServiceModel {
  id: string;
  name: string;
  price: ServicePrice;
}

export interface ServiceProvider {
  // Whether the platform's stock has an account that can serve this agent now.
  available: boolean;
  label: string;
  models: ServiceModel[];
  provider: AgentProviderId;
}

export interface ServicePricing {
  currency: string;
  // A request starts only when the wallet holds at least this much, since what
  // it costs is known only when it ends.
  minBalanceMicro: number;
  providers: ServiceProvider[];
  // Whether topping up works without a payment, which is staging only.
  testTopUp: boolean;
  // Whether a top-up is paid by card, on a Stripe page the customer is sent to.
  cardTopUp: boolean;
}

export interface ServiceWallet {
  walletMicro: number;
}

export interface ServiceTopUp {
  walletMicro: number;
  // Where to send the customer to pay by card. Null when the wallet was
  // credited at once, which only test top-ups do.
  checkoutUrl: string | null;
}

// A ticket: an agent account someone put on sale. Whoever buys it pays once from
// the wallet and gets a key that runs on that one account for `days`.

// One line of what the account had left, as its provider reports it.
export interface TicketQuotaMetric {
  detail: string | null;
  label: string;
  value: string;
}

export interface TicketListing {
  // How long the key lasts, counted from the moment it is bought.
  days: number;
  id: string;
  name: string;
  priceMicro: number;
  // What the account had left when it was put on sale; empty when its provider
  // does not say.
  quota: TicketQuotaMetric[];
  quotaCapturedAt: string | null;
}

// An agent that has at least one ticket for sale.
export interface TicketProvider {
  label: string;
  listings: TicketListing[];
  provider: AgentProviderId;
}

// What a purchase, or a replacement key, answers. The key is shown this once.
export interface PurchasedTicket {
  days: number;
  expiresAt: string;
  key: string;
  keyId: string;
  lastFour: string;
  name: string;
  priceMicro: number;
  provider: AgentProviderId;
}

// A ticket the signed-in user bought, without its key.
export interface OwnedTicket {
  days: number;
  expiresAt: string;
  keyId: string;
  lastFour: string;
  name: string;
  priceMicro: number;
  provider: AgentProviderId;
  purchasedAt: string;
  status: "active" | "expired";
}
