export const TOOL_IDS = [
  "gateway",
  "opencode",
  "omp",
  "download-reel",
  "edge-tts",
  "vosk",
  "skills",
  "link-skills",
  "memory",
] as const;

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
  skills: {
    label: "Skills",
    summary:
      "Frontend conventions, operator CLI, mock-data, Linear task scope and scroll-world skills, plus the shared agent rules. Download the zip, or install it with Link skills.",
  },
  "link-skills": {
    label: "Link skills",
    summary:
      "Install the Skills into ~/.agents with one command, or copy them by hand.",
  },
  memory: {
    label: "Memory",
    summary:
      "See what Claude Code, Codex, Grok and agy remember: the instruction files you write and the lessons they save. Read them in a terminal browser, and move learned memory to the Trash. Nothing leaves your computer.",
  },
};

/** Shared by the browser catalogue and its published file/archive builder. */
export function collectionIdForPath(path: string): string | null {
  const segments = path.replace(/^\/+/, "").split("/");
  if (
    segments[0] !== "contributors" ||
    !segments[1] ||
    segments[2] !== "tools" ||
    !segments[3] ||
    segments.length < 5
  )
    return null;

  const owner = segments[1];
  const id = segments[3];
  if (
    (owner === "default" && (id === "installer" || id === "mcp")) ||
    (owner === "synasapmob" && id === "installer")
  )
    return null;

  return id;
}

const SKILL_ENTRY = "SKILL.md";

/**
 * A skill is listed by its SKILL.md alone: the LICENSE, README and references it
 * bundles stay in the archive and at their published URLs, but are not listed.
 * The archive builder does not call this, so the zip keeps every file.
 */
export function listedCatalogPaths(paths: readonly string[]) {
  const skillFolders = paths
    .filter((path) => path.split("/").at(-1) === SKILL_ENTRY)
    .map((path) => path.slice(0, -SKILL_ENTRY.length));

  return paths.filter(
    (path) =>
      !skillFolders.some(
        (folder) =>
          path.startsWith(folder) && path !== `${folder}${SKILL_ENTRY}`,
      ),
  );
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

export function compareCollectionIds(left: string, right: string) {
  const order: readonly string[] = TOOL_IDS;
  const leftIndex = order.indexOf(left);
  const rightIndex = order.indexOf(right);
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}
