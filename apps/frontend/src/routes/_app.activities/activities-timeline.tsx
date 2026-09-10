import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
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
} from "@/utils/utils.activities";

const categoryIcons: Record<ActivityCategory, LucideIcon> = {
  completion: CheckCircle2,
  research: FileSearch,
  review: GitPullRequest,
  test: CheckCheck,
  error: Terminal,
};

interface ActivitiesTimelineProps {
  entries: ActivityTimelineEntry[];
}

export default function ActivitiesTimeline({
  entries,
}: ActivitiesTimelineProps) {
  return (
    <div className="rounded-2xl border border-zinc-200/90 bg-card p-5 text-left shadow-xs">
      <Flex className="items-center justify-between gap-2 flex-wrap mb-4 border-b border-zinc-100 pb-3">
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
      </Flex>

      <ol className="relative space-y-6 pl-6 before:absolute before:left-2 before:w-px before:bg-border before:inset-y-2">
        {entries.map((entry) => {
          const CategoryIcon = categoryIcons[entry.category];

          return (
            <li key={entry.id} className="group relative">
              <Center className="absolute top-0.5 -left-6 size-4 rounded-full border border-zinc-300 bg-card shadow-xs transition-colors group-hover:border-indigo-500">
                <CategoryIcon
                  aria-hidden="true"
                  className="size-2.5 text-zinc-600 transition-colors group-hover:text-indigo-600"
                />
              </Center>

              <div className="flex flex-col justify-between gap-1 sm:flex-row sm:items-baseline">
                <Flex className="items-center gap-2 flex-wrap">
                  <p className="font-mono text-xs font-semibold">
                    {entry.agentName}
                  </p>

                  <p className="rounded border border-zinc-200/80 bg-zinc-100 px-1.5 py-px font-mono text-[10px] text-muted-foreground">
                    {entry.targetBranch}
                  </p>
                </Flex>

                <Flex className="items-center gap-3 shrink-0 font-mono text-[11px] text-slate-400">
                  <p className="font-medium text-indigo-600">
                    {entry.tokenDelta}
                  </p>
                  <p>{entry.timeAgo}</p>
                </Flex>
              </div>

              <p className="mt-1 text-muted-foreground text-xs/relaxed">
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
