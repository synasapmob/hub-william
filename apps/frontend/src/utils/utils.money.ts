export const MICRO_PER_DOLLAR = 1_000_000;

// A request costs fractions of a cent, so small amounts keep four decimals and
// larger ones show cents.
export function formatDollars(micro: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "USD",
    maximumFractionDigits: Math.abs(micro) >= 10 * MICRO_PER_DOLLAR ? 2 : 4,
    minimumFractionDigits: 2,
    style: "currency",
  }).format(micro / MICRO_PER_DOLLAR);
}

// Reads a typed dollar amount into whole micro-dollars without going through a
// float, so 0.1 is exactly 100000. Null when the text is not a plain amount with
// at most six decimals.
export function dollarsToMicro(text: string) {
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text.trim());

  if (!match) return null;

  const micro =
    Number(match[1]) * MICRO_PER_DOLLAR +
    Number((match[2] ?? "").padEnd(6, "0"));

  return Number.isSafeInteger(micro) ? micro : null;
}
