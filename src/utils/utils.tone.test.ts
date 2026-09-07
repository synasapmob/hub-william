import { describe, expect, it } from "vitest";

import catalogService, { type CatalogSection } from "@/services/catalog";
import { toneForRoot } from "@/utils/utils.tone";

/** What a root wears until the table gives it a hue of its own. */
const UNCLAIMED = "slate";

const SECTIONS: CatalogSection[] = ["library", "tools"];

/**
 * Every canvas the site can draw.
 *
 * One per section, and one more per person with a workspace on it, because a
 * contributor's canvas draws only their roots — so distinctness has to hold on
 * each of those separately rather than across the catalogue as a whole.
 */
function canvases() {
  return SECTIONS.flatMap((section) =>
    [null, ...catalogService.contributors(section)].map((contributor) => ({
      contributor,
      roots: catalogService.rootsInSection(section, contributor),
      section,
    })),
  );
}

describe("toneForRoot", () => {
  it("gives every root of the shared catalogue a hue", () => {
    const roots = SECTIONS.flatMap((section) =>
      catalogService.rootsInSection(section, null),
    );

    expect(roots.length).toBeGreaterThan(0);

    for (const root of roots) {
      expect(toneForRoot(root), root).not.toBe(UNCLAIMED);
    }
  });

  // The table this replaced pinned eleven names onto nine hues, so `tags` and
  // `skills` both drew violet and `linear` and `templates` both drew sky — two
  // collisions that were on screen together and that nothing would have caught.
  it("never draws one canvas with two roots in the same hue", () => {
    for (const { contributor, roots, section } of canvases()) {
      const hues = roots
        .map((root) => toneForRoot(root))
        .filter((tone) => tone !== UNCLAIMED);

      expect(
        new Set(hues).size,
        `${section}/${contributor ?? "default"}: ${hues.join(", ")}`,
      ).toBe(hues.length);
    }
  });

  it("leaves an unregistered root neutral rather than inventing a hue", () => {
    expect(toneForRoot("a-folder-nobody-has-made-yet")).toBe(UNCLAIMED);
  });
});
