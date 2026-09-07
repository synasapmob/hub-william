import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { strToU8, zipSync } from "fflate";
import type { Plugin } from "vite";

const CATALOG_ROOT = "contributors";
const OUT = "catalog";

/**
 * How deep an archive is worth emitting, counted in path segments.
 *
 * `contributors` is everything, `contributors/<login>` is one workspace,
 * `contributors/<login>/<section>` is one canvas and
 * `contributors/<login>/<section>/<root>` is one root card. Below that a folder
 * is a group inside a root, and a reader wanting `tags/` wants the harness it
 * belongs to — the four levels above are the ones the site actually offers.
 */
const ARCHIVE_DEPTH = 4;

/**
 * A fixed timestamp, so one commit always produces the same bytes.
 *
 * Zip stores an mtime per member and fflate defaults it to now, which would
 * make every build of an unchanged catalogue a different file. 1980 rather than
 * the epoch because that is where the DOS date field zip inherited begins.
 */
const ARCHIVE_MTIME = new Date("1980-01-01T00:00:00Z");

interface CatalogFile {
  /** Repository-relative path, which is also the path inside every archive. */
  path: string;
  contents: string;
}

/**
 * Publishes the catalogue as files an agent can fetch.
 *
 * The site is for a person reading; this is for the thing they are pointing at
 * it. An agent asked to "use the delivery harness" should be able to fetch one
 * URL and get the contract's own bytes, not an HTML page it has to strip tags
 * out of and hope it guessed the right ones.
 *
 * Three artefacts, all static, all under the site's base path:
 *
 * - `/catalog/<path>` — every document, byte for byte as it is on disk.
 * - `/catalog/<folder>.zip` — that folder, for taking a whole root or a whole
 *   catalogue at once.
 * - `/catalog/index.json` — what exists, so nothing has to be crawled or
 *   guessed. Each record carries the URL of its own file or archive.
 *
 * They are emitted rather than copied from `public/` because `public/` ships
 * verbatim and this needs the index built from the same walk that finds the
 * files, so the two cannot disagree.
 *
 * The archives are also what the site's own download buttons point at. A button
 * that zipped the bundled catalogue in the browser instead would be a second
 * implementation of "what is in this folder", and the two drifted: the browser
 * only ever saw the `.md` files the app inlines, so a `registry.yaml` beside a
 * contract and a skill's `references/` were missing from the download and
 * present in the repository.
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

      const files: CatalogFile[] = [];

      // Every file, not only Markdown: a contract that names a `registry.yaml`
      // beside it is describing a file the catalogue has to publish too, and
      // filtering by extension here is how it went missing. Dot-files are the
      // one exclusion, because they configure the folder rather than belong to
      // it.
      const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
          if (name.startsWith(".")) continue;

          const path = join(dir, name);

          if (statSync(path).isDirectory()) {
            walk(path);
          } else {
            files.push({ path, contents: readFileSync(path, "utf8") });
          }
        }
      };

      walk(CATALOG_ROOT);

      const base = process.env.VITE_BASE_PATH ?? "/";
      const url = (path: string) => `${base}${OUT}/${path}`;

      for (const file of files) {
        this.emitFile({
          type: "asset",
          fileName: `${OUT}/${file.path}`,
          source: file.contents,
        });
      }

      // Every folder shallow enough to be worth taking whole, discovered from
      // the files rather than listed, so a new contributor gets their archives
      // by opening a pull request and nothing else.
      const folders = new Set<string>();

      for (const file of files) {
        const segments = file.path.split("/").slice(0, -1);

        for (
          let depth = 1;
          depth <= Math.min(segments.length, ARCHIVE_DEPTH);
          depth++
        ) {
          folders.add(segments.slice(0, depth).join("/"));
        }
      }

      const archives = [...folders].sort().map((folder) => {
        const members = files.filter((file) =>
          file.path.startsWith(`${folder}/`),
        );
        const entries: Record<string, Uint8Array> = {};

        for (const member of members) {
          entries[member.path] = strToU8(member.contents);
        }

        // Members keep their repository path, so `unzip -d ~/.hub-william`
        // puts every file exactly where the harness dispatcher looks for it.
        // An archive flattened to bare filenames would be a pile of Markdown:
        // a contract is loaded by where it sits.
        const zip = zipSync(entries, { level: 9, mtime: ARCHIVE_MTIME });

        this.emitFile({
          type: "asset",
          fileName: `${OUT}/${folder}.zip`,
          source: zip,
        });

        return {
          id: folder,
          path: `${folder}.zip`,
          url: url(`${folder}.zip`),
          bytes: zip.byteLength,
          files: members.length,
        };
      });

      this.emitFile({
        type: "asset",
        fileName: `${OUT}/index.json`,
        source: `${JSON.stringify(
          {
            description:
              "Every document in the Hub William catalogue. Fetch `url` for the file exactly as it is in the repository, or an archive's `url` for a whole folder — its members keep these same paths, so unzipping into a checkout puts them where an agent reads them.",
            repository: "https://github.com/synasapmob/hub-william",
            count: files.length,
            documents: files.map((file) => ({
              id: file.path.replace(/\.md$/, ""),
              path: file.path,
              url: url(file.path),
              bytes: Buffer.byteLength(file.contents),
            })),
            archives,
          },
          null,
          2,
        )}\n`,
      });
    },
  };
}
