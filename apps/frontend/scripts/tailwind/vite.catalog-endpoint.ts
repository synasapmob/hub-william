import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import type { Plugin } from "vite";

import { collectionIdForPath } from "../../src/services/catalog/catalog-collections.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ARCHIVE_MTIME = new Date("1980-01-01T00:00:00Z");

interface CatalogFile {
  path: string;
  contents: string;
}

/** Publish tool sources and per-contributor archives with unchanged bytes. */
export function catalogEndpoint(): Plugin {
  return {
    name: "hub-william-catalog-endpoint",
    apply: "build",
    generateBundle() {
      if (this.environment.name === "ssr") return;

      const base = process.env.VITE_BASE_PATH ?? "/";
      const files: CatalogFile[] = [];
      const url = (path: string) => `${base}catalog/${path}`;
      const grouped = new Map<string, CatalogFile[]>();
      const walk = (directory: string) => {
        for (const name of readdirSync(directory).sort()) {
          if (name.startsWith(".")) continue;
          const path = join(directory, name);
          if (statSync(path).isDirectory()) {
            walk(path);
          } else {
            const normalized = relative(REPOSITORY_ROOT, path)
              .split(sep)
              .join("/");
            const id = collectionIdForPath(normalized);
            if (!id) continue;
            const key = `${normalized.split("/")[1]}/tools/${id}`;
            const members = grouped.get(key) ?? [];
            members.push({
              path: normalized,
              contents: readFileSync(path, "utf8"),
            });
            grouped.set(key, members);
          }
        }
      };
      const contributorsRoot = join(REPOSITORY_ROOT, "contributors");
      for (const owner of readdirSync(contributorsRoot, {
        withFileTypes: true,
      }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
        const directory = join(contributorsRoot, owner.name, "tools");
        if (existsSync(directory)) walk(directory);
      }
      const collections = [...grouped.entries()].map(([id, members]) => {
        files.push(...members);

        const entries = Object.fromEntries(
          members.map((file) => [file.path, strToU8(file.contents)]),
        );
        const zip = zipSync(entries, { level: 9, mtime: ARCHIVE_MTIME });
        const path = `collections/${id}.zip`;
        this.emitFile({
          type: "asset",
          fileName: `catalog/${path}`,
          source: zip,
        });
        return {
          id,
          path,
          url: url(path),
          bytes: zip.byteLength,
          files: members.length,
        };
      });

      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `catalog/${file.path}`,
          source: file.contents,
        });
      }

      this.emitFile({
        type: "asset",
        fileName: "catalog/index.json",
        source: `${JSON.stringify(
          {
            description:
              "Shared and contributed tool documentation and downloads.",
            repository: "https://github.com/synasapmob/hub-william",
            count: files.length,
            documents: files.map((file) => ({
              id: file.path.replace(/\.md$/, ""),
              path: file.path,
              url: url(file.path),
              bytes: Buffer.byteLength(file.contents),
            })),
            collections,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
