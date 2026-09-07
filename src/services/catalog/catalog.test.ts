import { describe, expect, it } from "vitest";

import catalogService, { type CatalogEntry } from "@/services/catalog";

const harnessEntries = catalogService.listEntriesByCategory("harness");

/** The tag whose file the harness dispatcher names, so a real path is asserted. */
const planTag = harnessEntries.find((entry) => entry.id.endsWith("/tags/plan"));

/** A contract that fires without a tag, which is the other half of `harness`. */
const supporting = harnessEntries.find((entry) => entry.group !== "tags");

/**
 * How many entries the canvas draws out of one folder.
 *
 * Scoped to the folder rather than to the category, because a category can span
 * two folders: `hooks/` is drawn on the Harnesses card, so counting the card
 * would compare an archive against entries that are not in it.
 */
function entriesUnder(folder: string) {
  return catalogService
    .listEntriesByCategory("harness")
    .concat(catalogService.listEntriesByCategory("harness", "synasapmob"))
    .concat(catalogService.listEntriesByCategory("skills"))
    .filter((entry) => entry.id.startsWith(`${folder}/`)).length;
}

describe("rootArchive", () => {
  it("names the folder the entry sits in", () => {
    expect(planTag).toBeDefined();
    expect(catalogService.rootArchive(planTag!)).toMatchObject({
      name: "harness.zip",
      url: expect.stringContaining(
        "/catalog/contributors/default/libraries/harness.zip",
      ),
    });
  });

  it("is named for the folder on disk, not the card the entry is drawn on", () => {
    // `hooks/` is drawn on the Harnesses card through `ROOT_ALIASES`, so an
    // archive built from the category would ask for a folder that does not
    // exist.
    const hook = catalogService
      .listEntriesByCategory("harness", "synasapmob")
      .find((entry) => entry.id.includes("/hooks/"));

    expect(hook).toBeDefined();
    expect(catalogService.rootArchive(hook!).name).toBe("hooks.zip");
  });

  it("counts a skill's references, which are pages rather than entries", () => {
    // The regression this replaces: the archive used to be zipped in the
    // browser out of the entries the canvas renders, so a skill arrived
    // without the reference it tells an agent to read.
    const folder = "contributors/default/libraries/skills";
    const skill = catalogService.listEntriesByCategory("skills").at(0);

    expect(skill).toBeDefined();
    expect(catalogService.rootArchive(skill!).fileCount).toBeGreaterThan(
      entriesUnder(folder),
    );
  });

  it("counts a file beside a contract that is not a document", () => {
    // The same regression from the other side: `registry.yaml` is read by the
    // contract that names it, and an archive filtered to Markdown left that
    // contract pointing at a file which never arrived.
    const folder = "contributors/synasapmob/libraries/harness";
    const projects = catalogService
      .listEntriesByCategory("harness", "synasapmob")
      .find((entry) => entry.group === "projects");

    expect(projects).toBeDefined();
    expect(catalogService.rootArchive(projects!).fileCount).toBeGreaterThan(
      entriesUnder(folder),
    );
  });
});

describe("category", () => {
  it("carries the folder's own name, which is what a sheet branches on", () => {
    // The sheet renders a template as a copyable snippet rather than as
    // Markdown, and compared against `"TEMPLATES"` to decide — a value this
    // service has never produced, so the branch was dead and every template
    // rendered as the page of bare headings the snippet exists to avoid.
    // `rootLabel` is what upper-cases a category, and only for display.
    const template = catalogService.listEntriesByCategory("templates").at(0);

    expect(template).toBeDefined();
    expect(template!.category).toBe("templates");
  });
});

describe("usage", () => {
  it("addresses a document by the path the harness reads it from", () => {
    expect(catalogService.usage(planTag!).destination).toBe(
      "~/.hub-william/contributors/default/libraries/harness/tags/plan.md",
    );
  });

  it("lists the modes a tag contract declares, in the document's own order", () => {
    const delivery = harnessEntries.find((entry) =>
      entry.id.endsWith("/tags/delivery"),
    );

    expect(delivery).toBeDefined();
    expect(catalogService.usage(delivery!).invocations).toEqual([
      "[delivery-local]",
      "[delivery-ete]",
      "[delivery-linear-<ISSUE-ID>]",
    ]);
  });

  it("reads headings only, so a tag quoted in prose is not offered", () => {
    // `delivery.md` discusses `[worktree]` and `[playwright]` at length without
    // defining either. Listing every tag a contract mentions would tell a
    // reader to type things this document does not own.
    const delivery = harnessEntries.find((entry) =>
      entry.id.endsWith("/tags/delivery"),
    );

    expect(delivery!.source).toContain("`[worktree]`");
    expect(catalogService.usage(delivery!).invocations).not.toContain(
      "[worktree]",
    );
  });

  it("reaches a skill by the name its own front matter declares", () => {
    const skill = catalogService
      .listEntriesByCategory("skills")
      .find((entry) => entry.id.includes("/frontend-convention/"));

    expect(skill).toBeDefined();
    expect(catalogService.usage(skill!).invocations).toEqual([
      "/frontend-convention",
    ]);
  });

  it("falls back to what a contract covers when nothing types it", () => {
    expect(supporting).toBeDefined();
    expect(catalogService.usage(supporting!).invocations).toEqual([]);

    const installer = catalogService
      .listEntriesByCategory("installer")
      .find((entry) => entry.id.endsWith("machine-installer"));

    expect(installer).toBeDefined();
    expect(catalogService.usage(installer!)).toMatchObject({
      invocations: [],
      sections: expect.arrayContaining(["Install", "Where things land"]),
    });
  });

  it("still places a document from a folder nobody has described", () => {
    const invented: CatalogEntry = {
      ...planTag!,
      id: "contributors/someone/libraries/rituals/dawn",
      category: "rituals",
      group: "rituals",
      source: "# Dawn\n\nNothing here is typed.\n",
    };

    expect(catalogService.usage(invented)).toEqual({
      destination:
        "~/.hub-william/contributors/someone/libraries/rituals/dawn.md",
      invocations: [],
      sections: [],
    });
  });
});

describe("documentUrl", () => {
  it("is absolute, so a copied command runs on whichever host served it", () => {
    expect(catalogService.documentUrl(planTag!)).toBe(
      `${window.location.origin}/catalog/contributors/default/libraries/harness/tags/plan.md`,
    );
  });
});

describe("findMarkdownReference", () => {
  const reportTag = harnessEntries.find((entry) =>
    entry.id.endsWith("/tags/report"),
  )!;

  it("resolves a reference relative to the document that contains it", () => {
    expect(
      catalogService.findMarkdownReference(reportTag, "../github/gh-cli.md")
        ?.id,
    ).toBe("contributors/default/libraries/harness/github/gh-cli");
  });

  it("normalizes a vendored contributor path to its catalogue identity", () => {
    expect(
      catalogService.findMarkdownReference(
        reportTag,
        "../../../contributors/synasapmob/contributors/default/libraries/harness/linear/creation-policy.md",
      )?.id,
    ).toBe("contributors/synasapmob/libraries/harness/linear/creation-policy");
  });

  it("does not rewrite an external URL that happens to mention contributors", () => {
    expect(
      catalogService.findMarkdownReference(
        reportTag,
        "https://example.com/contributors/default/libraries/harness/github/gh-cli.md",
      ),
    ).toBeNull();
  });
});
