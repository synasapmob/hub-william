export type JobCategory = "software-engineering" | "frontend" | "backend";

export interface SourceDefinition {
  id: string;
  name: string;
  companyId?: string;
  type:
    | "jobicy"
    | "remotive"
    | "lever"
    | "ashby"
    | "jooble"
    | "grab-rss"
    | "greenhouse"
    | "eightfold";
  slug?: string;
  completeSnapshot: boolean;
}

export type SourceCoverageStatus = "complete" | "partial" | "unknown";

export interface SourceFetchAudit {
  coverageStatus: SourceCoverageStatus;
  expectedJobs: number | null;
  rawJobsFetched: number;
  uniqueJobsFetched: number;
  marketJobsKept: number;
  duplicateJobs: number;
  pagesFetched: number;
  pageSize: number | null;
  stopReason: string;
  deactivationAllowed: boolean;
}

export interface SourceFetchResult {
  jobs: RawJob[];
  audit: SourceFetchAudit;
}

export function allowsMissingJobDeactivation(
  completeSnapshot: boolean,
  coverageStatus: SourceCoverageStatus,
) {
  return completeSnapshot && coverageStatus === "complete";
}

export interface OffsetPage<T> {
  items: T[];
  expectedTotal: number | null;
}

export interface OffsetPageCollection<T> {
  items: T[];
  expectedTotal: number | null;
  rawItemsFetched: number;
  pagesFetched: number;
  coverageStatus: SourceCoverageStatus;
  stopReason: string;
}

export interface RawJob {
  sourceId: string;
  companyId: string | null;
  externalId: string;
  sourceUrl: string;
  title: string;
  companyName: string;
  companyLogoUrl: string | null;
  descriptionHtml: string;
  descriptionQuality: "full" | "snippet";
  locationText: string;
  employmentType: string | null;
  postedAt: string | null;
  salaryText: string | null;
  explicitSeniority: string | null;
  payload: Record<string, unknown>;
}

export interface ParsedSkill {
  slug: string;
  name: string;
  group: string;
  requirement: "required" | "preferred" | "mentioned";
  evidence: string;
}

export interface ParsedJob extends RawJob {
  category: JobCategory;
  roleTags: JobCategory[];
  locationCity: string;
  remote: boolean;
  seniority: string;
  senioritySource: "explicit" | "inferred" | "unknown";
  minimumExperienceYears: number | null;
  descriptionText: string;
  excerpt: string;
  contentHash: string;
  dedupeKey: string;
  skills: ParsedSkill[];
}

export const JOB_PARSER_VERSION = "rules-2026-08-21-v8";

export const jobSources: SourceDefinition[] = [
  {
    id: "jobicy-apac",
    name: "Jobicy",
    type: "jobicy",
    completeSnapshot: false,
  },
  {
    id: "remotive",
    name: "Remotive",
    type: "remotive",
    completeSnapshot: true,
  },
  {
    id: "jooble-vn",
    name: "Jooble",
    type: "jooble",
    completeSnapshot: false,
  },
  {
    id: "grab-careers",
    name: "Grab Careers",
    companyId: "grab",
    type: "grab-rss",
    // The RSS feed has no total-count contract. It may contain the whole board,
    // but that cannot be proven, so missing rows must never be deactivated from
    // this source alone.
    completeSnapshot: false,
  },
  {
    id: "greenhouse-axon",
    name: "Axon Careers",
    companyId: "axon",
    type: "greenhouse",
    slug: "axon",
    completeSnapshot: true,
  },
  {
    id: "eightfold-nab",
    name: "NAB Careers",
    companyId: "nab",
    type: "eightfold",
    completeSnapshot: true,
  },
];

const categoryPatterns: Array<{
  category: JobCategory;
  pattern: RegExp;
}> = [
  {
    category: "frontend",
    pattern:
      /\b(?:front[ -]?end|frontend)\b|\b(?:react(?:\.?js)?|next(?:\.?js)?|vue(?:\.?js)?|angular|web ui|ui) (?:engineer|developer)\b/i,
  },
  {
    category: "backend",
    pattern:
      /\b(?:back[ -]?end|backend|server[- ]side)\b|\b(?:node\.?js|java|golang|\.net|api|database) (?:engineer|developer)\b/i,
  },
  {
    category: "software-engineering",
    pattern:
      /\bsoftware (?:development )?(?:engineer|developer|engineering)\b|\b(?:android|ios|iphone) (?:engineer|developer)\b|\bmobile (?:engineer|developer)\b|\bfull[ -]?stack\b|\bmember of technical staff\b|\bmts\b|\b(?:machine learning|ml) engineer\b|\bai engineer\b|\bengineering manager\b|\b(?:site reliability|sre) engineer\b|\bsecurity (?:operations )?engineer\b|\bembedded (?:software )?engineer\b|\bstaff engineer\b/i,
  },
];

