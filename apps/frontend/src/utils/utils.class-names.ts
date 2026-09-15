import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge conditional class lists, with later Tailwind utilities winning conflicts.
 *
 * App surfaces express their variants through `tailwind-variants` and never need this. It stays
 * for `src/components/ui/`, which is shadcn output: those primitives are rewritten wholesale by
 * `shadcn add`, so composing them by hand would be undone by the next run. `components.json`
 * points its `utils` alias at this file so a regenerated primitive still imports the helper it
 * expects.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
