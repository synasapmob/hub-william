import {
  collectionPresentation,
  collectionRefForPath,
  compareCatalogueIds,
  compareCollectionIds,
  type CollectionRef,
} from "./catalog-collections";
import type {
  CatalogArchive,
  CatalogCollection,
  CatalogCollectionFile,
} from "./catalog-types";

export const GITHUB_REPOSITORY_URL =
  "https://github.com/synasapmob/hub-william";
const PUBLISHED_SITE_ORIGIN = "https://hub-william.site";

const sources = import.meta.glob("../../../../../contributors/*/*/**/*", {
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
      .replace(/^---\n[\s\S]*?\n---\n/, "")
      .replace(/^#\s+.+\n/, "")
      .split(/\n\s*\n/)
      .map((block) => block.trim())
      .find(
        (block) => block && !/^(#{1,6}\s|\||```|[-*]\s|\d+\.\s|`)/.test(block),
      )
      ?.replace(/\s+/g, " ") ?? "Tool documentation."
  );
}

/** A script documents itself in its leading comment: first line the title, first paragraph the description. */
function scriptComment(source: string) {
  const lines: string[] = [];
  for (const line of source.split("\n")) {
    if (line.startsWith("#!")) continue;
    if (!line.startsWith("#")) break;
    lines.push(line.replace(/^#\s?/, ""));
  }

  const [title, ...rest] = lines;
  const description = rest
    .join("\n")
    .trim()
    .split(/\n\s*\n/)[0];
  return {
    title: title || undefined,
    description: description
      ? description.replace(/\s+/g, " ")
      : "Source file.",
  };
}

function describeFile(path: string, source: string): CatalogCollectionFile {
  const name = path.split("/").at(-1) ?? path;
  const { title = name, description } = name.endsWith(".md")
    ? {
        title: /^#\s+(.+)$/m.exec(source)?.[1],
        description: summaryFromSource(source),
      }
    : scriptComment(source);

  return {
    path,
    url: siteAssetUrl(`catalog/${path}`),
    name,
    title,
    description,
    source,
  };
}

const sourceFiles = Object.entries(sources)
  .map(([path, source]) => {
    const normalized = path.replace(/^.*\/contributors\//, "contributors/");
    return { path: normalized, ref: collectionRefForPath(normalized), source };
  })
  .sort((left, right) => left.path.localeCompare(right.path));

const filesByCollection = new Map<
  string,
  { ref: CollectionRef; files: CatalogCollectionFile[] }
>();
for (const { path, ref, source } of sourceFiles) {
  if (!ref) continue;

  const key = `${ref.owner}/${ref.catalogue}/${ref.id}`;
  const collection = filesByCollection.get(key) ?? { ref, files: [] };
  collection.files.push(describeFile(path, source));
  filesByCollection.set(key, collection);
}

const allCollections: CatalogCollection[] = [...filesByCollection.values()]
  .filter(({ files }) => files.some((file) => file.path.endsWith(".md")))
  .map(({ ref, files }) => ({
    id: ref.id,
    catalogue: ref.catalogue,
    contributor: ref.owner === "default" ? null : ref.owner,
    ...collectionPresentation(ref.id),
    files,
  }))
  .sort((left, right) => compareCollectionIds(left.id, right.id));

class CatalogService {
  readonly publishedSiteOrigin = PUBLISHED_SITE_ORIGIN;

  /**
   * List the collections of the shared catalogue, or of one contributor,
   * optionally narrowed to one catalogue folder
   */
  collections(
    contributor: string | null = null,
    catalogue: string | null = null,
  ) {
    return allCollections.filter(
      (collection) =>
        collection.contributor === contributor &&
        (catalogue === null || collection.catalogue === catalogue),
    );
  }

  /**
   * List the catalogue folders the shared catalogue, or one contributor, publishes
   */
  catalogues(contributor: string | null = null) {
    return [
      ...new Set(
        this.collections(contributor).map((collection) => collection.catalogue),
      ),
    ].sort(compareCatalogueIds);
  }

  /**
   * The catalogue to show: the requested one when it exists, else the first
   */
  resolveCatalogue(contributor: string | null, requested: string | null) {
    const available = this.catalogues(contributor);
    return (
      available.find((catalogue) => catalogue === requested?.toLowerCase()) ??
      available[0] ??
      null
    );
  }

  /**
   * Find a collection by id, case-insensitively
   */
  findCollection(
    id: string | null,
    contributor: string | null = null,
    catalogue: string | null = null,
  ) {
    return (
      this.collections(contributor, catalogue).find(
        (collection) => collection.id === id?.toLowerCase(),
      ) ?? null
    );
  }

  /**
   * List the contributors that published at least one collection
   */
  contributors() {
    return [
      ...new Set(
        allCollections
          .map((collection) => collection.contributor)
          .filter((name): name is string => name !== null),
      ),
    ].sort();
  }

  /**
   * Count the Markdown documents of the shared catalogue, or of one
   * contributor, optionally within one catalogue folder
   */
  documentCount(
    contributor: string | null = null,
    catalogue: string | null = null,
  ) {
    return this.collections(contributor, catalogue)
      .flatMap((collection) => collection.files)
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
        `catalog/collections/${collection.contributor ?? "default"}/${collection.catalogue}/${collection.id}.zip`,
      ),
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

  /**
   * The published script that installs, or removes, the shared skills
   */
  linkSkillsScriptUrl(script: "link.sh" | "unlink.sh", origin?: string) {
    return siteAssetUrl(
      `catalog/contributors/synasapmob/scripts/link-skills/${script}`,
      origin,
    );
  }
}

export const catalogService = new CatalogService();
