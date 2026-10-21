import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "@react-router/dev/config";

import { collectionIdForPath } from "./src/services/catalog/catalog-collections.js";

const basePath = process.env.VITE_BASE_PATH ?? "/";
const contributorsRoot = fileURLToPath(
  new URL("../../contributors", import.meta.url),
);

function hasToolDocuments(directory: string, relativePath: string): boolean {
  if (!existsSync(directory)) return false;
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.name.startsWith(".")) return false;
    const path = `${relativePath}/${entry.name}`;
    return entry.isDirectory()
      ? hasToolDocuments(join(directory, entry.name), path)
      : entry.name.endsWith(".md") && collectionIdForPath(path) !== null;
  });
}

function toolContributors() {
  return readdirSync(contributorsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "default" &&
        !entry.name.startsWith("."),
    )
    .filter((entry) =>
      hasToolDocuments(
        join(contributorsRoot, entry.name, "tools"),
        `contributors/${entry.name}/tools`,
      ),
    )
    .map((entry) => `/tools/${entry.name}`)
    .sort();
}

export default {
  appDirectory: "src",
  ssr: false,
  basename: basePath,
  prerender: () => [
    "/",
    "/tools",
    "/agents",
    "/playground",
    ...toolContributors(),
  ],
} satisfies Config;
