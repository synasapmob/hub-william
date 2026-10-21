import { describe, expect, it } from "vitest";

import { catalogService } from "./catalog-service";
import {
  collectionPresentation,
  collectionRefForPath,
  compareCollectionIds,
} from "./catalog-collections";

describe("supported tool catalogue", () => {
  it("publishes the current shared tools including DOWNLOAD REEL", () => {
    expect(catalogService.collections().map((tool) => tool.id)).toEqual([
      "gateway",
      "opencode",
      "omp",
      "download-reel",
      "edge-tts",
      "vosk",
    ]);
    for (const retired of ["documents", "mcp", "skills", "tags", "github"]) {
      expect(catalogService.findCollection(retired)).toBeNull();
    }
  });

  it("keeps new tool contributions discoverable and archives scoped to their owner", () => {
    const ref = collectionRefForPath(
      "contributors/alice/tools/review-helper/README.md",
    );
    expect(ref).toEqual({
      owner: "alice",
      catalogue: "tools",
      id: "review-helper",
    });
    expect(collectionPresentation(ref!.id)).toMatchObject({
      label: "Review helper",
    });
    expect(
      ["review-helper", "omp", "gateway", "opencode", "another-tool"].sort(
        compareCollectionIds,
      ),
    ).toEqual(["gateway", "opencode", "omp", "another-tool", "review-helper"]);
    const contributedTool = {
      ...catalogService.findCollection("gateway")!,
      contributor: "alice",
    };
    expect(catalogService.collectionArchive(contributedTool).url).toBe(
      `${window.location.origin}/catalog/collections/alice/tools/gateway.zip`,
    );
    expect(catalogService.collections("missing-contributor")).toEqual([]);
    expect(
      catalogService.findCollection("gateway", "missing-contributor"),
    ).toBeNull();
  });

  it("excludes loose files and retired tool sources from the catalogue", () => {
    expect(collectionRefForPath("contributors/default/README.md")).toBeNull();
    expect(
      collectionRefForPath("contributors/default/tools/gateway.md"),
    ).toBeNull();
    expect(
      collectionRefForPath(
        "contributors/default/tools/installer/machine-installer.md",
      ),
    ).toBeNull();
    expect(
      collectionRefForPath("contributors/default/tools/mcp/mcp-servers.md"),
    ).toBeNull();
    expect(
      collectionRefForPath(
        "contributors/synasapmob/tools/installer/codex-workflow.md",
      ),
    ).toBeNull();
    expect(
      collectionRefForPath("contributors/default/tools/gateway/gateway.md"),
    ).toEqual({ owner: "default", catalogue: "tools", id: "gateway" });
  });

  it("reads any folder a contributor publishes as a catalogue", () => {
    expect(
      collectionRefForPath(
        "contributors/synasapmob/skills/hub-skills/mock-data/SKILL.md",
      ),
    ).toEqual({ owner: "synasapmob", catalogue: "skills", id: "hub-skills" });
    expect(
      collectionRefForPath(
        "contributors/synasapmob/scripts/link-skills/link.sh",
      ),
    ).toEqual({
      owner: "synasapmob",
      catalogue: "scripts",
      id: "link-skills",
    });
    expect(
      collectionRefForPath("contributors/synasapmob/skills/installer/SKILL.md"),
    ).not.toBeNull();
  });

  it("keeps every tool file in its corresponding download archive", () => {
    for (const collection of catalogService.collections()) {
      const files = catalogService.collectionFiles(collection);
      expect(files.length).toBeGreaterThan(0);
      expect(catalogService.collectionArchive(collection)).toEqual({
        name: `${collection.id}.zip`,
        url: `${window.location.origin}/catalog/collections/default/tools/${collection.id}.zip`,
      });
      for (const file of files) {
        expect(collectionRefForPath(file.path)?.id).toBe(collection.id);
        expect(file.url).toBe(`${window.location.origin}/catalog/${file.path}`);
        expect(file.source).toContain("# ");
      }
    }
  });

  it("documents the agent config the gateway installer writes", () => {
    const gateway = catalogService.findCollection("gateway");
    const file = catalogService
      .collectionFiles(gateway!)
      .find((entry) => entry.name === "gateway.md");

    expect(file?.source).toContain('model_provider = "hub-william"');
    expect(file?.source).toContain("[model_providers.hub-william]");
    expect(file?.source).toContain("/gateway/openai/v1");
    expect(file?.source).toContain("experimental_bearer_token");
    expect(file?.source).toContain('wire_api = "responses"');
    expect(file?.source).toContain("ANTHROPIC_BASE_URL");
    expect(file?.source).toContain("/gateway/claude");
    expect(file?.source).toContain("/gateway/grok/v1");
    expect(file?.source).toContain("/gateway/gemini");
    expect(file?.source).toContain("GOOGLE_GEMINI_BASE_URL");
    expect(file?.source).toContain("GEMINI_API_KEY");
    expect(file?.source).toContain("~/.codex/config.toml");
    expect(file?.source).toContain("python3 - --url=");
    expect(file?.source).toContain(
      "python3 - --url=https://<hub-william-origin>/api\n```",
    );
    expect(file?.source).toContain("hidden prompt");
  });
});

