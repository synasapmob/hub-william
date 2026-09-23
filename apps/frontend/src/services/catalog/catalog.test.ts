import { describe, expect, it } from "vitest";

import catalogService from "@/services/catalog";
import {
  collectionIdForPath,
  collectionPresentation,
  compareCollectionIds,
} from "./catalog-collections";

describe("supported tool catalogue", () => {
  it("publishes the current shared Gateway, OpenCode and OMP tools", () => {
    expect(catalogService.collections().map((tool) => tool.id)).toEqual([
      "gateway",
      "opencode",
      "omp",
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
        fileCount: files.length,
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
  });
});
