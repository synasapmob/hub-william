/**
 * Agent telemetry for the activities page.
 *
 * Like the library catalogue this is fixture data behind a service, so the page
 * reads one shape now and the same shape once a telemetry table exists.
 */

export type ActivityMetricFilter =
  "All" | "Runs" | "Tokens" | "Tool Calls" | "Errors";

export const ACTIVITY_METRIC_FILTERS: readonly ActivityMetricFilter[] = [
  "All",
  "Runs",
  "Tokens",
  "Tool Calls",
  "Errors",
];

/** Five steps, matching the five shades the heatmap legend shows. */
export type ActivityIntensity = 0 | 1 | 2 | 3 | 4;

export interface DayActivity {
  /** `YYYY-MM-DD`. */
  date: string;
  /** 0 (Sunday) to 6 (Saturday), in UTC. */
  dayOfWeek: number;
  /** 0 to 51, counting from the oldest week on the left. */
  weekIndex: number;
  intensity: ActivityIntensity;
  runs: number;
  tokens: number;
  toolCalls: number;
  errors: number;
  cost: number;
}

export type ActivityCategory =
  "completion" | "research" | "review" | "test" | "error";

export interface ActivityTimelineEntry {
  id: string;
  agentName: string;
  action: string;
  timeAgo: string;
  tokenDelta: string;
  category: ActivityCategory;
  targetBranch: string;
  duration: string;
}

export interface ActivitySummaryStats {
  agentRuns: number;
  tokensUsed: string;
  toolCalls: number;
  estimatedCost: string;
  activeAgents: number;
  successRate: string;
}

const summaryStats: ActivitySummaryStats = {
  agentRuns: 2538,
  tokensUsed: "24.8M",
  toolCalls: 8421,
  estimatedCost: "$72.42",
  activeAgents: 6,
  successRate: "99.4%",
};

const timelineEntries: ActivityTimelineEntry[] = [
  {
    id: "tl-1",
    agentName: "Frontend Agent",
    action:
      "Completed task: Refactored AgentCanvas viewport and SVG connection curves",
    timeAgo: "Today, 10:42 AM",
    tokenDelta: "+84k tokens",
    category: "completion",
    targetBranch: "feat/canvas-redesign",
    duration: "18.4s",
  },
  {
    id: "tl-2",
    agentName: "Research Agent",
    action:
      "Completed research: Synthesized LanceDB vs pgvector benchmark papers",
    timeAgo: "2 hours ago",
    tokenDelta: "+42k tokens",
    category: "research",
    targetBranch: "docs/memory-architecture",
    duration: "24.1s",
  },
  {
    id: "tl-3",
    agentName: "Code Review Agent",
    action:
      "Reviewed pull request: Validated 14 files, approved with 0 warnings",
    timeAgo: "Yesterday, 4:15 PM",
    tokenDelta: "+18k tokens",
    category: "review",
    targetBranch: "pull/182",
    duration: "9.2s",
  },
  {
    id: "tl-4",
    agentName: "Auto Test Hook",
    action: "Ran test suite: 48 passed, 0 failed, 98.6% code coverage verified",
    timeAgo: "Yesterday, 3:58 PM",
    tokenDelta: "+6.2k tokens",
    category: "test",
    targetBranch: "main",
    duration: "4.1s",
  },
  {
    id: "tl-5",
    agentName: "Frontend Agent",
    action:
      "Component generation: Created ResourceDetail side panel and review stars",
    timeAgo: "Sep 3, 2026",
    tokenDelta: "+62k tokens",
    category: "completion",
    targetBranch: "feat/library-details",
    duration: "15.6s",
  },
  {
    id: "tl-6",
    agentName: "Git Commit Linter",
    action: "Conventional commit enforcement: Verified commit SHA 8b4f129",
    timeAgo: "Sep 2, 2026",
    tokenDelta: "+1.4k tokens",
    category: "review",
    targetBranch: "main",
    duration: "1.2s",
  },
];

const HEATMAP_WEEKS = 52;
const HEATMAP_DAYS = HEATMAP_WEEKS * 7;

/**
 * The fixture year ends on a fixed date rather than on today.
 *
 * A generated graph that silently shifts every midnight cannot be compared to
 * yesterday's screenshot, and the month labels below the header are positioned
 * against this exact window.
 */
