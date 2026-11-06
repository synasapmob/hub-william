import { formatVnd } from "@/utils/utils.format";

/**
 * An amount as a page shows it, but with ordinary spaces: the page writes a
 * no-break space before the sign, and a test that compares text reads it as a
 * space.
 */
export function money(amount: number) {
  return formatVnd(amount).replace(/\s/g, " ");
}
