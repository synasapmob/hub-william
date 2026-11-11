import type { Currency, TelegramProduct } from "@/services/sales/sales-types";

const MICRO_PER_DOLLAR = 1_000_000;
const SHOP_TIME_ZONE = "Asia/Ho_Chi_Minh";

const vnd = new Intl.NumberFormat("vi-VN", {
  currency: "VND",
  maximumFractionDigits: 0,
  style: "currency",
});

const usd = new Intl.NumberFormat("en-US", {
  currency: "USD",
  style: "currency",
});

// A price of a million tokens can be a fraction of a cent: $0.006, $0.075.
const usdPrice = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 6,
  minimumFractionDigits: 2,
  style: "currency",
});

const time = new Intl.DateTimeFormat("vi-VN", {
  hour: "2-digit",
  hourCycle: "h23",
  minute: "2-digit",
  timeZone: SHOP_TIME_ZONE,
});

const dayParts = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "2-digit",
  timeZone: SHOP_TIME_ZONE,
});

const dayWithWeekday = new Intl.DateTimeFormat("vi-VN", {
  day: "2-digit",
  month: "2-digit",
  timeZone: SHOP_TIME_ZONE,
  weekday: "long",
});

export function formatVnd(amount: number) {
  return vnd.format(amount);
}

export function formatUsd(micro: number) {
  return usd.format(micro / MICRO_PER_DOLLAR);
}

/** What a million tokens cost, to the last micro-dollar: `$0.075`, `$10.00`. */
export function formatPricePerMillion(micro: number) {
  return usdPrice.format(micro / MICRO_PER_DOLLAR);
}

export function formatMoney(amount: number, currency: Currency) {
  return currency === "VND" ? formatVnd(amount) : formatUsd(amount);
}

// One decimal at most, written with a comma and without a trailing ",0".
function trimmed(value: number) {
  return value.toFixed(1).replace(/\.0$/, "").replace(".", ",");
}

/** Axis labels and tiles: 1,2 tr, 850k, 3,4 tỷ. */
export function formatCompactVnd(amount: number) {
  const size = Math.abs(amount);

  if (size >= 1_000_000_000) return `${trimmed(amount / 1_000_000_000)} tỷ`;

  if (size >= 1_000_000) return `${trimmed(amount / 1_000_000)} tr`;

  if (size >= 1_000) return `${trimmed(amount / 1_000)}k`;

  return String(amount);
}

/** Axis labels and tiles: $0.5, $12, $1.2K. */
export function formatCompactUsd(micro: number) {
  const dollars = micro / MICRO_PER_DOLLAR;

  if (Math.abs(dollars) >= 1_000)
    return `$${(dollars / 1_000).toFixed(1).replace(/\.0$/, "")}K`;

  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(1)}`;
}

export function formatCompactMoney(amount: number, currency: Currency) {
  return currency === "VND"
    ? formatCompactVnd(amount)
    : formatCompactUsd(amount);
}

/** 44,2M tokens; the number the shop quotes, not an exact count. */
export function formatTokens(tokens: number) {
  if (tokens >= 1_000_000_000) return `${trimmed(tokens / 1_000_000_000)}B`;

  if (tokens >= 1_000_000) return `${trimmed(tokens / 1_000_000)}M`;

  if (tokens >= 1_000) return `${trimmed(tokens / 1_000)}K`;

  return String(tokens);
}

/** `14:21 05/11`: time first, as a shop reads a till receipt. */
export function formatDateTime(iso: string) {
  return `${formatTime(iso)} ${formatDay(iso)}`;
}

export function formatTime(iso: string) {
  return time.format(new Date(iso));
}

// Built from the parts so the separator is always a slash: ICU's own pattern
// for vi-VN is `04-11` here but `05/11` once a weekday joins it.
export function formatDay(iso: string) {
  const parts = Object.fromEntries(
    dayParts
      .formatToParts(new Date(iso))
      .map(({ type, value }) => [type, value]),
  );

  return `${parts.day}/${parts.month}`;
}

export function formatDayWithWeekday(iso: string) {
  return dayWithWeekday.format(new Date(iso));
}

/** The shop-local calendar day of a timestamp, as `YYYY-MM-DD`. */
export function shopDay(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: SHOP_TIME_ZONE,
    year: "numeric",
  }).format(new Date(iso));
}

/** The digits of what was typed, which is all an amount of đồng is made of. */
export function digitsOf(text: string) {
  return text.replace(/\D/g, "");
}

/** `140000` as `140.000`: digits grouped in threes with a dot, as an amount is read. */
export function groupDigits(digits: string) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/** Where the caret goes in `text` to sit after its `count`-th digit. */
export function caretAfterDigits(text: string, count: number) {
  if (count <= 0) return 0;

  let seen = 0;

  for (let index = 0; index < text.length; index += 1) {
    if (/\d/.test(text[index])) seen += 1;

    if (seen === count) return index + 1;
  }

  return text.length;
}

/** 12 phút, 5 giờ, 2 ngày: the largest unit that is at least one. */
export function formatDuration(minutes: number) {
  if (minutes >= 1_440) return `${Math.floor(minutes / 1_440)} ngày`;

  if (minutes >= 60) return `${Math.floor(minutes / 60)} giờ`;

  return `${minutes} phút`;
}

/**
 * `Plus 1 tháng (Quốc tế)`: what a customer calls the package, which is the name
 * the shop wrote with its variant in brackets. The provider groups packages and
 * is not put in front, so a shop that wants its brand in the name writes it there.
 */
export function productTitle(product: TelegramProduct) {
  return `${product.plan}${product.variant ? ` (${product.variant})` : ""}`;
}

/** Units a customer can still buy: what is on hand less what orders hold. */
export function availableStock(product: TelegramProduct) {
  return Math.max(product.on_hand - product.reserved, 0);
}

/** What a package is called to the person. */
export function stockItemTitle(item: TelegramProduct) {
  return productTitle(item);
}

export function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .map((word) => word[0]?.toUpperCase())
    .join("");
}
