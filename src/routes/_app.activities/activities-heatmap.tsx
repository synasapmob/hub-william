import Flex from "@/components/ui/flex";
import { useState } from "react";
import { tv } from "tailwind-variants";

import activitiesService, {
  ACTIVITY_METRIC_FILTERS,
  type ActivityIntensity,
  type ActivityMetricFilter,
  type DayActivity,
} from "@/utils/utils.activities";

/**
 * Indigo for volume, amber-into-rose for errors.
 *
 * The two scales are the same five steps of one control, so they are variants
 * of one table: a second table could drift a shade and make a busy week and a
 * broken week look alike.
 */
const heatCell = tv({
  base: "size-2.75 rounded-[2.5px] transition-colors duration-150",
  variants: {
    tone: { volume: "", errors: "" },
    intensity: {
      0: "bg-zinc-800 hover:ring-1 hover:ring-zinc-600",
      1: "",
      2: "",
      3: "",
      4: "",
    },
  },
  compoundVariants: [
    {
      tone: "volume",
      intensity: 1,
      class: "bg-indigo-950 hover:ring-1 hover:ring-indigo-800",
    },
    {
      tone: "volume",
      intensity: 2,
      class: "bg-indigo-800 hover:ring-1 hover:ring-indigo-600",
    },
    {
      tone: "volume",
      intensity: 3,
      class: "bg-indigo-500 hover:ring-1 hover:ring-indigo-600",
    },
    {
      tone: "volume",
      intensity: 4,
      class: "bg-indigo-400 hover:ring-1 hover:ring-indigo-300",
    },
    {
      tone: "errors",
      intensity: 1,
      class: "bg-amber-900 hover:ring-1 hover:ring-amber-700",
    },
    {
      tone: "errors",
      intensity: 2,
      class: "bg-amber-700 hover:ring-1 hover:ring-amber-500",
    },
    {
      tone: "errors",
      intensity: 3,
      class: "bg-rose-600 hover:ring-1 hover:ring-rose-500",
    },
    {
      tone: "errors",
      intensity: 4,
      class: "bg-rose-400 hover:ring-1 hover:ring-rose-300",
    },
  ],
});

const filterPill = tv({
  base: "rounded-lg px-2.5 py-1 font-mono text-xs font-medium transition-all focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
  variants: {
    active: {
      true: "bg-primary text-primary-foreground shadow-xs",
      false: "text-muted-foreground hover:text-foreground",
    },
  },
});

/**
 * Thirteen labels across fifty-two columns, one per month boundary the window
 * crosses. They are evenly spread rather than pinned to the exact week each
 * month starts: a label sitting two columns off is easier to read than labels
 * that collide.
 */
const monthLabels = [
  "Sep",
  "Oct",
  "Nov",
  "Dec",
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
];

const legendLevels: ActivityIntensity[] = [0, 1, 2, 3, 4];

interface HoveredDay {
  day: DayActivity;
  x: number;
  y: number;
}

interface ActivitiesHeatmapProps {
  filter: ActivityMetricFilter;
  onFilterChange: (filter: ActivityMetricFilter) => void;
}

