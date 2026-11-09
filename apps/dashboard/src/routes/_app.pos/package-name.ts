// The limits `apps/api` enforces on a package's plan and variant.
export const MAX_PLAN_CHARACTERS = 64;
export const MAX_VARIANT_CHARACTERS = 32;

export interface PackageName {
  plan: string;
  variant: string | null;
}

// Trimmed, with each run of whitespace made one space, as the server stores it.
function tidy(text: string) {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

/**
 * Reads the one line the form takes for a package's name: the plan, and the
 * variant in the last brackets, the way `productTitle` writes them. `Plus 1
 * tháng (Gia đình)` is the plan `Plus 1 tháng` and the variant `Gia đình`; a
 * line without brackets at its end is all plan.
 */
export function parsePackageName(text: string): PackageName {
  const name = tidy(text);
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(name);

  if (match === null || match[1] === "") return { plan: name, variant: null };

  return { plan: match[1], variant: match[2].trim() || null };
}

/** The line that `parsePackageName` reads back into this plan and variant. */
export function composePackageName({ plan, variant }: PackageName) {
  return variant ? `${plan} (${variant})` : plan;
}

/** What is too long in a name, or null. */
export function checkPackageName({ plan, variant }: PackageName) {
  if ([...plan].length > MAX_PLAN_CHARACTERS)
    return `Tên gói dài tối đa ${MAX_PLAN_CHARACTERS} ký tự.`;

  if (variant !== null && [...variant].length > MAX_VARIANT_CHARACTERS)
    return `Biến thể trong ngoặc dài tối đa ${MAX_VARIANT_CHARACTERS} ký tự.`;

  return null;
}
