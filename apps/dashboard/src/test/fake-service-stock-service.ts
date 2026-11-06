import { ServiceError } from "@/services/api/api-client";
import type {
  ListingStatus,
  QuotaMetric,
  ServiceListing,
  ServiceProvider,
  ServiceSale,
  VerifiedAccount,
} from "@/services/sales/sales-types";
import type {
  ServiceListingChange,
  ServiceListingTerms,
} from "@/services/service-stock/service-stock-service";

import { providerOfConnection } from "./fake-agent-connection-service";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const FIVE_HOUR: QuotaMetric = {
  detail: "resets in 2h",
  label: "5-hour limit",
  value: "80% left",
};
const WEEKLY: QuotaMetric = {
  detail: null,
  label: "Weekly limit",
  value: "50% left",
};

// What a test starts from, shaped like the API's answers: two agents with tickets
// (one of them with a ticket that is switched off), and none for the rest.
const LISTINGS: ServiceListing[] = [
  {
    account_label: "Shop Claude",
    created_at: "2026-11-05T10:00:00+07:00",
    days: 7,
    id: "listing-claude-max",
    listed: true,
    name: "Claude Max · 7 ngày",
    plan: "Max",
    price_micro: 4_000_000,
    provider: "claude",
    quota: [FIVE_HOUR, WEEKLY],
    quota_captured_at: "2026-11-06T09:30:00+07:00",
    seller: "minhanh",
    status: "for_sale",
  },
  {
    account_label: null,
    created_at: "2026-11-05T11:00:00+07:00",
    days: 3,
    id: "listing-claude-pro",
    listed: false,
    name: "Claude Pro · 3 ngày",
    plan: "Pro",
    price_micro: 1_500_000,
    provider: "claude",
    quota: [],
    quota_captured_at: null,
    seller: "quocbao",
    status: "hidden",
  },
  {
    account_label: "Shop ChatGPT",
    created_at: "2026-11-05T12:00:00+07:00",
    days: 30,
    id: "listing-chatgpt-plus",
    listed: true,
    name: "ChatGPT Plus · 30 ngày",
    plan: "Plus",
    price_micro: 9_990_000,
    provider: "chatgpt",
    quota: [{ ...FIVE_HOUR, label: "Weekly limit", value: "65% left" }],
    quota_captured_at: "2026-11-06T09:30:00+07:00",
    seller: "minhanh",
    status: "for_sale",
  },
];

/** The sales of the last days, relative to now so a range filter finds them. */
function sales(): ServiceSale[] {
  const now = Date.now();

  return [
    {
      buyer: "quocbao",
      days: 7,
      expires_at: new Date(now + 6 * DAY_MS).toISOString(),
      id: "sale-claude-max",
      key_last_four: "ab12",
      name: "Claude Max · 7 ngày",
      price_micro: 4_000_000,
      provider: "claude",
      seller: "minhanh",
      sold_at: new Date(now - HOUR_MS).toISOString(),
    },
    {
      buyer: "thuha",
      days: 30,
      expires_at: new Date(now + 27 * DAY_MS).toISOString(),
      id: "sale-chatgpt-plus",
      key_last_four: "cd34",
      name: "ChatGPT Plus · 30 ngày",
      price_micro: 9_990_000,
      provider: "chatgpt",
      seller: "quocbao",
      sold_at: new Date(now - 2 * DAY_MS).toISOString(),
    },
    {
      buyer: "linh",
      days: 7,
      expires_at: new Date(now - 13 * DAY_MS).toISOString(),
      id: "sale-grok-heavy",
      key_last_four: "ef56",
      name: "Grok SuperGrok · 7 ngày",
      price_micro: 3_000_000,
      provider: "grok",
      seller: "minhanh",
      sold_at: new Date(now - 20 * DAY_MS).toISOString(),
    },
  ];
}

let listings: ServiceListing[] = structuredClone(LISTINGS);
let sold: ServiceSale[] = sales();