export default function ActivitiesHeatmap({
  filter,
  onFilterChange,
}: ActivitiesHeatmapProps) {
  const [hovered, setHovered] = useState<HoveredDay | null>(null);

  const weeks = activitiesService.weeksOfActivity(filter);
  const days = weeks.flat();
  const tone = filter === "Errors" ? "errors" : "volume";
  const totalRuns = days.reduce((total, day) => total + day.runs, 0);
  const totalTokens = days.reduce((total, day) => total + day.tokens, 0);

  return (
    <div className="relative rounded-2xl border border-border bg-card p-5 text-left shadow-xs select-none">
      <div className="flex flex-col justify-between gap-4 border-b border-border pb-4 sm:flex-row sm:items-center">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            {filter === "Tokens"
              ? `${(totalTokens / 1_000_000).toFixed(1)}M tokens consumed`
              : `${totalRuns.toLocaleString()} agent runs in the last year`}
          </h3>

          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
            Sep 2025 – Sep 2026 · daily agent telemetry
          </p>
        </div>

        <div className="flex items-center gap-1 self-start overflow-x-auto rounded-xl border border-border bg-muted p-0.5 sm:self-auto">
          {ACTIVITY_METRIC_FILTERS.map((option) => (
            <button
              key={option}
              type="button"
              className={filterPill({ active: filter === option })}
              onClick={() => onFilterChange(option)}
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto pt-1 pb-2">
        <div className="min-w-190">
          {/* Each label is exactly four columns wide — one week is 11px of cell
              plus a 3px gap — so the row stays pinned to the grid below it
              rather than stretching across whatever width the card happens to
              have and drifting a month out by the right-hand edge. */}
          <div className="flex pb-1.5 pl-6 font-mono text-[10px] text-muted-foreground">
            {monthLabels.map((label, index) => (
              <p key={`${label}-${index}`} className="w-14 shrink-0 text-left">
                {label}
              </p>
            ))}
          </div>

          <div className="flex items-start">
            <div className="flex h-22 flex-col justify-between pr-2 font-mono text-[9px] text-muted-foreground">
              <p>Mon</p>
              <p>Wed</p>
              <p>Fri</p>
            </div>

            <div className="flex flex-1 gap-0.75">
              {weeks.map((week, weekIndex) => (
                <div key={weekIndex} className="flex flex-col gap-0.75">
                  {week.map((day) => (
                    <div
                      key={day.date}
                      className={heatCell({ intensity: day.intensity, tone })}
                      onMouseEnter={(event) => {
                        const rect =
                          event.currentTarget.getBoundingClientRect();

                        setHovered({
                          day,
                          x: rect.left + rect.width / 2,
                          y: rect.top,
                        });
                      }}
                      onMouseLeave={() => setHovered(null)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
            <p className="font-mono text-[11px] text-muted-foreground">
              Active telemetry channel:{" "}
              <span className="text-foreground">cluster-asia-prod</span>
            </p>

            <Flex className="items-center gap-2 font-mono text-xs">
              <span className="text-[10px]">Less</span>

              <div className="flex gap-1">
                {legendLevels.map((level) => (
                  <div
                    key={level}
                    className={heatCell({
                      intensity: level,
                      tone,
                      class: "size-2.5 rounded-xs",
                    })}
                  />
                ))}
              </div>

              <span className="text-[10px]">More</span>
            </Flex>
          </div>
        </div>
      </div>

      {hovered ? (
        <div
          style={{ left: `${hovered.x}px`, top: `${hovered.y - 8}px` }}
          className="pointer-events-none fixed z-50 min-w-50 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-popover p-2.5 text-left text-popover-foreground shadow-xl"
        >
          <div className="mb-1.5 flex justify-between border-b border-border pb-1 font-mono text-[10px] text-muted-foreground">
            <span>
              {new Date(hovered.day.date).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
              })}
            </span>
            <span className="text-indigo-400">
              Level {hovered.day.intensity}
            </span>
          </div>

          <dl className="space-y-1 font-mono text-xs">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Agent runs</dt>
              <dd className="font-medium">{hovered.day.runs}</dd>
            </div>

            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tokens</dt>
              <dd className="font-medium">
                {(hovered.day.tokens / 1000).toFixed(1)}k
              </dd>
            </div>

            <div className="flex justify-between">
              <dt className="text-muted-foreground">Tool calls</dt>
              <dd className="font-medium">{hovered.day.toolCalls}</dd>
            </div>

            {hovered.day.errors > 0 ? (
              <div className="flex justify-between text-rose-400">
                <dt>Errors</dt>
                <dd className="font-medium">{hovered.day.errors}</dd>
              </div>
            ) : null}

            <div className="flex justify-between border-t border-border pt-1">
              <dt className="text-muted-foreground">Est. cost</dt>
              <dd className="font-medium text-emerald-400">
                ${hovered.day.cost.toFixed(2)}
              </dd>
            </div>
          </dl>
        </div>
      ) : null}
    </div>
  );
}