interface SkillDefinition {
  slug: string;
  name: string;
  group: string;
  pattern: RegExp;
}

const skillDefinitions: SkillDefinition[] = [
  {
    slug: "react",
    name: "React",
    group: "Framework",
    pattern: /\breact(?:\.js)?\b/i,
  },
  {
    slug: "nextjs",
    name: "Next.js",
    group: "Framework",
    pattern: /\bnext(?:\.js|js)\b/i,
  },
  {
    slug: "vue",
    name: "Vue",
    group: "Framework",
    pattern: /\bvue(?:\.js)?\b/i,
  },
  {
    slug: "angular",
    name: "Angular",
    group: "Framework",
    pattern: /\bangular\b/i,
  },
  {
    slug: "typescript",
    name: "TypeScript",
    group: "Language",
    pattern: /\btypescript\b/i,
  },
  {
    slug: "javascript",
    name: "JavaScript",
    group: "Language",
    pattern: /\bjavascript\b/i,
  },
  { slug: "python", name: "Python", group: "Language", pattern: /\bpython\b/i },
  { slug: "java", name: "Java", group: "Language", pattern: /\bjava\b/i },
  {
    slug: "golang",
    name: "Go",
    group: "Language",
    pattern: /\b(?:golang|go language)\b/i,
  },
  {
    slug: "csharp",
    name: "C#",
    group: "Language",
    pattern: /(?:\bc#\b|\bc sharp\b)/i,
  },
  {
    slug: "redux",
    name: "Redux",
    group: "State management",
    pattern: /\b(?:redux|redux toolkit|rtk)\b/i,
  },
  {
    slug: "zustand",
    name: "Zustand",
    group: "State management",
    pattern: /\bzustand\b/i,
  },
  {
    slug: "react-context",
    name: "React Context",
    group: "State management",
    pattern: /\b(?:react context|context api)\b/i,
  },
  {
    slug: "tailwind",
    name: "Tailwind CSS",
    group: "Styling",
    pattern: /\btailwind(?: css)?\b/i,
  },
  {
    slug: "sass",
    name: "Sass",
    group: "Styling",
    pattern: /\b(?:sass|scss)\b/i,
  },
  {
    slug: "nodejs",
    name: "Node.js",
    group: "Backend",
    pattern: /\bnode(?:\.js)?\b/i,
  },
  {
    slug: "nestjs",
    name: "NestJS",
    group: "Backend",
    pattern: /\bnest(?:\.js|js)\b/i,
  },
  {
    slug: "spring",
    name: "Spring",
    group: "Backend",
    pattern: /\bspring(?: boot)?\b/i,
  },
  {
    slug: "dotnet",
    name: ".NET",
    group: "Backend",
    pattern: /(?:\.net|dotnet)/i,
  },
  {
    slug: "postgresql",
    name: "PostgreSQL",
    group: "Database",
    pattern: /\b(?:postgres|postgresql)\b/i,
  },
  { slug: "mysql", name: "MySQL", group: "Database", pattern: /\bmysql\b/i },
  {
    slug: "mongodb",
    name: "MongoDB",
    group: "Database",
    pattern: /\bmongodb\b/i,
  },
  { slug: "redis", name: "Redis", group: "Database", pattern: /\bredis\b/i },
  {
    slug: "rest",
    name: "REST API",
    group: "API",
    pattern: /\brest(?:ful)?(?: api)?\b/i,
  },
  { slug: "graphql", name: "GraphQL", group: "API", pattern: /\bgraphql\b/i },
  { slug: "jest", name: "Jest", group: "Testing", pattern: /\bjest\b/i },
  { slug: "vitest", name: "Vitest", group: "Testing", pattern: /\bvitest\b/i },
  {
    slug: "cypress",
    name: "Cypress",
    group: "Testing",
    pattern: /\bcypress\b/i,
  },
  {
    slug: "playwright",
    name: "Playwright",
    group: "Testing",
    pattern: /\bplaywright\b/i,
  },
  { slug: "docker", name: "Docker", group: "DevOps", pattern: /\bdocker\b/i },
  {
    slug: "kubernetes",
    name: "Kubernetes",
    group: "DevOps",
    pattern: /\b(?:kubernetes|k8s)\b/i,
  },
  {
    slug: "aws",
    name: "AWS",
    group: "Cloud",
    pattern: /\b(?:aws|amazon web services)\b/i,
  },
  {
    slug: "gcp",
    name: "Google Cloud",
    group: "Cloud",
    pattern: /\b(?:gcp|google cloud)\b/i,
  },
  { slug: "azure", name: "Azure", group: "Cloud", pattern: /\bazure\b/i },
  {
    slug: "terraform",
    name: "Terraform",
    group: "DevOps",
    pattern: /\bterraform\b/i,
  },
  {
    slug: "cicd",
    name: "CI/CD",
    group: "DevOps",
    pattern: /\bci\s*\/\s*cd\b|continuous integration/i,
  },
  { slug: "figma", name: "Figma", group: "Design", pattern: /\bfigma\b/i },
  {
    slug: "adobe",
    name: "Adobe Creative Cloud",
    group: "Design",
    pattern: /\b(?:adobe|photoshop|illustrator|after effects)\b/i,
  },
  {
    slug: "seo",
    name: "SEO",
    group: "Marketing",
    pattern: /\bseo\b|search engine optimi[sz]ation/i,
  },
  {
    slug: "google-ads",
    name: "Google Ads",
    group: "Marketing",
    pattern: /\b(?:google ads|adwords)\b/i,
  },
  {
    slug: "meta-ads",
    name: "Meta Ads",
    group: "Marketing",
    pattern: /\b(?:meta ads|facebook ads)\b/i,
  },
  {
    slug: "ga4",
    name: "GA4",
    group: "Marketing",
    pattern: /\b(?:ga4|google analytics)\b/i,
  },
  {
    slug: "english",
    name: "English",
    group: "Language",
    pattern: /\benglish\b/i,
  },
  {
    slug: "html-css",
    name: "HTML / CSS",
    group: "Web fundamentals",
    pattern: /\bhtml5?\b|\bcss3?\b/i,
  },
  {
    slug: "testing",
    name: "Testing",
    group: "Testing",
    pattern:
      /\b(?:unit|integration|end[- ]to[- ]end|e2e|automation) test(?:ing|s)?\b/i,
  },
  {
    slug: "system-design",
    name: "System design",
    group: "Engineering practice",
    pattern: /\b(?:system|solution|software) (?:design|architecture)\b/i,
  },
  {
    slug: "microservices",
    name: "Microservices",
    group: "Architecture",
    pattern: /\bmicroservices?\b/i,
  },
  {
    slug: "agile",
    name: "Agile",
    group: "Engineering practice",
    pattern: /\b(?:agile|scrum)\b/i,
  },
  {
    slug: "kafka",
    name: "Kafka",
    group: "Backend",
    pattern: /\bkafka\b/i,
  },
  {
    slug: "swift",
    name: "Swift",
    group: "Language",
    pattern: /\bswift\b/i,
  },
  {
    slug: "kotlin",
    name: "Kotlin",
    group: "Language",
    pattern: /\bkotlin\b/i,
  },
];

function decodeHtml(value: string) {
  const entities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value
    .replace(/<\/(p|li|h[1-6]|div)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[\da-f]+|[a-z]+);/gi, (match, entity: string) => {
      if (entity.startsWith("#x")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
      }
      if (entity.startsWith("#")) {
        return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
      }
      return entities[entity.toLowerCase()] ?? match;
    })
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function canonical(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function canonicalCompanyName(value: string) {
  return canonical(value).replace(/[^a-z0-9]+/g, "");
}

const targetCompanyAliases: Array<readonly [string, readonly string[]]> = [
  ["tyme-group", ["Tyme", "Tyme Group"]],
  ["smg", ["SMG", "Swiss Marketplace Group", "SMG Swiss Marketplace Group"]],
  ["digital-unicorn", ["Digital Unicorn"]],
  ["manulife", ["Manulife", "Manulife Vietnam"]],
  ["axon", ["Axon", "Axon Enterprise"]],
  ["grab", ["Grab"]],
  ["corsair", ["Corsair", "Corsair Gaming"]],
  ["masan-group", ["Masan", "Masan Group"]],
  ["moatable", ["Moatable"]],
  ["worldquant", ["WorldQuant", "WorldQuant Vietnam"]],
  [
    "nab",
    [
      "NAB",
      "NAB Vietnam",
      "National Australia Bank",
      "National Australia Bank Vietnam",
    ],
  ],
  ["employment-hero", ["Employment Hero"]],
  ["vinsmart-future", ["VinSmart", "VinSmart Future"]],
];
const targetCompanyIdByAlias = new Map<string, string>(
  targetCompanyAliases.flatMap(([companyId, aliases]) =>
    aliases.map((alias) => [canonicalCompanyName(alias), companyId] as const),
  ),
);
const targetCompanyIds = new Set(targetCompanyIdByAlias.values());

function targetCompanyId(raw: RawJob) {
  if (raw.companyId && targetCompanyIds.has(raw.companyId)) {
    return raw.companyId;
  }
  return (
    targetCompanyIdByAlias.get(canonicalCompanyName(raw.companyName)) ?? null
  );
}

function uniqueCategories(categories: JobCategory[]) {
  const seen = new Set<JobCategory>();
  const result: JobCategory[] = [];
  for (const category of categories) {
    if (seen.has(category)) continue;
    seen.add(category);
    result.push(category);
  }
  return result;
}

function categoriesFromTitle(title: string) {
  return categoryPatterns.flatMap(({ category, pattern }) =>
    pattern.test(title) ? [category] : [],
  );
}

function categoriesFromPayload(payload: Record<string, unknown>) {
  const family = text(
    asArray(payload.metadata).find((item) =>
      /^job family$/i.test(text(item.name)),
    )?.value,
  );
  const tags: JobCategory[] = [];
  if (/\bfront[ -]?end\b/i.test(family)) tags.push("frontend");
  if (/\bback[ -]?end\b/i.test(family)) tags.push("backend");
  if (
    /\b(?:software engineering|machine learning|ai research|site reliability)\b/i.test(
      family,
    )
  ) {
    tags.push("software-engineering");
  }
  return tags;
}

function classifyCategories(raw: RawJob) {
  return uniqueCategories([
    ...categoriesFromTitle(raw.title),
    ...categoriesFromPayload(raw.payload),
  ]);
}

function isStateRemote(location: string) {
  return /^[a-z][a-z ]+-remote\b/.test(canonical(location));
}

function isWesternRemote(location: string) {
  const normalized = canonical(location);
  return (
    /\b(remote|anywhere|worldwide|global)\b/.test(normalized) &&
    /\b(united states|\busa\b|\bus\b|canada|united kingdom|\buk\b)\b/.test(
      normalized,
    )
  );
}

function normalizeCity(location: string) {
  const normalized = canonical(location);
  if (/ho chi minh|hcmc|saigon|sai gon/.test(normalized)) return "ho-chi-minh";
  if (/ha noi|hanoi/.test(normalized)) return "ha-noi";
  if (/da nang|danang/.test(normalized)) return "da-nang";
  if (/viet ?nam|\bvn\b/.test(normalized)) return "vietnam-other";
  if (isStateRemote(location) || isWesternRemote(location)) return "other";
  if (/\b(remote|anywhere|worldwide|global)\b/.test(normalized))
    return "remote";
  if (
    /asia|apac|south east asia|southeast asia|singapore|malaysia|indonesia|thailand|philippines|australia|japan|korea|hong kong|taiwan|new zealand/.test(
      normalized,
    )
  )
    return "apac";
  return "other";
}

function extractMinimumExperience(text: string) {
  const sample = canonical(text);
  const range = sample.match(
    /(?:minimum|min\.?|at least|from|tu|co)\s*(\d+(?:\.\d+)?)\s*(?:[-–—]|to|den)\s*\d+(?:\.\d+)?\s*(?:years?|nam)/i,
  );
  if (range) return Number(range[1]);

  const patterns = [
    /(?:minimum|min\.?|at least|from|tu|co)\s*(\d+(?:\.\d+)?)\+?\s*(?:years?|nam)/i,
    /(\d+(?:\.\d+)?)\+\s*(?:years?|nam)/i,
    /(\d+(?:\.\d+)?)\s*(?:years?|nam)(?:\s+of)?\s+(?:professional\s+)?experience/i,
  ];

  for (const pattern of patterns) {
    const match = sample.match(pattern);
    if (match) return Number(match[1]);
  }

  return null;
}

function normalizeSeniority(
  explicit: string | null,
  title: string,
  years: number | null,
) {
  const text = canonical(`${explicit ?? ""} ${title}`);
  const levels: Array<[string, RegExp]> = [
    ["internship", /\b(intern|internship|trainee)\b/],
    ["entry", /\b(fresher|entry[ -]?level|graduate)\b/],
    ["junior", /\bjunior\b/],
    ["lead", /\b(lead|principal|staff|manager|head|director)\b/],
    ["senior", /\b(senior|sr\.)\b/],
    ["mid", /\b(mid|middle|intermediate)\b/],
  ];
  const match = levels.find(([, pattern]) => pattern.test(text));
  if (match) return { seniority: match[0], source: "explicit" as const };
  if (years === null)
    return { seniority: "unknown", source: "unknown" as const };
  if (years < 1) return { seniority: "entry", source: "inferred" as const };
  if (years < 3) return { seniority: "junior", source: "inferred" as const };
  if (years < 5) return { seniority: "mid", source: "inferred" as const };
  return { seniority: "senior", source: "inferred" as const };
}

function evidenceFor(text: string, index: number) {
  const start = Math.max(
    0,
    text.lastIndexOf("\n", Math.max(0, index - 180)) + 1,
  );
  const paragraphEnd = text.indexOf("\n", index + 180);
  const end =
    paragraphEnd === -1 ? Math.min(text.length, index + 260) : paragraphEnd;
  return text.slice(start, end).replace(/\s+/g, " ").trim().slice(0, 300);
}

function requirementFor(text: string, evidence: string, index: number) {
  const section = text.slice(Math.max(0, index - 1_200), index).toLowerCase();
  const preferredSection = Math.max(
    section.lastIndexOf("nice to have"),
    section.lastIndexOf("preferred"),
    section.lastIndexOf("bonus"),
  );
  const requiredSection = Math.max(
    section.lastIndexOf("must have"),
    section.lastIndexOf("requirements"),
    section.lastIndexOf("essential skills"),
    section.lastIndexOf("minimum qualifications"),
  );
  if (preferredSection > requiredSection) return "preferred" as const;
  if (requiredSection >= 0) return "required" as const;
  if (
    /nice to have|preferred|a plus|bonus|advantage|desirable|good to have/i.test(
      evidence,
    )
  ) {
    return "preferred" as const;
  }
  if (
    /must|required|requirement|minimum|at least|proficien|strong experience|hands-on/i.test(
      evidence,
    )
  ) {
    return "required" as const;
  }
  return "mentioned" as const;
}

function extractSkills(text: string) {
  return skillDefinitions.flatMap((skill) => {
    const match = skill.pattern.exec(text);
    if (!match || match.index === undefined) return [];
    const evidence = evidenceFor(text, match.index);
    return [
      {
        slug: skill.slug,
        name: skill.name,
        group: skill.group,
        requirement: requirementFor(text, evidence, match.index),
        evidence,
      },
    ];
  });
}

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function parseJob(raw: RawJob): Promise<ParsedJob | null> {
  const companyId = targetCompanyId(raw);
  if (!companyId) return null;
  const descriptionText = decodeHtml(raw.descriptionHtml);
  const roleTags = classifyCategories(raw);
  const category = roleTags[0];
  if (!category) return null;

  const locationCity = normalizeCity(raw.locationText);
  const minimumExperienceYears = extractMinimumExperience(descriptionText);
  const seniority = normalizeSeniority(
    raw.explicitSeniority,
    raw.title,
    minimumExperienceYears,
  );
  const contentHash = await hash(
    [raw.title, raw.companyName, raw.locationText, descriptionText].join("\n"),
  );
  const dedupeKey = await hash(
    [canonical(raw.companyName), canonical(raw.title), locationCity].join("|"),
  );

  return {
    ...raw,
    companyId,
    category,
    roleTags,
    locationCity,
    remote:
      locationCity === "remote" ||
      /\bremote\b/i.test(descriptionText.slice(0, 2_000)),
    seniority: seniority.seniority,
    senioritySource: seniority.source,
    minimumExperienceYears,
    descriptionText,
    excerpt: descriptionText.slice(0, 280),
    contentHash,
    dedupeKey,
    skills: extractSkills(descriptionText),
  };
}

export function isMarketLocation(location: string) {
  return normalizeCity(location) !== "other";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalText(value: unknown) {
  const valueText = text(value).trim();
  return valueText || null;
}

function textList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .join(", ")
    : optionalText(value);
}

function asArray(value: unknown) {
  return Array.isArray(value) ? value.map(record) : [];
}

function positiveInteger(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function uniqueCount(jobs: RawJob[]) {
  return new Set(jobs.map((job) => job.externalId).filter(Boolean)).size;
}

export async function collectOffsetPages<T>(
  fetchPage: (start: number) => Promise<OffsetPage<T>>,
  identify: (item: T) => string,
  options: { pageSize: number; maxPages?: number },
): Promise<OffsetPageCollection<T>> {
  const maxPages = options.maxPages ?? 500;
  const itemsById = new Map<string, T>();
  let expectedTotal: number | null = null;
  let pagesFetched = 0;
  let rawItemsFetched = 0;
  let stopReason = "end-of-results";
  let coverageStatus: SourceCoverageStatus = "complete";

  for (let start = 0; pagesFetched < maxPages; start += options.pageSize) {
    const page = await fetchPage(start);
    pagesFetched += 1;
    rawItemsFetched += page.items.length;
    expectedTotal = page.expectedTotal ?? expectedTotal;

    let newIds = 0;
    for (const item of page.items) {
      const id = identify(item);
      if (!id) continue;
      if (!itemsById.has(id)) newIds += 1;
      itemsById.set(id, item);
    }

    if (expectedTotal !== null && itemsById.size >= expectedTotal) {
      stopReason = "expected-total-reached";
      break;
    }
    if (page.items.length === 0) {
      if (expectedTotal !== null && itemsById.size < expectedTotal) {
        coverageStatus = "partial";
        stopReason = "premature-empty-page";
      }
      break;
    }
    if (newIds === 0) {
      coverageStatus = "partial";
      stopReason = "repeated-page";
      break;
    }
    if (page.items.length < options.pageSize) {
      if (expectedTotal !== null && itemsById.size < expectedTotal) {
        coverageStatus = "partial";
        stopReason = "short-page-before-total";
      } else {
        stopReason = "short-final-page";
      }
      break;
    }
    if (pagesFetched === maxPages) {
      coverageStatus = "partial";
      stopReason = "pagination-safety-limit";
    }
  }

  const items = [...itemsById.values()];
  if (expectedTotal !== null && items.length !== expectedTotal) {
    coverageStatus = "partial";
  }
  return {
    items,
    expectedTotal,
    rawItemsFetched,
    pagesFetched,
    coverageStatus,
    stopReason,
  };
}

function collectionResult(
  source: SourceDefinition,
  jobs: RawJob[],
  options: {
    coverageStatus: SourceCoverageStatus;
    expectedJobs?: number | null;
    pagesFetched?: number;
    pageSize?: number | null;
    stopReason: string;
  },
): SourceFetchResult {
  const uniqueJobsFetched = uniqueCount(jobs);
  const expectedJobs = options.expectedJobs ?? null;
  const countMatches =
    expectedJobs === null || uniqueJobsFetched === expectedJobs;
  const coverageStatus =
    options.coverageStatus === "complete" && !countMatches
      ? "partial"
      : options.coverageStatus;
  return {
    jobs,
    audit: {
      coverageStatus,
      expectedJobs,
      rawJobsFetched: jobs.length,
      uniqueJobsFetched,
      marketJobsKept: uniqueJobsFetched,
      duplicateJobs: Math.max(0, jobs.length - uniqueJobsFetched),
      pagesFetched: options.pagesFetched ?? 1,
      pageSize: options.pageSize ?? null,
      stopReason:
        coverageStatus === "partial" && options.coverageStatus === "complete"
          ? "response-count-mismatch"
          : options.stopReason,
      deactivationAllowed: allowsMissingJobDeactivation(
        source.completeSnapshot,
        coverageStatus,
      ),
    },
  };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
      "User-Agent": "Hub-William-Job-Market/1.0",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  }
  return (await response.json()) as unknown;
}

async function fetchText(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/xml,text/xml,text/plain",
      "User-Agent": "Hub-William-Job-Market/1.0",
    },
    signal: AbortSignal.timeout(25_000),
  });
  if (!response.ok) {
    throw new Error(`Upstream returned HTTP ${response.status}.`);
  }
  return await response.text();
}

