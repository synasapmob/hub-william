import type { TicketQuotaMetric } from "@/services/service-billing/service-billing-types";

/** What an account had left, on one line, in the provider's own words. */
export function quotaSummary(quota: TicketQuotaMetric[]) {
  return quota.map((metric) => `${metric.label} ${metric.value}`).join(" · ");
}

/** A day as a person reads it: `Nov 13, 2026`. */
export function formatDay(iso: string) {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
    new Date(iso),
  );
}

/** A moment as a person reads it: `Nov 13, 2026, 4:30 PM`. */
export function formatMoment(iso: string) {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
