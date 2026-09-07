import { Cpu, DollarSign, GitCommit, Zap, type LucideIcon } from "lucide-react";

import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import type { ActivitySummaryStats } from "@/utils/utils.activities";

/** One glyph colour per metric, so the four tiles stay tellable apart at a glance. */
const metricIcon = tv({
  base: "size-3.5",
  variants: {
    tone: {
      runs: "text-indigo-400",
      tokens: "text-amber-400",
      calls: "text-emerald-400",
      cost: "text-muted-foreground",
    },
  },
});

interface SummaryMetric {
  label: string;
  value: string;
  detail: string;
  icon: LucideIcon;
  tone: "runs" | "tokens" | "calls" | "cost";
}

function summaryMetrics(stats: ActivitySummaryStats): SummaryMetric[] {
  return [
    {
      label: "Agent runs",
      value: stats.agentRuns.toLocaleString(),
      detail: "+12.4% this month",
      icon: Cpu,
      tone: "runs",
    },
    {
      label: "Tokens used",
      value: stats.tokensUsed,
      detail: "3.2M prompt / 21.6M gen",
      icon: Zap,
      tone: "tokens",
    },
    {
      label: "Tool calls",
      value: stats.toolCalls.toLocaleString(),
      detail: "4.2 calls / run avg",
      icon: GitCommit,
      tone: "calls",
    },
    {
      label: "Estimated cost",
      value: stats.estimatedCost,
      detail: "$0.028 / run efficiency",
      icon: DollarSign,
      tone: "cost",
    },
  ];
}

interface ActivitiesSummaryProps {
  stats: ActivitySummaryStats;
}

export default function ActivitiesSummary({ stats }: ActivitiesSummaryProps) {
  return (
    <dl className="grid grid-cols-2 gap-3 text-left md:grid-cols-4">
      {summaryMetrics(stats).map((metric) => {
        const Icon = metric.icon;

        return (
          <div
            key={metric.label}
            className="rounded-xl border border-border bg-card p-3.5 shadow-xs"
          >
            <Flex className="items-center justify-between gap-2 mb-1">
              <dt className="font-mono text-[11px] font-medium tracking-wider text-muted-foreground uppercase">
                {metric.label}
              </dt>

              <div className="rounded-md border border-border bg-muted p-1">
                <Icon
                  aria-hidden="true"
                  className={metricIcon({ tone: metric.tone })}
                />
              </div>
            </Flex>

            <dd className="font-mono text-xl font-bold tracking-tight">
              {metric.value}
            </dd>

            <dd className="mt-0.5 font-mono text-[10px] text-muted-foreground">
              {metric.detail}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