function xmlValue(value: string, tag: string) {
  const match = value.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return (match?.[1] ?? "")
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .trim();
}

async function fetchGrab(source: SourceDefinition) {
  const xml = await fetchText("https://www.grab.careers/en/jobs/xml/?rss=true");
  const entries = xml.match(/<job>[\s\S]*?<\/job>/gi) ?? [];
  const jobs = entries.map((job): RawJob => {
    const city = xmlValue(job, "city");
    const state = xmlValue(job, "state");
    const country = xmlValue(job, "country");
    return {
      sourceId: source.id,
      companyId: source.companyId ?? null,
      externalId: xmlValue(job, "apijobid") || xmlValue(job, "requisitionid"),
      sourceUrl: xmlValue(job, "url"),
      title: xmlValue(job, "title"),
      companyName: "Grab",
      companyLogoUrl: null,
      descriptionHtml: xmlValue(job, "description"),
      descriptionQuality: "full",
      locationText: [city, state, country].filter(Boolean).join(", "),
      employmentType: optionalText(xmlValue(job, "jobtype")),
      postedAt:
        optionalText(xmlValue(job, "date")) ??
        optionalText(xmlValue(job, "lastactivitydate")),
      salaryText: null,
      explicitSeniority: null,
      payload: {
        apijobid: xmlValue(job, "apijobid"),
        requisitionid: xmlValue(job, "requisitionid"),
        title: xmlValue(job, "title"),
        url: xmlValue(job, "url"),
        city,
        state,
        country,
      },
    };
  });
  return collectionResult(source, jobs, {
    coverageStatus: "unknown",
    stopReason: "feed-ended-without-total",
  });
}

