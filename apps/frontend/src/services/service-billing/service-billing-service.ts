import createClient, { type Client } from "openapi-fetch";

import type { components, paths } from "@/services/api/api.generated";

import type {
  OwnedTicket,
  PurchasedTicket,
  ServiceModel,
  ServicePrice,
  ServicePricing,
  ServiceProvider,
  ServiceTopUp,
  ServiceWallet,
  TicketListing,
  TicketProvider,
  TicketQuotaMetric,
} from "./service-billing-types";

type ApiPrice = components["schemas"]["ServicePrice"];
type ApiModel = components["schemas"]["ServiceModel"];
type ApiProvider = components["schemas"]["ServiceProvider"];
type ApiPricing = components["schemas"]["ServicePricing"];
type ApiWallet = components["schemas"]["ServiceWallet"];
type ApiTopUp = components["schemas"]["ServiceTopUp"];
type ApiMetric = components["schemas"]["QuotaMetric"];
type ApiListing = components["schemas"]["TicketListing"];
type ApiTicketProvider = components["schemas"]["TicketProvider"];
type ApiPurchased = components["schemas"]["PurchasedTicket"];
type ApiOwned = components["schemas"]["OwnedTicket"];
type ErrorResponse = components["schemas"]["ErrorResponse"];

const SERVICE_UNAVAILABLE = "The service is unavailable.";

export class ServiceBillingError extends Error {
  // The HTTP status the API answered with, when it did answer.
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

function priceFromApi(price: ApiPrice): ServicePrice {
  return {
    cachedMicroPerMillion: price.cached_micro_per_million,
    inputMicroPerMillion: price.input_micro_per_million,
    outputMicroPerMillion: price.output_micro_per_million,
  };
}

function modelFromApi(model: ApiModel): ServiceModel {
  return {
    id: model.id,
    name: model.name,
    price: priceFromApi(model.price),
  };
}

function providerFromApi(provider: ApiProvider): ServiceProvider {
  return {
    available: provider.available,
    label: provider.label,
    models: provider.models.map(modelFromApi),
    provider: provider.provider,
  };
}

function pricingFromApi(pricing: ApiPricing): ServicePricing {
  return {
    currency: pricing.currency,
    minBalanceMicro: pricing.min_balance_micro,
    providers: pricing.providers.map(providerFromApi),
    cardTopUp: pricing.card_top_up,
    testTopUp: pricing.test_top_up,
  };
}

function walletFromApi(wallet: ApiWallet): ServiceWallet {
  return { walletMicro: wallet.wallet_micro };
}

function topUpFromApi(topUp: ApiTopUp): ServiceTopUp {
  return {
    checkoutUrl: topUp.checkout_url ?? null,
    walletMicro: topUp.wallet_micro,
  };
}

function billingError(error?: ErrorResponse, status?: number) {
  return new ServiceBillingError(
    error?.message ?? "The request could not be completed.",
    status,
  );
}

function metricFromApi(metric: ApiMetric): TicketQuotaMetric {
  return {
    detail: metric.detail ?? null,
    label: metric.label,
    value: metric.value,
  };
}

function listingFromApi(listing: ApiListing): TicketListing {
  return {
    days: listing.days,
    id: listing.id,
    name: listing.name,
    priceMicro: listing.price_micro,
    quota: listing.quota.map(metricFromApi),
    quotaCapturedAt: listing.quota_captured_at ?? null,
  };
}

function ticketProviderFromApi(provider: ApiTicketProvider): TicketProvider {
  return {
    label: provider.label,
    listings: provider.listings.map(listingFromApi),
    provider: provider.provider as TicketProvider["provider"],
  };
}

function purchasedFromApi(ticket: ApiPurchased): PurchasedTicket {
  return {
    days: ticket.days,
    expiresAt: ticket.expires_at,
    key: ticket.key,
    keyId: ticket.key_id,
    lastFour: ticket.last_four,
    name: ticket.name,
    priceMicro: ticket.price_micro,
    provider: ticket.provider as PurchasedTicket["provider"],
  };
}

function ownedFromApi(ticket: ApiOwned): OwnedTicket {
  return {
    days: ticket.days,
    expiresAt: ticket.expires_at,
    keyId: ticket.key_id,
    lastFour: ticket.last_four,
    name: ticket.name,
    priceMicro: ticket.price_micro,
    provider: ticket.provider as OwnedTicket["provider"],
    purchasedAt: ticket.purchased_at,
    status: ticket.status === "expired" ? "expired" : "active",
  };
}

class ServiceBillingService {
  readonly baseUrl: string;

