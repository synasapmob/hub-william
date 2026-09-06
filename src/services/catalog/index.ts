/**
 * The catalogue, read straight out of `contributors/`.
 *
 * There is no backend and there is not going to be one. The contracts, skills
 * and templates the workspace publishes are already Markdown files in this
 * repository, so the catalogue is those files: Vite inlines them at build time
 * and a contribution is a pull request that adds one more. That is the whole
 * storage design — a reviewer, a diff, and a deploy.
 *
 * Nothing here edits the source files. They are live machine contracts, read by
 * agents as instructions, and adding front matter to make a catalogue prettier
 * would be editing an instruction to suit a listing page. Metadata is derived
 * from the path and the document's own first heading and paragraph instead, and
 * front matter is honoured only where the format already has it — the skills,
 * which carry `name` and `description` because Claude Code requires them.
 *
 * Shape follows the folders, at both levels. The three categories are the three
 * folders the catalogue actually has, and a group is whatever folder a document
 * sits in below that. Renaming `tags/` to `labels/` renames the heading and
 * nothing else; the alternative was a table in here deciding, by filename, what
 * a document is about, which drifts from the tree the moment somebody adds a
 * file it has never heard of.
 */

/**
 * Which canvas a document belongs to.
 *
 * `/library` publishes the contracts themselves; `/tools` publishes how to get
 * them onto a machine. They are two canvases rather than two tabs because a
 * reader wanting to install has no use for 25 contracts, and a reader comparing
 * contracts has no use for install steps.
 */
export type CatalogSection = "library" | "tools";

/**
 * A root card, which is a top-level folder.
 *
 * Open, like `CatalogGroup`, and for the same reason: `tools/` gains a root by
 * gaining a directory, and nothing may hold a list of which names are allowed.
 */
export type CatalogCategory = string;

/**
 * A folder name, so an open set rather than a union.
 *
 * Nothing may switch on the members of this type. A contributor invents group
 * names by making directories, and code that enumerates them would be back to
 * deciding which names are allowed to exist.
 */
export type CatalogGroup = string;

export interface CatalogEntry {
  /**
   * Whose workspace publishes this, or null for the shared catalogue.
   *
   * A workspace-specific contract — one that maps somebody's own repositories to
   * their own servers, or drives their own local stack — is theirs, not
   * everyone's. It is published under their name and kept out of the default
   * catalogue, which is what makes the default one worth reading.
   */
  contributor: string | null;
  /** Repository-relative path, and the identity a link can be built from. */
  id: string;
  /**
   * The identity a URL carries.
   *
   * The path with its slashes flattened, because `URLSearchParams` percent-
   * encodes a slash and `node=harness%2Fgithub%2Freport-summary` is not a link
   * anyone reads back. The whole path stays in it: four different documents are
   * called `report-summary`, so a last-segment slug would collide.
   */
  slug: string;
  name: string;
  description: string;
  section: CatalogSection;
  category: CatalogCategory;
  /** The folder this sits in below its category folder. */
  group: CatalogGroup;
  /** The document itself, front matter and its own title stripped, for display. */
  body: string;
  /**
   * The file exactly as it sits on disk.
   *
   * `body` is for rendering, so it has lost the front matter and the `# Title`
   * the sheet prints itself. Anything handed back to a machine — a copy button,
   * a download — has to be this instead, or what lands on the reader's disk is
   * not the contract they were looking at.
   */
  source: string;
  /** Rough reading weight, shown so a reader can tell a page from a paragraph. */
  lineCount: number;
}

/**
 * Every document belongs to somebody, including the shared ones.
 *
 * `contributors/default/` is the catalogue this project ships; a person's own
 * workspace sits beside it under their GitHub login, in the same shape. One
 * tree, one rule, and "shared" stops being a special case in the filesystem —
 * it is only a special case in the reading, where `default` means "no
 * contributor" so `/library` keeps showing it.
 */
const CATALOG_ROOT = "contributors";
const SHARED_OWNER = "default";

/**
 * The public repository the catalogue is contributed to.
 *
 * Deliberately not the private mirror this checkout pushes to: a "Contribute"
 * link is only worth showing if a stranger can open it.
 */
export const GITHUB_REPOSITORY_URL =
  "https://github.com/synasapmob/hub-william";

/** The library's roots, in the order the canvas draws them. */
const LIBRARY_ROOTS = ["harness", "skills", "templates"];

