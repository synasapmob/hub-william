const MAX_SLUG_LENGTH = 64;

/**
 * A product slug: the words folded to lowercase ASCII (Vietnamese accents
 * included) and joined by hyphens, at most 64 characters. It is the rule
 * `apps/api` applies, so the dashboard can show the slug before the product exists.
 */
export default function slugify(...parts: (string | null | undefined)[]) {
  return parts
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/gi, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/, "");
}