async function fetchGreenhouse(source: SourceDefinition) {
  const payload = record(
    await fetchJson(
      `https://boards-api.greenhouse.io/v1/boards/${source.slug}/jobs?content=true`,
    ),
  );
  const jobs = asArray(payload.jobs).map((job): RawJob => ({
    sourceId: source.id,
    companyId: source.companyId ?? null,
    externalId: String(job.id ?? ""),
    sourceUrl: text(job.absolute_url),
    title: text(job.title),
    companyName: "Axon",
    companyLogoUrl: null,
    descriptionHtml: text(job.content),
    descriptionQuality: "full",
    locationText: text(record(job.location).name),
    employmentType: null,
    postedAt: optionalText(job.first_published) ?? optionalText(job.updated_at),
    salaryText: null,
    explicitSeniority: null,
    payload: job,
  }));
  return collectionResult(source, jobs, {
    coverageStatus: "complete",
    expectedJobs: positiveInteger(record(payload.meta).total),
    stopReason: "full-collection-response",
  });
}

async function fetchEightfold(source: SourceDefinition) {
  const pageSize = 10;
  const collection = await collectOffsetPages(
    async (start) => {
      const payload = record(
        await fetchJson(
          `https://nab.eightfold.ai/api/pcsx/search?domain=nab.com.au&query=&location=Vietnam&start=${start}`,
        ),
      );
      const data = record(payload.data);
      return {
        items: asArray(data.positions),
        expectedTotal: positiveInteger(data.count),
      };
    },
    (position) => String(position.id ?? ""),
    { pageSize },
  );
  const positions = collection.items;

  const jobs: RawJob[] = [];
  for (let index = 0; index < positions.length; index += 10) {
    const batch = positions.slice(index, index + 10);
    jobs.push(
      ...(await Promise.all(
        batch.map(async (position): Promise<RawJob> => {
          const id = String(position.id ?? "");
          const payload = record(
            await fetchJson(
              `https://nab.eightfold.ai/api/pcsx/position_details?position_id=${id}&domain=nab.com.au&hl=en&queried_location=Vietnam`,
            ),
          );
          const job = record(payload.data);
          const postedTs = Number(job.postedTs ?? position.postedTs);
          return {
            sourceId: source.id,
            companyId: source.companyId ?? null,
            externalId: text(job.displayJobId) || id,
            sourceUrl:
              text(job.publicUrl) ||
              `https://nab.eightfold.ai/careers/job/${id}`,
            title: text(job.name) || text(position.name),
            companyName: "NAB Vietnam",
            companyLogoUrl: null,
            descriptionHtml: text(job.jobDescription),
            descriptionQuality: "full",
            locationText:
              text(job.location) || textList(job.locations) || "Vietnam",
            employmentType: null,
            postedAt:
              Number.isFinite(postedTs) && postedTs > 0
                ? new Date(postedTs * 1_000).toISOString()
                : null,
            salaryText: null,
            explicitSeniority: null,
            payload: job,
          };
        }),
      )),
    );
  }
  const result = collectionResult(source, jobs, {
    coverageStatus: collection.coverageStatus,
    expectedJobs: collection.expectedTotal,
    pagesFetched: collection.pagesFetched,
    pageSize,
    stopReason: collection.stopReason,
  });
  // Eightfold search pagination audits the complete Vietnam inventory. Every
  // position receives a full detail request before deterministic classification.
  result.audit.rawJobsFetched = collection.rawItemsFetched;
  result.audit.uniqueJobsFetched = positions.length;
  result.audit.duplicateJobs = Math.max(
    0,
    collection.rawItemsFetched - positions.length,
  );
  result.audit.coverageStatus = collection.coverageStatus;
  result.audit.stopReason = collection.stopReason;
  result.audit.deactivationAllowed = allowsMissingJobDeactivation(
    source.completeSnapshot,
    result.audit.coverageStatus,
  );
  return result;
}