describe("contributor catalogues", () => {
  it("lists the folders a contributor publishes in display order", () => {
    expect(catalogService.catalogues()).toEqual(["tools"]);
    expect(catalogService.catalogues("synasapmob")).toEqual([
      "skills",
      "scripts",
    ]);
    expect(catalogService.catalogues("missing-contributor")).toEqual([]);
    expect(catalogService.contributors()).toContain("synasapmob");
  });

  it("keeps each catalogue's collections apart", () => {
    expect(
      catalogService.collections("synasapmob", "skills").map((c) => c.id),
    ).toEqual(["hub-skills"]);
    expect(
      catalogService.collections("synasapmob", "scripts").map((c) => c.id),
    ).toEqual(["link-skills"]);
    expect(catalogService.findCollection("skills")).toBeNull();
    expect(
      catalogService.findCollection("link-skills", "synasapmob", "skills"),
    ).toBeNull();
  });

  it("falls back to the first catalogue when the requested one is unknown", () => {
    expect(catalogService.resolveCatalogue("synasapmob", "scripts")).toBe(
      "scripts",
    );
    expect(catalogService.resolveCatalogue("synasapmob", "SCRIPTS")).toBe(
      "scripts",
    );
    expect(catalogService.resolveCatalogue("synasapmob", "nope")).toBe(
      "skills",
    );
    expect(catalogService.resolveCatalogue("synasapmob", null)).toBe("skills");
    expect(catalogService.resolveCatalogue("missing-contributor", null)).toBe(
      null,
    );
  });

  it("archives a collection under its own catalogue", () => {
    const skills = catalogService.findCollection(
      "hub-skills",
      "synasapmob",
      "skills",
    );

    expect(catalogService.collectionArchive(skills!)).toEqual({
      name: "hub-skills.zip",
      url: `${window.location.origin}/catalog/collections/synasapmob/skills/hub-skills.zip`,
    });
  });

  it("keeps every skill and the shared rules in one collection", () => {
    const skills = catalogService.findCollection(
      "hub-skills",
      "synasapmob",
      "skills",
    );

    expect(
      catalogService.collectionFiles(skills!).map((file) => file.path),
    ).toEqual([
      "contributors/synasapmob/skills/hub-skills/frontend-convention/SKILL.md",
      "contributors/synasapmob/skills/hub-skills/mock-data/SKILL.md",
      "contributors/synasapmob/skills/hub-skills/operator-cli/SKILL.md",
      "contributors/synasapmob/skills/hub-skills/rules/AGENTS.md",
    ]);
  });

  it("describes a skill from its text rather than its front matter", () => {
    const skills = catalogService.findCollection(
      "hub-skills",
      "synasapmob",
      "skills",
    );
    const file = catalogService
      .collectionFiles(skills!)
      .find((entry) => entry.path.endsWith("/mock-data/SKILL.md"));

    expect(file?.title).toBe("Mock data");
    expect(file?.description).not.toMatch(/^---|name:/);
  });

  it("describes a script from its own leading comment", () => {
    const link = catalogService.findCollection(
      "link-skills",
      "synasapmob",
      "scripts",
    );
    const script = catalogService
      .collectionFiles(link!)
      .find((file) => file.name === "link.sh");

    expect(script?.title).toBe(
      "link-skills: install the Hub William skills into ~/.agents",
    );
    expect(script?.description).toMatch(/^Copies every skill/);
    expect(script?.description).not.toContain("#");
  });

  it("serves the link script from the published catalogue", () => {
    expect(
      catalogService.linkSkillsScriptUrl("link.sh", "https://hub.example"),
    ).toBe(
      "https://hub.example/catalog/contributors/synasapmob/scripts/link-skills/link.sh",
    );
  });
});

describe("installer URLs", () => {
  it("serves each retained installer from the current published origin", () => {
    expect(catalogService.gatewayInstallerUrl("https://hub.example")).toBe(
      "https://hub.example/gateway.py",
    );
    expect(catalogService.openCodeInstallerUrl("https://hub.example")).toBe(
      "https://hub.example/opencode.py",
    );
    expect(catalogService.ompInstallerUrl("https://hub.example")).toBe(
      "https://hub.example/omp.py",
    );
    expect(catalogService.downloadReelScriptUrl("https://hub.example")).toBe(
      "https://hub.example/download-reel.sh",
    );
  });
});
