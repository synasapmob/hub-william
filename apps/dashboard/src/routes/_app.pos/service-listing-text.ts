import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type {
  QuotaMetric,
  ServiceListing,
  ServiceProvider,
} from "@/services/sales/sales-types";

const MICRO_PER_DOLLAR = 1_000_000;
const MICRO_PER_CENT = 10_000;

/** The least and most a ticket costs, as the API takes them: $0.01 and $10,000. */
export const MINIMUM_PRICE_MICRO = MICRO_PER_CENT;
export const MAXIMUM_PRICE_MICRO = 10_000 * MICRO_PER_DOLLAR;

export const MAXIMUM_DAYS = 365;

/**
 * Dollars as typed (`4`, `4.5`, `9.99`) to micro-dollars, or null when what was typed
 * is not an amount of dollars and cents the API takes. It is worked out on the
 * digits, never through a float.
 */
export function priceMicroFromTyped(typed: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(typed.trim());

  if (!match) return null;

  const cents =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  const micro = cents * MICRO_PER_CENT;

  return micro >= MINIMUM_PRICE_MICRO && micro <= MAXIMUM_PRICE_MICRO
    ? micro
    : null;
}

/** Micro-dollars as they are typed: `4000000` is `4`, `9990000` is `9.99`. */
export function typedFromPriceMicro(micro: number) {
  const dollars = micro / MICRO_PER_DOLLAR;

  return Number.isInteger(dollars) ? String(dollars) : dollars.toFixed(2);
}

/** A whole number of days the API takes, or null. */
export function daysFromTyped(typed: string): number | null {
  if (!/^\d+$/.test(typed.trim())) return null;

  const days = Number(typed);

  return days >= 1 && days <= MAXIMUM_DAYS ? days : null;
}

/**
 * What a ticket is called until its seller renames it: the agent, the plan of the
 * account that was verified, and for how long.
 */
export function listingName(
  provider: ServiceProvider,
  plan: string | null,
  days: number,
) {
  return [serviceProviderLabels[provider], plan, `· ${days} ngày`]
    .filter(Boolean)
    .join(" ");
}

/** What an account has left, on one line: the provider's own words. */
export function quotaLine(quota: QuotaMetric[]) {
  return quota.map((metric) => `${metric.label} ${metric.value}`).join(" · ");
}

/** What the search looks at in a ticket. */
export function listingSearchText(listing: ServiceListing) {
  return [
    listing.name,
    serviceProviderLabels[listing.provider],
    listing.account_label ?? "",
    listing.plan ?? "",
  ]
    .join(" ")
    .toLowerCase();
}
