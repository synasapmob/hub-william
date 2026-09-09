import { describe, expect, it } from "vitest";

import catalogService, { type CatalogEntry } from "@/services/catalog";

const harnessEntries = catalogService.listEntriesByCategory("harness");

/** The tag whose file the harness dispatcher names, so a real path is asserted. */
const planTag = harnessEntries.find((entry) => entry.id.endsWith("/tags/plan"));

/** A contract that fires without a tag, which is the other half of `harness`. */
const supporting = harnessEntries.find((entry) => entry.group !== "tags");

describe("collections", () => {
  it("draws one shared-library node per functional domain", () => {
    expect(
      catalogService
        .collectionsInSection("library")
        .map((collection) => collection.id),
    ).toEqual(["evidences", "github", "tags", "skills", "templates"]);
  });

  it("groups GitHub workflow tags with GitHub supporting contracts", () => {
    const github = catalogService.findCollection("github", "library");
    const ids = github?.entries.map((entry) => entry.id) ?? [];

    expect(ids.some((id) => id.endsWith("/github/gh-cli"))).toBe(true);
    for (const name of ["draft", "merge", "mergeable", "rebase"]) {
      expect(
        ids.some((id) => id.endsWith(`/tags/${name}`)),
        name,
      ).toBe(true);
    }
    expect(ids.some((id) => id.endsWith("/tags/plan"))).toBe(false);
  });

  it("keeps every rendered document in exactly one collection", () => {
    const collections = catalogService.collectionsInSection("library");
    const ids = collections.flatMap((collection) =>
      collection.entries.map((entry) => entry.id),
    );

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(catalogService.documentCount("library"));
  });

  it("keeps the harness dispatcher with the tags it activates", () => {
    const tags = catalogService.findCollection("tags", "library")!;
    const files = catalogService.collectionFiles(tags);
    const dispatcher = files.find((file) => file.name === "AGENTS.md");

    expect(dispatcher).toMatchObject({
      path: "contributors/default/libraries/harness/AGENTS.md",
      url: `${window.location.origin}/catalog/contributors/default/libraries/harness/AGENTS.md`,
    });
  });

  it("publishes virtual collection archives with supporting files", () => {
    const skills = catalogService.findCollection("skills", "library")!;
    const archive = catalogService.collectionArchive(skills);

    expect(archive).toMatchObject({
      name: "skills.zip",
      url: expect.stringContaining(
        "/catalog/collections/default/library/skills.zip",
      ),
    });
    expect(archive.fileCount).toBeGreaterThan(skills.entries.length);
    expect(catalogService.collectionFiles(skills)).toHaveLength(
      archive.fileCount,
    );
  });

  it("reduces Tools to Documents and MCP", () => {
    expect(
      catalogService
        .collectionsInSection("tools")
        .map((collection) => collection.id),
    ).toEqual(["documents", "mcp"]);
  });

  it("derives the five MCP products and keeps Supabase project-scoped", () => {
    const products = catalogService.mcpProducts();

    expect(products.map((product) => product.id)).toEqual([
      "notion",
      "linear",
      "playwright",
      "chrome-browser",
      "supabase",
    ]);
    expect(
      products.find((product) => product.id === "supabase")?.servers.length,
    ).toBeGreaterThan(1);
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