async function fetchJobicy(source: SourceDefinition) {
  const payload = record(
    await fetchJson("https://jobicy.com/api/v2/remote-jobs?count=50&geo=apac"),
  );
  const jobs = asArray(payload.jobs).map((job): RawJob => ({
    sourceId: source.id,
    companyId: source.companyId ?? null,
    externalId: String(job.id ?? ""),
    sourceUrl: text(job.url),
    title: text(job.jobTitle),
    companyName: text(job.companyName),
    companyLogoUrl: optionalText(job.companyLogo),
    descriptionHtml: text(job.jobDescription) || text(job.jobExcerpt),
    descriptionQuality: text(job.jobDescription) ? "full" : "snippet",
    locationText: text(job.jobGeo) || "Remote",
    employmentType: textList(job.jobType),
    postedAt: optionalText(job.pubDate),
    salaryText: null,
    explicitSeniority: optionalText(job.jobLevel),
    payload: job,
  }));
  return collectionResult(source, jobs, {
    coverageStatus: "partial",
    pageSize: 50,
    stopReason: "source-result-limit",
  });
}

async function fetchRemotive(source: SourceDefinition) {
  const payload = record(
    await fetchJson("https://remotive.com/api/remote-jobs?limit=100"),
  );
  const jobs = asArray(payload.jobs).map((job): RawJob => ({
    sourceId: source.id,
    companyId: source.companyId ?? null,
    externalId: String(job.id ?? ""),
    sourceUrl: text(job.url),
    title: text(job.title),
    companyName: text(job.company_name),
    companyLogoUrl: optionalText(job.company_logo),
    descriptionHtml: text(job.description),
    descriptionQuality: "full",
    locationText: text(job.candidate_required_location) || "Remote",
    employmentType: optionalText(job.job_type),
    postedAt: optionalText(job.publication_date),
    salaryText: optionalText(job.salary),
    explicitSeniority: null,
    payload: job,
  }));
  return collectionResult(source, jobs, {
    coverageStatus: "complete",
    expectedJobs:
      positiveInteger(payload["total-job-count"]) ??
      positiveInteger(payload["job-count"]),
    pageSize: 100,
    stopReason: "reported-total-reached",
  });
}

