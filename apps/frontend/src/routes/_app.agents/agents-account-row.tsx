import { useState } from "react";
import { tv } from "tailwind-variants";
import Flex from "@/components/ui/flex";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentPool } from "@/services/agent-pools";
import {
  agentPoolAccess,
  agentPoolAccessLabels,
  agentPoolTokenDetail,
  agentPoolUsageIssues,
  agentPoolWarning,
  agentProviderShowsUsage,
} from "@/utils/utils.agent-pools";

import AgentsAvatarStack from "./agents-avatar-stack";

const account = tv({
  base: "relative z-10 grid w-full min-w-0 items-center gap-3 rounded-xl border bg-white p-4 text-left shadow-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-500 sm:grid-cols-[minmax(0,1fr)_auto]",
  variants: {
    selected: {
      true: "border-indigo-300 ring-1 ring-indigo-100",
      false: "border-zinc-200 hover:border-zinc-400",
    },
    warning: {
      true: "border-red-300 ring-red-100 hover:border-red-400",
    },
  },
});
interface AgentsAccountRowProps {
  currentUsername: string | null;
  onOpen: (button: HTMLButtonElement) => void;
  pool: AgentPool;
  selected: boolean;
}

export default function AgentsAccountRow({
  currentUsername,
  onOpen,
  pool,
  selected,
}: AgentsAccountRowProps) {
  const showUsage = agentProviderShowsUsage(pool.agent);
  const [tooltipOpen, setTooltipOpen] = useState(false);
  const warning = agentPoolWarning(pool);
  const hasIssue = Boolean(warning) || agentPoolUsageIssues(pool).length > 0;
  const tokens = showUsage ? agentPoolTokenDetail(pool) : undefined;
  const access = agentPoolAccess(pool, currentUsername);

  return (
    <Tooltip
      open={showUsage && tooltipOpen}
      onOpenChange={(open) => setTooltipOpen(showUsage && open)}
    >
      <TooltipTrigger asChild>
        <button
          type="button"
          className={account({ selected, warning: hasIssue })}
          data-agent-node={`account:${pool.id}`}
          aria-label={`Open ${pool.agent} account ${pool.accountLabel}`}
          aria-controls={selected ? `agent-info-${pool.id}` : undefined}
          aria-expanded={selected}
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <div className="min-w-0">
            <p className="min-w-0 truncate font-mono text-xs font-semibold text-zinc-900">
              {pool.accountLabel}
            </p>
            <p className="mt-1 text-[11px] text-zinc-500">
              {pool.agent} · {pool.plan} · {agentPoolAccessLabels[access]}
            </p>
            {tokens ? (
              <p className="mt-2 text-[10px] text-zinc-500">{tokens}</p>
            ) : null}
          </div>

          <Flex className="items-center gap-2 sm:justify-end">
            <p className="text-[11px] text-zinc-500">Members</p>

            <AgentsAvatarStack maxVisible={3} people={pool.members} />
          </Flex>
        </button>
      </TooltipTrigger>

      {showUsage ? (
        <TooltipContent
          side="top"
          sideOffset={8}
          className="block max-w-72 space-y-2"
        >
          {pool.usage.length ? (
            pool.usage.map((item) => (
              <div key={item.label}>
                <p>
                  {item.label}: {item.value}
                </p>

                {item.detail && item.value !== "Unavailable" ? (
                  <p className="mt-0.5 text-[10px] opacity-75">{item.detail}</p>
                ) : null}
              </div>
            ))
          ) : (
            <p>Usage unavailable</p>
          )}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
