import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Config } from "@react-router/dev/config";

import { collectionRefForPath } from "./src/services/catalog/catalog-collections.js";

const basePath = process.env.VITE_BASE_PATH ?? "/";
const contributorsRoot = fileURLToPath(
  new URL("../../contributors", import.meta.url),
);

function hasCatalogueDocuments(
  directory: string,
  relativePath: string,
): boolean {
  return readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.name.startsWith(".")) return false;
    const path = `${relativePath}/${entry.name}`;
    return entry.isDirectory()
      ? hasCatalogueDocuments(join(directory, entry.name), path)
      : entry.name.endsWith(".md") && collectionRefForPath(path) !== null;
  });
}

function catalogueContributors() {
  return readdirSync(contributorsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name !== "default" &&
        !entry.name.startsWith("."),
    )
    .filter((entry) =>
      hasCatalogueDocuments(
        join(contributorsRoot, entry.name),
        `contributors/${entry.name}`,
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
    ...catalogueContributors(),
  ],
} satisfies Config;
