export const TOOL_IDS = ["gateway", "opencode", "omp"] as const;

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
