import { describe, expect, it } from "vitest";

import { catalogService } from "./catalog-service";
import {
  collectionIdForPath,
  collectionPresentation,
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
    const id = collectionIdForPath(
      "contributors/alice/tools/review-helper/README.md",
    );
    expect(id).toBe("review-helper");
    expect(collectionPresentation(id!)).toMatchObject({
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

  it("excludes workflow and retired tool sources from the product catalogue", () => {
    expect(
      collectionIdForPath("contributors/default/libraries/harness/AGENTS.md"),
    ).toBeNull();
    expect(
      collectionIdForPath(
        "contributors/default/tools/installer/machine-installer.md",
      ),
    ).toBeNull();
    expect(
      collectionIdForPath("contributors/default/tools/mcp/mcp-servers.md"),
    ).toBeNull();
    expect(
      collectionIdForPath(
        "contributors/synasapmob/tools/installer/codex-workflow.md",
      ),
    ).toBeNull();
    expect(
      collectionIdForPath("contributors/default/tools/gateway/gateway.md"),
    ).toBe("gateway");
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
        expect(collectionIdForPath(file.path)).toBe(collection.id);
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

describe("contributed skills", () => {
  it("shows a contributor's skills and link script as plain tool cards", () => {
    expect(catalogService.contributors()).toContain("synasapmob");
    expect(
      catalogService.collections("synasapmob").map((tool) => tool.id),
    ).toEqual(["skills", "link-skills"]);
    expect(catalogService.findCollection("skills")).toBeNull();
  });

  it("keeps every skill and the shared rules in one archive", () => {
    const skills = catalogService.findCollection("skills", "synasapmob");

    expect(catalogService.collectionArchive(skills!)).toEqual({
      name: "skills.zip",
      url: `${window.location.origin}/catalog/collections/synasapmob/tools/skills.zip`,
    });
    expect(
      catalogService
        .collectionFiles(skills!)
        .filter((file) => ["SKILL.md", "AGENTS.md"].includes(file.name))
        .map((file) => file.path),
    ).toEqual([
      "contributors/synasapmob/tools/skills/frontend-convention/SKILL.md",
      "contributors/synasapmob/tools/skills/mock-data/SKILL.md",
      "contributors/synasapmob/tools/skills/operator-cli/SKILL.md",
      "contributors/synasapmob/tools/skills/rules/AGENTS.md",
      "contributors/synasapmob/tools/skills/scroll-world/SKILL.md",
    ]);
    expect(
      catalogService
        .collectionFiles(skills!)
        .some((file) => file.name === "LICENSE"),
    ).toBe(true);
  });

  it("describes a skill from its text rather than its front matter", () => {
    const skills = catalogService.findCollection("skills", "synasapmob");
    const file = catalogService
      .collectionFiles(skills!)
      .find((entry) => entry.path.endsWith("/mock-data/SKILL.md"));

    expect(file?.title).toBe("Mock data");
    expect(file?.description).not.toMatch(/^---|name:/);
  });

  it("shows a tool made of two scripts and no Markdown as a card", () => {
    const link = catalogService.findCollection("link-skills", "synasapmob");

    expect(
      catalogService.collectionFiles(link!).map((file) => file.name),
    ).toEqual(["link.sh", "unlink.sh"]);
  });

  it("describes a script from its own leading comment", () => {
    const link = catalogService.findCollection("link-skills", "synasapmob");
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
      "https://hub.example/catalog/contributors/synasapmob/tools/link-skills/link.sh",
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
