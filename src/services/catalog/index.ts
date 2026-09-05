/**
 * The catalogue, read straight out of `machine/catalog/`.
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
 */

export type CatalogCategory = "HARNESSES" | "SKILLS" | "HOOKS" | "TEMPLATES";

export type CatalogArea =
  | "workflow"
  | "delivery"
  | "github"
  | "linear"
  | "supabase"
  | "playwright"
  | "evidence"
  | "projects"
  | "frontend";

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
  category: CatalogCategory;
  area: CatalogArea;
  /** The document itself, front matter stripped. */
  body: string;
  /** Rough reading weight, shown so a reader can tell a page from a paragraph. */
  lineCount: number;
}

const CATALOG_ROOT = "machine/catalog";

/**
 * The public repository the catalogue is contributed to.
 *
 * Deliberately not the private mirror this checkout pushes to: a "Contribute"
 * link is only worth showing if a stranger can open it.
 */
export const GITHUB_REPOSITORY_URL =
  "https://github.com/synasapmob/hub-william";

export const CATEGORY_ORDER: CatalogCategory[] = [
  "HARNESSES",
  "SKILLS",
  "HOOKS",
  "TEMPLATES",
];

export const AREA_ORDER: CatalogArea[] = [
  "workflow",
  "delivery",
  "frontend",
  "github",
  "linear",
  "supabase",
  "playwright",
  "evidence",
  "projects",
];

export const AREA_LABELS: Record<CatalogArea, string> = {
  workflow: "Workflow",
  delivery: "Delivery",
  frontend: "Frontend",
  github: "GitHub",
  linear: "Linear",
  supabase: "Supabase",
  playwright: "Playwright",
  evidence: "Evidence",
  projects: "Projects",
};

/**
 * Which integration a document belongs to, where its folder does not say.
 *
 * A supporting contract lives in a folder named after its integration, so the
 * path answers for it. A tag does not: `draft`, `mergeable`, `merge` and
 * `rebase` all sit in `harness/tags/` and are all about a GitHub pull request,
 * and grouping them as "workflow" alongside `plan` would hide exactly the thing
 * a reader came to the canvas to see. This is editorial, and it is a table
 * rather than a heuristic because that is what it honestly is.
 */
const areaBySlug: Record<string, CatalogArea> = {
  // Harness tags
  AGENTS: "workflow",
  answer: "workflow",
  ignore: "workflow",
  plan: "workflow",
  report: "workflow",
  delivery: "delivery",
  "delivery-verify": "delivery",
  worktree: "delivery",
  draft: "github",
  merge: "github",
  mergeable: "github",
  rebase: "github",
  linear: "linear",
  playwright: "playwright",
  "dopa-tps": "projects",
  "supabase-routing": "supabase",
  // Templates
  "approach-history": "evidence",
  "test-evidence": "evidence",
  "github-pull-request": "github",
  "linear-issue": "linear",
  "requirements-freshness": "linear",
  // Skills
  "frontend-convention": "frontend",
  "frontend-verify": "frontend",
  "supabase-remote": "supabase",
};

export const CATEGORY_SUMMARIES: Record<CatalogCategory, string> = {
  HARNESSES:
    "Execution modes. Each one is a tag the operator types, and a contract the agent must load before it plans, mutates or writes anywhere outside the checkout.",
  SKILLS:
    "Cognitive capabilities loaded on demand. A skill carries the rules for one discipline and the reading order that makes them apply.",
  HOOKS:
    "Supporting contracts that fire around an action — before a GitHub write, before a Linear issue, before evidence is claimed — whether or not a tag asked for them.",
  TEMPLATES:
    "The shapes the workspace writes into: approach histories, test evidence, pull requests and issues, so two agents produce the same artefact.",
};