const HEATMAP_END_DATE = "2026-09-05T12:00:00Z";

/** Descending `[exceeded value, resulting shade]` steps, one scale per filter. */
const intensityScales: Record<
  ActivityMetricFilter,
  {
    metric: (day: Omit<DayActivity, "intensity">) => number;
    steps: readonly (readonly [number, ActivityIntensity])[];
  }
> = {
  All: {
    metric: (day) => day.runs,
    steps: [
      [22, 4],
      [14, 3],
      [6, 2],
      [0, 1],
    ],
  },
  Runs: {
    metric: (day) => day.runs,
    steps: [
      [25, 4],
      [15, 3],
      [7, 2],
      [0, 1],
    ],
  },
  Tokens: {
    metric: (day) => day.tokens,
    steps: [
      [200_000, 4],
      [120_000, 3],
      [50_000, 2],
      [0, 1],
    ],
  },
  "Tool Calls": {
    metric: (day) => day.toolCalls,
    steps: [
      [60, 4],
      [35, 3],
      [12, 2],
      [0, 1],
    ],
  },
  // Errors skip shade 1 on purpose: one error is already worth the amber cell,
  // and a shade nothing can reach would leave a dead swatch in the legend.
  Errors: {
    metric: (day) => day.errors,
    steps: [
      [2, 4],
      [1, 3],
      [0, 2],
    ],
  },
};

function resolveIntensity(
  day: Omit<DayActivity, "intensity">,
  filter: ActivityMetricFilter,
): ActivityIntensity {
  const scale = intensityScales[filter];
  const value = scale.metric(day);

  return scale.steps.find(([exceeded]) => value > exceeded)?.[1] ?? 0;
}

/**
 * A year of daily agent telemetry, generated from a fixed seed.
 *
 * The clustering is deliberate rather than uniform noise — weekdays outwork
 * weekends and every few weeks is a sprint — because a flat random field reads
 * as a texture, not as a team.
 */
function yearOfActivity(filter: ActivityMetricFilter): DayActivity[] {
  const endDate = new Date(HEATMAP_END_DATE);
  const startDate = new Date(endDate);
  startDate.setDate(endDate.getDate() - (HEATMAP_DAYS - 1));

  let seed = 42;
  function pseudoRandom() {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  }

  const days: DayActivity[] = [];

  for (let index = 0; index < HEATMAP_DAYS; index += 1) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + index);

    const dayOfWeek = currentDate.getUTCDay();
    const weekIndex = Math.floor(index / 7);
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;
    const sprintBoost = weekIndex % 4 === 1 || weekIndex % 6 === 2 ? 1.4 : 1.0;
    const isActiveDay = pseudoRandom() < (isWeekend ? 0.35 : 0.85);

    let runs = 0;
    let tokens = 0;
    let toolCalls = 0;
    let errors = 0;
    let cost = 0;

    if (isActiveDay) {
      const volumeFactor = pseudoRandom() * sprintBoost;
      runs = Math.floor(volumeFactor * (isWeekend ? 8 : 28)) + 1;
      tokens = Math.floor(runs * (4000 + pseudoRandom() * 9000));
      toolCalls = Math.floor(runs * (2 + pseudoRandom() * 3.5));
      errors = pseudoRandom() > 0.88 ? Math.floor(pseudoRandom() * 3) : 0;
      cost = Number(((tokens / 1_000_000) * 3.2).toFixed(2));
    }

    const day = {
      date: currentDate.toISOString().split("T")[0],
      dayOfWeek,
      weekIndex,
      runs,
      tokens,
      toolCalls,
      errors,
      cost,
    };

    days.push({ ...day, intensity: resolveIntensity(day, filter) });
  }

  return days;
}

/** The same year, sliced into the 52 columns the heatmap draws. */
function weeksOfActivity(filter: ActivityMetricFilter): DayActivity[][] {
  const days = yearOfActivity(filter);

  return Array.from({ length: HEATMAP_WEEKS }, (_, week) =>
    days.slice(week * 7, (week + 1) * 7),
  );
}

const activitiesService = {
  summaryStats,
  timelineEntries,
  weeksOfActivity,
};

export default activitiesService;