  readonly queryKey = ["service"] as const;

  readonly pricingQueryKey = [...this.queryKey, "pricing"] as const;

  readonly ticketsQueryKey = [...this.queryKey, "tickets"] as const;

  private readonly client: Client<paths>;

  constructor() {
    this.baseUrl = (
      import.meta.env.VITE_API_BASE_URL ?? "http://localhost:8080"
    ).replace(/\/$/, "");

    this.client = createClient<paths>({
      baseUrl: this.baseUrl,
      credentials: "include",
      fetch: (...args) => globalThis.fetch(...args),
    });
  }

  walletQueryKey(userId: string | undefined) {
    return [...this.queryKey, "wallet", userId ?? "guest"] as const;
  }

  ownedTicketsQueryKey(userId: string | undefined) {
    return [...this.queryKey, "owned-tickets", userId ?? "guest"] as const;
  }

  private async refreshSession() {
    const { data } = await this.client.POST("/auth/refresh");

    return Boolean(data);
  }

  /**
   * Run an API call and repeat it once when the Hub session had expired and
   * could be refreshed.
   */
  private async request<T extends { response: Response }>(
    call: () => Promise<T>,
  ): Promise<T> {
    const result = await call();

    if (result.response.status === 401 && (await this.refreshSession()))
      return call();

    return result;
  }

  /**
   * Let service errors through and replace any other failure, such as a
   * network error, with the unavailable message.
   */
  private async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof ServiceBillingError) throw error;

      throw new ServiceBillingError(SERVICE_UNAVAILABLE);
    }
  }

  /**
   * What a million tokens cost and the models on offer. Public.
   */
  async pricing(): Promise<ServicePricing> {
    return this.guard(async () => {
      const result = await this.client.GET("/service/pricing");

      if (!result.data) throw billingError(result.error);

      return pricingFromApi(result.data);
    });
  }

  /**
   * The tickets for sale, by agent. Public. An agent with nothing for sale is not
   * in the answer, and nothing says who sells a ticket or which account it is.
   */
  async ticketListings(): Promise<TicketProvider[]> {
    return this.guard(async () => {
      const result = await this.client.GET("/service/listings");

      if (!result.data)
        throw billingError(result.error, result.response.status);

      return result.data.providers.map(ticketProviderFromApi);
    });
  }

  /**
   * Buy a ticket from the wallet. The key in the answer is shown once: only its
   * hash is kept, so it cannot be read again. Rejects with the status the API
   * answered with (402 for a wallet that cannot cover it, 404 for a ticket that is
   * gone or was sold just now, 502 for an account that did not answer a test).
   */
  async purchaseTicket(id: string): Promise<PurchasedTicket> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.POST("/service/listings/{id}/purchase", {
          params: { path: { id } },
        }),
      );

      if (!result.data)
        throw billingError(result.error, result.response.status);

      return purchasedFromApi(result.data);
    });
  }

  /**
   * The tickets the signed-in user bought, newest first, without their keys.
   */
  async ownedTickets(): Promise<OwnedTicket[]> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.GET("/service/tickets"),
      );

      if (!result.data)
        throw billingError(result.error, result.response.status);

      return result.data.tickets.map(ownedFromApi);
    });
  }

  /**
   * A new key for a ticket whose key was lost, with the same end. The old key stops
   * working. The new one is shown once.
   */
  async reissueTicket(keyId: string): Promise<PurchasedTicket> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.POST("/service/tickets/{key_id}/reissue", {
          params: { path: { key_id: keyId } },
        }),
      );

      if (!result.data)
        throw billingError(result.error, result.response.status);

      return purchasedFromApi(result.data);
    });
  }

  /**
   * The signed-in user's wallet.
   */
  async wallet(): Promise<ServiceWallet> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.GET("/service/wallet"),
      );

      if (!result.data) throw billingError(result.error);

      return walletFromApi(result.data);
    });
  }

  /**
   * Start a top-up. With card payments it opens a Stripe Checkout and returns where
   * to send the customer; the wallet is credited when Stripe confirms the payment.
   * Where only test top-ups exist, the wallet is credited at once.
   */
  async topUp(amountMicro: number): Promise<ServiceTopUp> {
    return this.guard(async () => {
      const result = await this.request(() =>
        this.client.POST("/service/top-up", {
          body: { amount_micro: amountMicro },
        }),
      );

      if (!result.data) throw billingError(result.error);

      return topUpFromApi(result.data);
    });
  }
}

export const serviceBillingService = new ServiceBillingService();