/** Every Markdown file under the catalogue, inlined at build time. */
const sources = import.meta.glob("/machine/catalog/**/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

function areaFromSlug(slug: string): CatalogArea {
  return areaBySlug[slug] ?? "workflow";
}

interface CatalogPlacement {
  category: CatalogCategory;
  area: CatalogArea;
  contributor: string | null;
}

/** The folder a contributor files an entry under, and the category it becomes. */
const contribCategories: Record<string, CatalogCategory> = {
  harness: "HARNESSES",
  skills: "SKILLS",
  hooks: "HOOKS",
  templates: "TEMPLATES",
};

/**
 * Where a source file lands, decided by where it already lives.
 *
 * Returns null for anything the catalogue does not publish — a skill's
 * `references/` are pages of one skill, not entries beside it.
 */
function placeSource(path: string): CatalogPlacement | null {
  const relative = path.slice(`/${CATALOG_ROOT}/`.length);
  const segments = relative.split("/");
  const slug = segments.at(-1)?.replace(/\.md$/, "") ?? "";

  if (segments[0] === "harness") {
    if (segments.length === 2 || segments[1] === "tags") {
      return {
        category: "HARNESSES",
        area: areaFromSlug(slug),
        contributor: null,
      };
    }

    const area = AREA_ORDER.find((candidate) => candidate === segments[1]);

    return area ? { category: "HOOKS", area, contributor: null } : null;
  }

  if (segments[0] === "skills") {
    if (segments.at(-1) !== "SKILL.md") return null;

    return {
      category: "SKILLS",
      area: areaFromSlug(segments[1] ?? ""),
      contributor: null,
    };
  }

  if (segments[0] === "templates" && segments.length === 2) {
    return {
      category: "TEMPLATES",
      area: areaFromSlug(slug),
      contributor: null,
    };
  }

  // contrib/<who>/<kind>/… mirrors the shared layout one level down, so a
  // contributor files things the same way the catalogue already does.
  if (segments[0] === "contrib" && segments.length >= 4) {
    const contributor = segments[1];
    const category = contribCategories[segments[2] ?? ""];

    if (!contributor || !category) return null;
    if (category === "SKILLS" && segments.at(-1) !== "SKILL.md") return null;

    const named = category === "SKILLS" ? (segments[3] ?? "") : slug;

    return { category, area: areaFromSlug(named), contributor };
  }

  return null;
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

    const id = path.slice(`/${CATALOG_ROOT}/`.length).replace(/\.md$/, "");
    const { body, frontMatter } = parseDocument(raw);
    const fallbackName = id.split("/").at(-1) ?? id;

    entries.push({
      id,
      slug: id.replace(/\//g, "-"),
      name: frontMatter.name ?? titleFromBody(body, fallbackName),
      description: frontMatter.description ?? summaryFromBody(body),
      category: placement.category,
      area: placement.area,
      contributor: placement.contributor,
      body: stripLeadingHeading(body),
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

/** Everyone with a workspace in the catalogue, alphabetically. */
function contributors() {
  return [
    ...new Set(
      catalogEntries
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

/** The category a `?tab=` parameter names, or null when it names nothing. */
function findCategory(tab: string | null): CatalogCategory | null {
  const wanted = tab?.toLowerCase();

  return (
    CATEGORY_ORDER.find((category) => category.toLowerCase() === wanted) ?? null
  );
}

/** Which integrations a category covers, in the order the canvas draws them. */
function areasInCategory(
  category: CatalogCategory,
  contributor: string | null = null,
): CatalogArea[] {
  const present = new Set(
    listEntriesByCategory(category, contributor).map((entry) => entry.area),
  );

  return AREA_ORDER.filter((area) => present.has(area));
}

/**
 * Search matches name, description, area and path.
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
    entry.area.includes(term) ||
    entry.id.toLowerCase().includes(term)
  );
}

/** Where a reader goes to read, or to change, one entry. */
function sourceUrl(entry: CatalogEntry) {
  return `${GITHUB_REPOSITORY_URL}/blob/main/${CATALOG_ROOT}/${entry.id}.md`;
}

/**
 * GitHub's own new-file editor, pre-addressed to the right folder.
 *
 * A contribution is a pull request against a public repository, so the shortest
 * honest path from "I wrote a skill" to "it is in the catalogue" is the page
 * GitHub already provides.
 */
function contributeUrl(category: CatalogCategory) {
  const folder =
    category === "SKILLS"
      ? `${CATALOG_ROOT}/skills`
      : category === "TEMPLATES"
        ? `${CATALOG_ROOT}/templates`
        : `${CATALOG_ROOT}/harness`;

  return `${GITHUB_REPOSITORY_URL}/new/main/${folder}`;
}

/** What the header counts: the catalogue being read, not the open tree. */
function entriesFor(contributor: string | null) {
  return catalogEntries.filter((entry) => entry.contributor === contributor);
}

function documentCount(contributor: string | null = null) {
  return entriesFor(contributor).length;
}

function areaCount(contributor: string | null = null) {
  return new Set(entriesFor(contributor).map((entry) => entry.area)).size;
}

const catalogService = {
  areaCount,
  areasInCategory,
  contributors,
  contributeUrl,
  documentCount,
  findBySlug,
  findCategory,
  listEntriesByCategory,
  matchesQuery,
  sourceUrl,
};

export default catalogService;
