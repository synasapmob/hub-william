export interface JobCrawlerOption {
  value: string;
  label: string;
}

/** The job boards `--sources` knows, in the order the tool reads them. */
export const JOB_CRAWLER_BOARDS: readonly JobCrawlerOption[] = [
  { value: "itviec", label: "ITviec" },
  { value: "topcv", label: "TopCV" },
  { value: "careerviet", label: "CareerViet" },
  { value: "indeed", label: "Indeed" },
];

/** Companies whose own career page the tool reads. */
export const JOB_CRAWLER_CAREER_PAGES: readonly JobCrawlerOption[] = [
  { value: "worldquant", label: "WorldQuant" },
  { value: "topicus", label: "Topicus Vietnam" },
  { value: "symbotic", label: "Symbotic" },
  { value: "lecle", label: "Lecle Vietnam" },
  { value: "luce", label: "Luce" },
  { value: "axon", label: "Axon" },
];

export const JOB_CRAWLER_SITES: readonly JobCrawlerOption[] = [
  ...JOB_CRAWLER_BOARDS,
  ...JOB_CRAWLER_CAREER_PAGES,
];

/** The role groups of the sheet's `role` column; `--role` accepts them by name. */
export const JOB_CRAWLER_ROLES: readonly JobCrawlerOption[] = [
  "Software Engineer",
  "Fullstack",
  "Frontend",
  "Backend",
  "Mobile",
  "Product Owner",
  "Product Manager",
  "Solution Engineer",
].map((role) => ({ value: role, label: role }));

/** The places as the sheet's `location` column writes them; `--location` reads HN and HCM as the cities. */
export const JOB_CRAWLER_LOCATIONS: readonly JobCrawlerOption[] = [
  { value: "HN", label: "HN" },
  { value: "HCM", label: "HCM" },
  { value: "Da Nang", label: "DA NANG" },
  { value: "Remote", label: "REMOTE" },
];

/** `--date`: how many days back a job may have been posted or edited; 0 keeps every date. */
export const JOB_CRAWLER_DAYS: readonly JobCrawlerOption[] = [
  { value: "30", label: "30 days" },
  { value: "60", label: "60 days" },
  { value: "90", label: "90 days" },
  { value: "0", label: "Any date" },
];

/** Where the tool saves the spreadsheet when no `--output-dir` is given. */
export const JOB_CRAWLER_DEFAULT_OUTPUT_DIR = "~/Documents/jobs";

export interface JobCrawlerChoices {
  /** The sites picked; none means every site. */
  sources: readonly string[];
  /** The roles picked; none means any role. */
  roles: readonly string[];
  /** The places picked; none means anywhere. */
  locations: readonly string[];
  /** How far back a job may be dated; none means the tool's own default, the last 30 days. */
  days: number | null;
  /** The folder typed; empty means the tool's own default folder. */
  outputDir: string;
}

export const JOB_CRAWLER_INITIAL_CHOICES: JobCrawlerChoices = {
  sources: [],
  roles: [],
  locations: [],
  days: null,
  outputDir: "",
};

/**
 * `selected` with `value` added, or removed when it was there, kept in the order
 * of `options` so the command reads the same whatever order the tags were
 * clicked in.
 */
export function toggledChoice(
  options: readonly JobCrawlerOption[],
  selected: readonly string[],
  value: string,
) {
  return options
    .map((option) => option.value)
    .filter((candidate) =>
      candidate === value
        ? !selected.includes(candidate)
        : selected.includes(candidate),
    );
}

/** A shell word that reads as the value: plain text as it is, anything else in single quotes. */
function shellWord(value: string) {
  return /^[\w@%+=:,./~-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command that runs the published script with the choices made. Only what
 * was picked or typed is written, so picking nothing gives the shortest
 * command, and the tool then collects everything with its own defaults.
 */
export function jobCrawlerCommand(
  scriptUrl: string,
  choices: JobCrawlerChoices,
) {
  const outputDir = choices.outputDir.trim();
  const options = [
    outputDir ? `--output-dir=${shellWord(outputDir)}` : "",
    choices.sources.length > 0 ? `--sources=${choices.sources.join(",")}` : "",
    choices.roles.length > 0
      ? `--role=${shellWord(choices.roles.join(","))}`
      : "",
    choices.locations.length > 0
      ? `--location=${shellWord(choices.locations.join(","))}`
      : "",
    choices.days === null ? "" : `--date=${choices.days}`,
  ].filter(Boolean);

  const command = `curl -fsSL ${scriptUrl} | python3`;

  return options.length > 0 ? `${command} - ${options.join(" ")}` : command;
}