async function fetchLever(source: SourceDefinition) {
  const payload = await fetchJson(
    `https://api.lever.co/v0/postings/${source.slug}?mode=json`,
  );
  const jobs = asArray(payload).map((job): RawJob => {
    const categories = record(job.categories);
    return {
      sourceId: source.id,
      companyId: source.companyId ?? null,
      externalId: text(job.id),
      sourceUrl: text(job.hostedUrl),
      title: text(job.text),
      companyName: source.name.replace(/ Careers$/, ""),
      companyLogoUrl: null,
      descriptionHtml: [
        text(job.description),
        text(job.descriptionPlain),
        text(job.additional),
      ].join("\n"),
      descriptionQuality: "full",
      locationText: text(categories.location),
      employmentType: optionalText(categories.commitment),
      postedAt:
        typeof job.createdAt === "number"
          ? new Date(job.createdAt).toISOString()
          : null,
      salaryText: null,
      explicitSeniority: optionalText(categories.level),
      payload: job,
    };
  });
  return collectionResult(source, jobs, {
    coverageStatus: "complete",
    stopReason: "full-collection-response",
  });
}

async function fetchAshby(source: SourceDefinition) {
  const payload = record(
    await fetchJson(
      `https://api.ashbyhq.com/posting-api/job-board/${source.slug}?includeCompensation=true`,
    ),
  );
  const jobs = asArray(payload.jobs).map((job): RawJob => ({
    sourceId: source.id,
    companyId: source.companyId ?? null,
    externalId: text(job.id),
    sourceUrl: text(job.jobUrl) || text(job.applyUrl),
    title: text(job.title),
    companyName: source.name.replace(/ Careers$/, ""),
    companyLogoUrl: null,
    descriptionHtml: text(job.descriptionHtml) || text(job.descriptionPlain),
    descriptionQuality: "full",
    locationText: text(job.location),
    employmentType: optionalText(job.employmentType),
    postedAt: optionalText(job.publishedAt),
    salaryText: optionalText(record(job.compensation).compensationTierSummary),
    explicitSeniority: null,
    payload: job,
  }));
  return collectionResult(source, jobs, {
    coverageStatus: "complete",
    stopReason: "full-collection-response",
  });
}