/**
 * A folder that is a root of another folder.
 *
 * `hooks` is not a folder the shared catalogue has, but `contrib/<login>/hooks/`
 * exists on disk. Dropping it would take those documents off the canvas in
 * silence, which is worse than one alias; the folder name still survives as the
 * group heading, so a reader sees where the document really lives.
 */
const ROOT_ALIASES: Record<string, string> = { hooks: "harness" };

/**
 * How a folder name is printed, for the few where casing is not mechanical.
 *
 * This decides presentation only. An unrecognised folder still renders, still
 * groups, and still gets a colour — it just gets title case. That is the
 * difference between this and the table it replaced, which decided whether a
 * document was classified at all and quietly mislabelled anything it did not
 * know.
 */
const GROUP_LABEL_CASING: Record<string, string> = {
  github: "GitHub",
  mcp: "MCP",
  // The folder is singular because it holds one harness's parts; the card
  // names the set.
  harness: "Harnesses",
};

export function groupLabel(group: CatalogGroup) {
  const known = GROUP_LABEL_CASING[group];

  if (known) return known;

  const words = group.replace(/[-_]/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * What a root card says about itself.
 *
 * A lookup rather than a required field, because a folder is allowed to exist
 * before anyone has written a sentence about it — the card then shows its name
 * and its count, which is still true.
 */
const ROOT_SUMMARIES: Record<string, string> = {
  harness:
    "Execution modes and the contracts around them. A tag the operator types, or a supporting contract that fires before a write leaves the checkout, whether or not a tag asked for it.",
  skills:
    "Cognitive capabilities loaded on demand. A skill carries the rules for one discipline and the reading order that makes them apply.",
  templates:
    "The shapes the workspace writes into: approach histories, test evidence, pull requests and issues, so two agents produce the same artefact.",
  installer:
    "Getting the catalogue onto a machine, and what happens to it afterwards. The program is in this repository so you can read it before you run it.",
  mcp: "Registering Model Context Protocol servers across the agents that use them, in each agent's own configuration format.",
};

export function rootSummary(root: CatalogCategory) {
  return ROOT_SUMMARIES[root] ?? "";
}

/** A root's name as the canvas prints it. */
export function rootLabel(root: CatalogCategory) {
  return groupLabel(root).toUpperCase();
}

/** Every Markdown file under the catalogue, inlined at build time. */
const sources = import.meta.glob("/contributors/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

interface CatalogPlacement {
  section: CatalogSection;
  category: CatalogCategory;
  group: CatalogGroup;
  contributor: string | null;
}

/** The folder a section is called on disk. */
const SECTION_FOLDERS: Record<string, CatalogSection> = {
  libraries: "library",
  tools: "tools",
};

/**
 * Where a source file lands, decided entirely by where it already lives.
 *
 * One shape reads the whole catalogue:
 *
 *     machine/system/<section>/<root>/[<group>/]<file>.md
 *     machine/contributors/<login>/<section>/<root>/[<group>/]<file>.md
 *
 * The owner is stripped first, so a contributor's tree and the shared one are
 * read by the same rule rather than by two that can drift apart — and because
 * the two trees are the same shape, there is no longer a section that has to be
 * read one level deeper than the others.
 *
 * Returns null for anything the catalogue does not publish: a skill's
 * `references/`, which are pages of one skill rather than entries beside it,
 * and a root's own `AGENTS.md`, which is the dispatcher that points at
 * everything below it rather than one more thing to point at.
 */
function placeSource(path: string): CatalogPlacement | null {
  const segments = path.replace(/^\//, "").split("/");

  if (segments[0] !== CATALOG_ROOT) return null;

  const owner = segments[1] ?? "";

  if (!owner) return null;

  // `default` is the shared catalogue, and reads as having no contributor so
  // `/library` shows it and `/library/<login>` shows only theirs.
  const contributor = owner === SHARED_OWNER ? null : owner;
  const rest = segments.slice(2);

  const section = SECTION_FOLDERS[rest[0] ?? ""];
  const root = rest[1] ?? "";

  if (!section || !root) return null;

  const category = ROOT_ALIASES[root] ?? root;
  const below = rest.slice(2);

  if (below.length === 0) return null;

  // `skills/<name>/SKILL.md`: the folder carries the skill's own name, so it is
  // the entry rather than a group, and everything beside the manifest is one of
  // its pages.
  if (category === "skills") {
    if (below.length !== 2 || below.at(-1) !== "SKILL.md") return null;

    return { section, category, group: root, contributor };
  }

  if (below.length === 1 && below[0] === "AGENTS.md") return null;

  return {
    section,
    category,
    group: below.length === 1 ? root : (below[0] ?? root),
    contributor,
  };
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

interface ParsedDocument {
  frontMatter: Record<string, string>;
  body: string;
}

/**
 * Split front matter from body.
 *
 * Deliberately not a YAML parser: the only front matter in the catalogue is a
 * skill's flat `name` and `description`, and pulling in a parser to read two
 * scalars would be a dependency in exchange for nothing.
 */
function parseDocument(raw: string): ParsedDocument {
  const match = FRONT_MATTER.exec(raw);

  if (!match) return { frontMatter: {}, body: raw.trim() };

  const frontMatter: Record<string, string> = {};

  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");

    if (separator === -1) continue;

    frontMatter[line.slice(0, separator).trim()] = line
      .slice(separator + 1)
      .trim();
  }

  return { frontMatter, body: raw.slice(match[0].length).trim() };
}

/** The document's own title, with the punctuation a tag heading uses stripped off. */
function titleFromBody(body: string, slug: string) {
  const heading = /^#\s+(.+)$/m.exec(body)?.[1];

  if (heading) return heading.replace(/[`[\]]/g, "").trim();

  const words = slug.replace(/[-_]/g, " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The first real paragraph, which is where these documents state their purpose.
 *
 * Headings, tables, code fences and lists are skipped rather than truncated: a
 * card showing "Append-only date grouping" as a description would be quoting
 * the document's second section title and calling it a summary.
 */
function summaryFromBody(body: string) {
  const blocks = body
    .replace(/^#\s+.+\n/, "")
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const prose = blocks.find(
    (block) => !/^(#{1,6}\s|\||```|[-*]\s|\d+\.\s|`)/.test(block),
  );

  return (prose ?? blocks[0] ?? "").replace(/\s+/g, " ");
}

/**
 * Drop the document's own `# Title` line.
 *
 * The sheet prints the entry's name as its heading, so leaving the line in
 * renders the title twice — and `h1` is not in the sanitiser's allow-list, so
 * the second one arrives as a bare stripe of text rather than even looking like
 * a heading.
 */
function stripLeadingHeading(body: string) {
  return body.replace(/^#\s+.+(\r?\n)+/, "");
}

function readEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [];

  for (const [path, raw] of Object.entries(sources)) {
    const placement = placeSource(path);

    if (!placement) continue;

    const id = path.replace(/^\//, "").replace(/\.md$/, "");
    const { body, frontMatter } = parseDocument(raw);
    const fallbackName = id.split("/").at(-1) ?? id;

    entries.push({
      id,
      slug: id.replace(/\//g, "-"),
      name: frontMatter.name ?? titleFromBody(body, fallbackName),
      description: frontMatter.description ?? summaryFromBody(body),
      section: placement.section,
      category: placement.category,
      group: placement.group,
      contributor: placement.contributor,
      body: stripLeadingHeading(body),
      source: raw,
      lineCount: body.split("\n").length,
    });
  }

  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

const catalogEntries = readEntries();

/**
 * One category's entries for one catalogue.
 *
 * `contributor` is the catalogue being read, not a filter on top of the shared
 * one: null means the shared catalogue and excludes everybody's workspace
 * contracts, and a name means only theirs.
 */
function listEntriesByCategory(
  category: CatalogCategory,
  contributor: string | null = null,
) {
  return catalogEntries.filter(
    (entry) => entry.category === category && entry.contributor === contributor,
  );
}

/**
 * The root cards one canvas draws, in the order it draws them.
 *
 * The library's three are fixed, because a reader who learned where Skills sits
 * should not have it move. Everything else is alphabetical, because it was
 * discovered rather than designed.
 */
function rootsInSection(
  section: CatalogSection,
  contributor: string | null = null,
): CatalogCategory[] {
  const present = [
    ...new Set(
      catalogEntries
        .filter(
          (entry) =>
            entry.section === section && entry.contributor === contributor,
        )
        .map((entry) => entry.category),
    ),
  ];

  if (section !== "library") return present.sort();

  const ordered = LIBRARY_ROOTS.filter((root) => present.includes(root));

  // A contributor can file under a root the shared catalogue does not have.
  return [...ordered, ...present.filter((r) => !LIBRARY_ROOTS.includes(r))];
}

/**
 * Everyone with a workspace on one canvas, alphabetically.
 *
 * Scoped to a section so the Tools switcher lists people who contributed a
 * tool, rather than everyone who ever contributed anything.
 */
function contributors(section?: CatalogSection) {
  return [
    ...new Set(
      catalogEntries
        .filter((entry) => !section || entry.section === section)
        .map((entry) => entry.contributor)
        .filter((name): name is string => name !== null),
    ),
  ].sort();
}

/** The entry a `?node=` parameter names, or null when it names nothing. */
function findBySlug(slug: string | null) {
  if (!slug) return null;

  return catalogEntries.find((entry) => entry.slug === slug) ?? null;
}

/** The root a `?tab=` parameter names within one canvas, or null. */
function findCategory(
  tab: string | null,
  section: CatalogSection = "library",
  contributor: string | null = null,
): CatalogCategory | null {
  const wanted = tab?.toLowerCase();

  return (
    rootsInSection(section, contributor).find(
      (root) => root.toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * Which groups a category holds, in the order the canvas draws them.
 *
 * The category's own folder comes first — those are the documents that sit at
 * the top of it, so they read as the trunk rather than as one branch among
 * others — and the rest are alphabetical. Order has to be a rule rather than
 * discovery order: a reader who learned that Linear sits under GitHub should
 * not have to re-learn it because somebody added a folder.
 */
function groupsInCategory(
  category: CatalogCategory,
  contributor: string | null = null,
): CatalogGroup[] {
  const own = category;
  const present = [
    ...new Set(
      listEntriesByCategory(category, contributor).map((entry) => entry.group),
    ),
  ];

  return present.sort((left, right) => {
    if (left === own) return -1;
    if (right === own) return 1;

    return left.localeCompare(right);
  });
}

/**
 * Search matches name, description, group and path.
 *
 * An empty query matches everything rather than nothing — the canvas dims what
 * does not match, so "no query" has to mean "nothing is dimmed".
 */
function matchesQuery(entry: CatalogEntry, query: string) {
  const term = query.trim().toLowerCase();

  if (!term) return true;

  return (
    entry.name.toLowerCase().includes(term) ||
    entry.description.toLowerCase().includes(term) ||
    entry.group.toLowerCase().includes(term) ||
    entry.id.toLowerCase().includes(term)
  );
}

/** The file name this entry would have if you saved it on its own. */
function fileName(entry: CatalogEntry) {
  return `${entry.id.split("/").at(-1)}.md`;
}

/**
 * One entry as an archive member, keeping the path it has in the catalogue.
 *
 * The path is the point: an agent loads `harness/tags/plan.md` because of where
 * it sits, so an archive that flattened them would be a pile of Markdown rather
 * than something a reader can drop into place.
 */
function fileFor(entry: CatalogEntry) {
  return { path: `${entry.id}.md`, contents: entry.source };
}

/** Every file in one category of one catalogue, ready to be zipped. */
function filesInCategory(
  category: CatalogCategory,
  contributor: string | null = null,
) {
  return listEntriesByCategory(category, contributor).map(fileFor);
}

/** Where a reader goes to read, or to change, one entry. */
function sourceUrl(entry: CatalogEntry) {
  return `${GITHUB_REPOSITORY_URL}/blob/main/${entry.id}.md`;
}

/**
 * GitHub's own new-file editor, pre-addressed to the right folder.
 *
 * A contribution is a pull request against a public repository, so the shortest
 * honest path from "I wrote a skill" to "it is in the catalogue" is the page
 * GitHub already provides.
 */
function contributeUrl(entry: CatalogEntry) {
  const section = entry.section === "tools" ? "tools" : "libraries";
  const owner = entry.contributor ?? SHARED_OWNER;

  return `${GITHUB_REPOSITORY_URL}/new/main/${CATALOG_ROOT}/${owner}/${section}/${entry.category}`;
}

/** What the header counts: the catalogue being read, not the open tree. */
function entriesFor(section: CatalogSection, contributor: string | null) {
  return catalogEntries.filter(
    (entry) => entry.section === section && entry.contributor === contributor,
  );
}

function documentCount(
  section: CatalogSection = "library",
  contributor: string | null = null,
) {
  return entriesFor(section, contributor).length;
}

function groupCount(
  section: CatalogSection = "library",
  contributor: string | null = null,
) {
  return new Set(entriesFor(section, contributor).map((e) => e.group)).size;
}

const catalogService = {
  contributors,
  fileName,
  filesInCategory,
  contributeUrl,
  documentCount,
  findBySlug,
  findCategory,
  groupCount,
  groupsInCategory,
  listEntriesByCategory,
  rootsInSection,
  matchesQuery,
  sourceUrl,
};

export default catalogService;
