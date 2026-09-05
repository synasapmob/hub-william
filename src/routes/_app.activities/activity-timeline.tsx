import {
  CheckCheck,
  CheckCircle2,
  Clock,
  FileSearch,
  GitPullRequest,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import type {
  ActivityCategory,
  ActivityTimelineEntry,
} from "@/services/activities";

const categoryIcons: Record<ActivityCategory, LucideIcon> = {
  completion: CheckCircle2,
  research: FileSearch,
  review: GitPullRequest,
  test: CheckCheck,
  error: Terminal,
};

interface ActivityTimelineProps {
  entries: ActivityTimelineEntry[];
}

export default function ActivityTimeline({ entries }: ActivityTimelineProps) {
  return (
    <div className="rounded-2xl border border-zinc-200/90 bg-card p-5 text-left shadow-xs">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-3">
        <div>
          <h3 className="text-sm font-semibold tracking-tight">
            Recent activity
          </h3>

          <p className="mt-0.5 font-mono text-[11px] text-slate-400">
            Chronological agent execution logs
          </p>
        </div>

        <p className="rounded border border-border bg-zinc-50 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
          Stream live
        </p>
      </div>

      <ol className="relative space-y-6 pl-6 before:absolute before:top-2 before:bottom-2 before:left-2 before:w-px before:bg-border">
        {entries.map((entry) => {
          const CategoryIcon = categoryIcons[entry.category];

          return (
            <li key={entry.id} className="group relative">
              <div className="absolute top-0.5 -left-6 grid size-4 place-items-center rounded-full border border-zinc-300 bg-card shadow-xs transition-colors group-hover:border-indigo-500">
                <CategoryIcon
                  aria-hidden="true"
                  className="size-2.5 text-zinc-600 transition-colors group-hover:text-indigo-600"
                />
              </div>

              <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-baseline">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-mono text-xs font-semibold">
                    {entry.agentName}
                  </p>

                  <p className="rounded border border-zinc-200/80 bg-zinc-100 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                    {entry.targetBranch}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3 font-mono text-[11px] text-slate-400">
                  <p className="font-medium text-indigo-600">
                    {entry.tokenDelta}
                  </p>
                  <p>{entry.timeAgo}</p>
                </div>
              </div>

              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {entry.action}
              </p>

              <p className="mt-1 flex items-center gap-1 font-mono text-[10px] text-slate-400">
                <Clock aria-hidden="true" className="size-2.5" />
                Execution time: {entry.duration}
              </p>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