const joobleSearches = [
  "software engineer",
  "frontend developer",
  "backend developer",
];

async function fetchJooble(source: SourceDefinition) {
  const key = Deno.env.get("JOOBLE_API_KEY");
  if (!key) return null;

  const pages = await Promise.all(
    joobleSearches.map(async (keywords) => {
      const payload = record(
        await fetchJson(`https://jooble.org/api/${key}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keywords, location: "Vietnam", page: 1 }),
        }),
      );
      return asArray(payload.jobs);
    }),
  );

  const unique = new Map<string, Record<string, unknown>>();
  for (const job of pages.flat())
    unique.set(String(job.id ?? job.link ?? ""), job);
  const jobs = [...unique.values()].map((job): RawJob => ({
    sourceId: source.id,
    companyId: source.companyId ?? null,
    externalId: String(job.id ?? job.link ?? ""),
    sourceUrl: text(job.link),
    title: text(job.title),
    companyName: text(job.company) || "Company not reported",
    companyLogoUrl: null,
    descriptionHtml: text(job.snippet),
    descriptionQuality: "snippet",
    locationText: text(job.location),
    employmentType: optionalText(job.type),
    postedAt: optionalText(job.updated),
    salaryText: optionalText(job.salary),
    explicitSeniority: null,
    payload: job,
  }));
  return collectionResult(source, jobs, {
    coverageStatus: "partial",
    pagesFetched: joobleSearches.length,
    stopReason: "first-page-per-search",
  });
}

export async function fetchSource(source: SourceDefinition) {
  const result =
    source.type === "jobicy"
      ? await fetchJobicy(source)
      : source.type === "remotive"
        ? await fetchRemotive(source)
        : source.type === "lever"
          ? await fetchLever(source)
          : source.type === "ashby"
            ? await fetchAshby(source)
            : source.type === "jooble"
              ? await fetchJooble(source)
              : source.type === "grab-rss"
                ? await fetchGrab(source)
                : source.type === "greenhouse"
                  ? await fetchGreenhouse(source)
                  : await fetchEightfold(source);

  if (!result) return null;
  const marketJobs = result.jobs.filter((job) =>
    isMarketLocation(job.locationText),
  );
  return {
    jobs: marketJobs,
    audit: {
      ...result.audit,
      marketJobsKept: uniqueCount(marketJobs),
    },
  };
}
