import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { strToU8, zipSync } from "fflate";
import type { Plugin } from "vite";

import { collectionRefForPath } from "../../src/services/catalog/catalog-collections.js";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const ARCHIVE_MTIME = new Date("1980-01-01T00:00:00Z");

interface CatalogFile {
  path: string;
  contents: string;
}

function collect(
  groups: Map<string, CatalogFile[]>,
  key: string,
  file: CatalogFile,
) {
  const members = groups.get(key) ?? [];
  members.push(file);
  groups.set(key, members);
}

/** Publish catalogue sources, plus per-item and per-catalogue archives, with unchanged bytes. */
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
      const bundled = new Map<string, CatalogFile[]>();
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
            const ref = collectionRefForPath(normalized);
            if (!ref) continue;
            const file = {
              path: normalized,
              contents: readFileSync(path, "utf8"),
            };
            collect(grouped, `${ref.owner}/${ref.catalogue}/${ref.id}`, file);
            collect(bundled, `${ref.owner}/${ref.catalogue}`, file);
          }
        }
      };
      const contributorsRoot = join(REPOSITORY_ROOT, "contributors");
      for (const owner of readdirSync(contributorsRoot, {
        withFileTypes: true,
      }).sort((left, right) => left.name.localeCompare(right.name))) {
        if (!owner.isDirectory() || owner.name.startsWith(".")) continue;
        walk(join(contributorsRoot, owner.name));
      }
      const archive = (id: string, members: CatalogFile[]) => {
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
      };
      const collections = [...grouped.entries()].map(([id, members]) => {
        files.push(...members);
        return archive(id, members);
      });
      const catalogues = [...bundled.entries()].map(([id, members]) =>
        archive(id, members),
      );

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
              "Shared and contributed tool, skill and script documentation and downloads.",
            repository: "https://github.com/synasapmob/hub-william",
            count: files.length,
            documents: files.map((file) => ({
              id: file.path.replace(/\.md$/, ""),
              path: file.path,
              url: url(file.path),
              bytes: Buffer.byteLength(file.contents),
            })),
            collections,
            catalogues,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
