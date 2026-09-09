/**
 * The catalogue's presentation taxonomy.
 *
 * Files keep the paths the agents read. The UI groups those files by the job
 * they do, which is why a GitHub workflow tag can sit beside the GitHub
 * supporting contracts without either source moving on disk.
 */

export type CatalogCollectionSection = "library" | "tools";

export interface CatalogCollectionSource {
  path: string;
  section: CatalogCollectionSection;
  category: string;
  group: string;
}

export interface CatalogCollectionPresentation {
  label: string;
  summary: string;
}

const GITHUB_TAGS = new Set(["draft", "merge", "mergeable", "rebase"]);

const COLLECTION_PRESENTATION: Record<string, CatalogCollectionPresentation> = {
  documents: {
    label: "Documents",
    summary:
      "Install the catalogue globally or add its managed rules to one project.",
  },
  evidences: {
    label: "Evidences",
    summary:
      "Contracts for recording approaches, test runs and the evidence behind a handoff.",
  },
  github: {
    label: "GitHub",
    summary:
      "Git, pull request and GitHub contracts, including merge, mergeability, draft and rebase workflows.",
  },
  mcp: {
    label: "MCP",
    summary:
      "Register the supported MCP servers across the agents installed on this machine.",
  },
  skills: {
    label: "Skills",
    summary:
      "Focused capabilities loaded when a task matches, with their supporting references kept together.",
  },
  tags: {
    label: "Tags",
    summary:
      "Prompt tokens that select an execution mode or modify how a task is handled.",
  },
  templates: {
    label: "Templates",
    summary:
      "Reusable shapes for issues, pull requests, evidence and implementation histories.",
  },
};

const COLLECTION_ORDER: Record<CatalogCollectionSection, string[]> = {
  library: ["evidences", "github", "tags", "skills", "templates"],
  tools: ["documents", "mcp"],
};

function fileStem(path: string) {
  return (path.split("/").at(-1) ?? path).replace(/\.[^.]+$/, "");
}

export function collectionIdForSource(source: CatalogCollectionSource) {
  if (source.section === "tools") {
    return source.category === "installer" ? "documents" : source.category;
  }

  if (source.group === "evidence") return "evidences";
  if (source.group === "github") return "github";

  if (source.group === "tags" && GITHUB_TAGS.has(fileStem(source.path))) {
    return "github";
  }

  if (source.group === "tags") return "tags";
  if (source.category === "skills") return "skills";
  if (source.category === "templates") return "templates";

  return source.group || source.category;
}

/** Classify every published file, including skill references and YAML assets. */
export function collectionIdForPath(path: string) {
  const segments = path.replace(/^\/+/, "").split("/");

  if (segments[0] !== "contributors" || segments.length < 4) return null;

  const sectionFolder = segments[2];
  const section: CatalogCollectionSection | null =
    sectionFolder === "libraries"
      ? "library"
      : sectionFolder === "tools"
        ? "tools"
        : null;

  if (!section) return null;

  const root = segments[3] ?? "";
  const belowRoot = segments.slice(4);

  // The dispatcher is what makes tag files reachable after installation, so
  // it belongs in the Tags download instead of becoming an invisible Harness
  // archive with no corresponding UI node.
  if (
    section === "library" &&
    root === "harness" &&
    belowRoot[0] === "AGENTS.md"
  ) {
    return "tags";
  }

  const category = root === "hooks" ? "harness" : root;
  let group = root;

  if (category === "skills" || category === "templates") {
    group = category;
  } else if (belowRoot.length > 1) {
    group = belowRoot[0] ?? root;
  }

  return collectionIdForSource({ path, section, category, group });
}

export function collectionPresentation(id: string) {
  const known = COLLECTION_PRESENTATION[id];

  if (known) return known;

  const words = id.replace(/[-_]/g, " ");
  const label = words.charAt(0).toUpperCase() + words.slice(1);

  return {
    label,
    summary: `Documents collected around ${label.toLowerCase()}.`,
  };
}

export function compareCollectionIds(
  section: CatalogCollectionSection,
  left: string,
  right: string,
) {
  const order = COLLECTION_ORDER[section];
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);

  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;

    return leftIndex - rightIndex;
  }

  return left.localeCompare(right);
}
