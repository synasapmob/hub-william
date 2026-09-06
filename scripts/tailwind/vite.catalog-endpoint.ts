import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { Plugin } from "vite";

const CATALOG_ROOT = "contributors";
const OUT = "catalog";

/**
 * Publishes the catalogue as files an agent can fetch.
 *
 * The site is for a person reading; this is for the thing they are pointing at
 * it. An agent asked to "use the delivery harness" should be able to fetch one
 * URL and get the contract's own bytes, not an HTML page it has to strip tags
 * out of and hope it guessed the right ones.
 *
 * Two artefacts, both static, both under the site's base path:
 *
 * - `/catalog/<path>.md` — every document, byte for byte as it is on disk.
 * - `/catalog/index.json` — what exists, so nothing has to be crawled or
 *   guessed. Each record carries the URL of its own Markdown.
 *
 * They are emitted rather than copied from `public/` because `public/` ships
 * verbatim and this needs the index built from the same walk that finds the
 * files, so the two cannot disagree.
 */
export function catalogEndpoint(): Plugin {
  return {
    name: "hub-william-catalog-endpoint",
    apply: "build",

    generateBundle() {
      // The build runs once per environment; emitting from the server pass too
      // would duplicate every document into the server bundle, where nothing
      // can fetch it.
      if (this.environment.name === "ssr") return;

      const documents: string[] = [];

      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);

          if (statSync(path).isDirectory()) {
            walk(path);
          } else if (name.endsWith(".md")) {
            documents.push(path);
          }
        }
      };

      walk(CATALOG_ROOT);
      documents.sort();

      const base = process.env.VITE_BASE_PATH ?? "/";
      const index = documents.map((path) => {
        const id = path.replace(/\.md$/, "");
        const source = readFileSync(path, "utf8");

        this.emitFile({
          type: "asset",
          fileName: `${OUT}/${id}.md`,
          source,
        });

        return {
          id,
          path: `${id}.md`,
          url: `${base}${OUT}/${id}.md`,
          bytes: Buffer.byteLength(source),
        };
      });

      this.emitFile({
        type: "asset",
        fileName: `${OUT}/index.json`,
        source: `${JSON.stringify(
          {
            description:
              "Every document in the Hub William catalogue. Fetch `url` for the file exactly as it is in the repository.",
            repository: "https://github.com/synasapmob/hub-william",
            count: index.length,
            documents: index,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
