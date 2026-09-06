import { readdirSync } from "node:fs";

import type { Config } from "@react-router/dev/config";

/**
 * GitHub Pages serves a project site from `/<repository>/`, so the build has to
 * know its own prefix. Empty locally and on any host that serves from the root.
 */
const basePath = process.env.VITE_BASE_PATH ?? "/";

/**
 * Every workspace with a folder under `contributors/`.
 *
 * Read from disk at build time so a contributor's page is prerendered the
 * moment their pull request merges, without anyone remembering to add it here.
 */
function contributors() {
  try {
    return (
      readdirSync("contributors", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        // `default` is the shared catalogue and is what `/library` already
        // shows; prerendering `/library/default` would publish an empty page.
        .filter((entry) => entry.name !== "default")
        .map((entry) => entry.name)
    );
  } catch {
    return [];
  }
}

/** Only the workspaces that actually have something on that canvas. */
function contributorsWith(kind: string) {
  return contributors().filter((name) => {
    try {
      return readdirSync(`contributors/${name}`).includes(kind);
    } catch {
      return false;
    }
  });
}

export default {
  appDirectory: "src",
  ssr: false,
  basename: basePath,
  /**
   * Every route is written to real HTML at build time.
   *
   * "Static hosting" and "static HTML" are not the same thing, and the
   * difference is the whole SEO question. Without this the server returns one
   * empty shell for every URL and the words only exist after React runs, which
   * Google renders eventually and most other crawlers and link unfurlers never
   * do. With it, each route ships its text in the response — which this app can
   * do precisely because it fetches nothing: the catalogue is Markdown inlined
   * at build time.
   *
   * The list is explicit rather than `true` because `$.tsx` is a catch-all with
   * no enumerable paths.
   */
  prerender: () => [
    "/",
    "/library",
    "/tools",
    "/activities",
    ...contributors().map((name) => `/library/${name}`),
    ...contributorsWith("tools").map((name) => `/tools/${name}`),
  ],
} satisfies Config;