/** Puts the Service back as every test starts. */
export function resetFakeServiceStock() {
  listings = structuredClone(LISTINGS);
  sold = sales();
}

/** What a provider says an account has left: ChatGPT, Claude and Grok do, the rest do not. */
function quotaOf(provider: ServiceProvider): QuotaMetric[] {
  return ["chatgpt", "claude", "grok"].includes(provider)
    ? [{ detail: "resets in 4h", label: "5-hour limit", value: "90% left" }]
    : [];
}

const MAXIMUM_PRICE_MICRO = 10_000_000_000;

function refuse(message: string) {
  return new ServiceError(message, 422, "validation_error");
}

function checkTerms({ days, name, price_micro }: ServiceListingTerms) {
  if (name.trim() === "" || name.trim().length > 80)
    throw refuse("The name must be 1 to 80 characters.");

  if (days < 1 || days > 365) throw refuse("The days must be 1 to 365.");

  if (
    price_micro < 10_000 ||
    price_micro > MAXIMUM_PRICE_MICRO ||
    price_micro % 10_000 !== 0
  )
    throw refuse("The price must be whole cents, from $0.01 to $10,000.");
}

/**
 * The Service's stock as the server would answer, kept in memory: the same
 * refusals (terms out of range, an account on sale already, a ticket that is gone)
 * and the same answers. A test replaces one method with a spy to see what was
 * asked, or to make it fail.
 */
export const fakeServiceStockService = {
  listingsKey: ["dashboard", "service", "listings"] as const,

  salesKey: ["dashboard", "service", "sales"] as const,

  async listings(): Promise<ServiceListing[]> {
    return structuredClone(listings);
  },

  /** An account the fake connected: its agent is in its id. */
  async verify(connectionId: string): Promise<VerifiedAccount> {
    const provider = providerOfConnection(connectionId);

    return {
      account_label: "Account mới",
      captured_at: "2026-11-06T12:00:00+07:00",
      plan: "Plus",
      provider,
      quota: quotaOf(provider),
    };
  },

  async addListing(
    connectionId: string,
    terms: ServiceListingTerms,
  ): Promise<ServiceListing> {
    checkTerms(terms);

    const provider = providerOfConnection(connectionId);

    if (listings.some((listing) => listing.id === `listing-${connectionId}`))
      throw new ServiceError(
        "That account is on sale already, or sold to a customer whose ticket has not ended.",
        409,
        "already_exists",
      );

    const added: ServiceListing = {
      account_label: "Account mới",
      created_at: "2026-11-06T12:00:00+07:00",
      days: terms.days,
      id: `listing-${connectionId}`,
      listed: true,
      name: terms.name.trim(),
      plan: "Plus",
      price_micro: terms.price_micro,
      provider,
      quota: quotaOf(provider),
      quota_captured_at: "2026-11-06T12:00:00+07:00",
      seller: "minhanh",
      status: "for_sale",
    };

    listings = [...listings, added];

    return structuredClone(added);
  },

  async updateListing(
    id: string,
    change: ServiceListingChange,
  ): Promise<ServiceListing> {
    checkTerms(change);

    const existing = listings.find((listing) => listing.id === id);

    if (!existing) throw notFound();

    const status: ListingStatus = change.listed ? "for_sale" : "hidden";

    Object.assign(existing, {
      days: change.days,
      listed: change.listed,
      name: change.name.trim(),
      price_micro: change.price_micro,
      status,
    });

    return structuredClone(existing);
  },

  async removeListing(id: string): Promise<void> {
    if (!listings.some((listing) => listing.id === id)) throw notFound();

    listings = listings.filter((listing) => listing.id !== id);
  },

  async sales(): Promise<ServiceSale[]> {
    return structuredClone(sold);
  },
};

function notFound() {
  return new ServiceError(
    "The requested resource was not found.",
    404,
    "not_found",
  );
}
