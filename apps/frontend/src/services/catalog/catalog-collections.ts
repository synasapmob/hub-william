export const TOOL_IDS = [
  "gateway",
  "opencode",
  "omp",
  "download-reel",
  "edge-tts",
  "vosk",
] as const;

/** The folders a contributor can publish, in display order; others follow A–Z. */
export const CATALOGUE_IDS = ["tools", "skills", "scripts"] as const;

interface CatalogCollectionPresentation {
  label: string;
  summary: string;
}

const COLLECTION_PRESENTATION: Record<string, CatalogCollectionPresentation> = {
  gateway: {
    label: "Gateway",
    summary:
      "Point Codex, Claude Code, Antigravity and Grok at Hub William with one installer, or paste the config yourself.",
  },
  opencode: {
    label: "OpenCode",
    summary:
      "Install every live Hub provider and model into OpenCode with one revocable gateway key.",
  },
  omp: {
    label: "OMP",
    summary:
      "Install every live Hub provider and model into OMP with one revocable gateway key.",
  },
  "download-reel": {
    label: "DOWNLOAD REEL",
    summary:
      "Download TikTok, Facebook and X videos with sound using one local script.",
  },
  "edge-tts": {
    label: "TEXT TO AUDIO",
    summary:
      "Convert text into natural speech audio using Microsoft Edge Neural voices across regional accents.",
  },
  vosk: {
    label: "AUDIO TO TEXT",
    summary:
      "Transcribe your voice or an audio file into text in your browser with Vosk speech recognition. Nothing is uploaded.",
  },
  "frontend-convention": {
    label: "Frontend conventions",
    summary:
      "Review criteria for React, TypeScript and Tailwind: blank-line blocking, conditionals, props, class composition and layout primitives.",
  },
  "mock-data": {
    label: "Mock data",
    summary:
      "Write mock data inline in the file that consumes it, shaped like the real data, unless the project has its own pattern.",
  },
  "operator-cli": {
    label: "Operator CLI",
    summary:
      "Use git and gh for repository work, and pick the right browser tool for verification.",
  },
  rules: {
    label: "Agent rules",
    summary:
      "The rules every agent follows in every session, such as never saving memory on its own initiative.",
  },
  "link-skills": {
    label: "Link skills",
    summary:
      "Install these skills and rules into ~/.agents with one command, or copy them by hand.",
  },
};

const CATALOGUE_LABELS: Record<string, string> = {
  tools: "Tools",
  skills: "Skills",
  scripts: "Scripts",
};

export interface CollectionRef {
  owner: string;
  catalogue: string;
  id: string;
}

/**
 * Where a file belongs: `contributors/<owner>/<catalogue>/<item>/<file>`.
 *
 * Shared by the browser catalogue and its published file/archive builder.
 */
export function collectionRefForPath(path: string): CollectionRef | null {
  const [root, owner, catalogue, id, ...file] = path
    .replace(/^\/+/, "")
    .split("/");
  if (root !== "contributors" || !owner || !catalogue || !id || !file.length)
    return null;

  const retiredTool =
    catalogue === "tools" &&
    ((owner === "default" && (id === "installer" || id === "mcp")) ||
      (owner === "synasapmob" && id === "installer"));
  if (retiredTool) return null;

  return { owner, catalogue, id };
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

export function catalogueLabel(catalogue: string) {
  return (
    CATALOGUE_LABELS[catalogue] ??
    catalogue.charAt(0).toUpperCase() + catalogue.slice(1)
  );
}

function compareInOrder(order: readonly string[], left: string, right: string) {
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}

export function compareCollectionIds(left: string, right: string) {
  return compareInOrder(TOOL_IDS, left, right);
}

export function compareCatalogueIds(left: string, right: string) {
  return compareInOrder(CATALOGUE_IDS, left, right);
}
