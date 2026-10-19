import {
  collectionIdForPath,
  collectionPresentation,
  compareCollectionIds,
} from "./catalog-collections";
import type {
  CatalogArchive,
  CatalogCollection,
  CatalogCollectionFile,
} from "./catalog-types";

export const GITHUB_REPOSITORY_URL =
  "https://github.com/synasapmob/hub-william";
const PUBLISHED_SITE_ORIGIN = "https://hub-william.site";

const sources = import.meta.glob("../../../../../contributors/*/tools/**/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function siteAssetUrl(path: string, requestedOrigin?: string) {
  const origin =
    requestedOrigin ??
    (typeof window === "undefined"
      ? PUBLISHED_SITE_ORIGIN
      : window.location.origin);
  return `${origin}${import.meta.env.BASE_URL}${path.replace(/^\/+/, "")}`;
}

function summaryFromSource(source: string) {
  return (
    source
      .replace(/^#\s+.+\n/, "")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find(
        (block) => block && !/^(#{1,6}\s|\||```|[-*]\s|\d+\.\s|`)/.test(block),
      )
      ?.replace(/\s+/g, " ") ?? "Tool documentation."
  );
}

const toolFiles: CatalogCollectionFile[] = Object.entries(sources)
  .filter(
    ([path]) =>
      collectionIdForPath(
        path.replace(/^.*\/contributors\//, "contributors/"),
      ) !== null,
  )
  .map(([path, source]) => {
    const normalized = path.replace(/^.*\/contributors\//, "contributors/");
    const name = normalized.split("/").at(-1) ?? normalized;
    return {
      path: normalized,
      url: siteAssetUrl(`catalog/${normalized}`),
      name,
      title: /^#\s+(.+)$/m.exec(source)?.[1] ?? name,
      description: summaryFromSource(source),
      source,
    };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const collectionFilesByOwner = new Map<string, CatalogCollectionFile[]>();
for (const file of toolFiles) {
  const key = `${file.path.split("/")[1]}/${collectionIdForPath(file.path)}`;
  const files = collectionFilesByOwner.get(key) ?? [];
  files.push(file);
  collectionFilesByOwner.set(key, files);
}

const tools: CatalogCollection[] = [...collectionFilesByOwner.entries()]
  .filter(([, files]) => files.some((file) => file.path.endsWith(".md")))
  .map(([key, files]) => {
    const [owner, id] = key.split("/");
    return {
      id,
      contributor: owner === "default" ? null : owner,
      ...collectionPresentation(id),
      files,
    };
  })
  .sort((left, right) => compareCollectionIds(left.id, right.id));

class CatalogService {
  readonly publishedSiteOrigin = PUBLISHED_SITE_ORIGIN;

  /**
   * List the tool collections of the shared catalogue, or of one contributor
   */
  collections(contributor: string | null = null) {
    return tools.filter((tool) => tool.contributor === contributor);
  }

  /**
   * Find a collection by id, case-insensitively
   */
  findCollection(id: string | null, contributor: string | null = null) {
    return (
      this.collections(contributor).find(
        (tool) => tool.id === id?.toLowerCase(),
      ) ?? null
    );
  }

  /**
   * List the contributors that published at least one collection
   */
  contributors() {
    return [
      ...new Set(
        tools
          .map((tool) => tool.contributor)
          .filter((name): name is string => name !== null),
      ),
    ].sort();
  }

  /**
   * Count the Markdown documents of the shared catalogue, or of one contributor
   */
  documentCount(contributor: string | null = null) {
    return this.collections(contributor)
      .flatMap((tool) => tool.files)
      .filter((file) => file.path.endsWith(".md")).length;
  }

  /**
   * Whether a collection's label, summary or files mention the query
   */
  matchesCollectionQuery(collection: CatalogCollection, query: string) {
    const term = query.trim().toLowerCase();
    return [
      collection.label,
      collection.summary,
      ...collection.files.flatMap((file) => [
        file.path,
        file.title,
        file.description,
      ]),
    ].some((value) => value.toLowerCase().includes(term));
  }

  /**
   * List the files of a collection
   */
  collectionFiles(collection: CatalogCollection) {
    return collection.files;
  }

  /**
   * Describe the downloadable archive of a collection
   */
  collectionArchive(collection: CatalogCollection): CatalogArchive {
    return {
      name: `${collection.id}.zip`,
      url: siteAssetUrl(
        `catalog/collections/${collection.contributor ?? "default"}/tools/${collection.id}.zip`,
      ),
      fileCount: collection.files.length,
    };
  }

  gatewayInstallerUrl(origin?: string) {
    return siteAssetUrl("gateway.py", origin);
  }

  openCodeInstallerUrl(origin?: string) {
    return siteAssetUrl("opencode.py", origin);
  }

  ompInstallerUrl(origin?: string) {
    return siteAssetUrl("omp.py", origin);
  }

  downloadReelScriptUrl(origin?: string) {
    return siteAssetUrl("download-reel.sh", origin);
  }
}

export const catalogService = new CatalogService();
