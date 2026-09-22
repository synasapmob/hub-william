import { ArrowUpRight, Check, CircleAlert } from "lucide-react";
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
  agentPoolPrimaryUsage,
  agentPoolRemaining,
  agentPoolTokenDetail,
  agentPoolUsageValue,
  agentPoolWarning,
} from "@/utils/utils.agent-pools";

const account = tv({
  slots: {
    button:
      "relative z-10 grid w-full min-w-0 items-center gap-3 rounded-xl border bg-white p-4 text-left shadow-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-500 sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.8fr)_1.5rem]",
    indicator:
      "absolute top-4 right-4 flex size-6 shrink-0 items-center justify-center rounded-full sm:static",
  },
  variants: {
    selected: {
      true: {
        button: "border-indigo-300 ring-1 ring-indigo-100",
        indicator: "bg-indigo-50 text-indigo-600",
      },
      false: {
        button: "border-zinc-200 hover:border-zinc-400",
        indicator: "bg-zinc-50 text-zinc-400",
      },
    },
  },
});
const usageBar = tv({
  base: "h-full rounded-full bg-zinc-600",
  variants: { low: { true: "bg-amber-500" } },
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
  const styles = account({ selected });
  const metric = agentPoolPrimaryUsage(pool);
  const remaining = metric ? agentPoolRemaining(metric) : null;
  const warning = agentPoolWarning(pool);
  const tokens = agentPoolTokenDetail(pool);
  const access = agentPoolAccess(pool, currentUsername);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={styles.button()}
          data-agent-node={`account:${pool.id}`}
          aria-label={`Open ${pool.agent} account ${pool.accountLabel}`}
          aria-controls={selected ? `agent-info-${pool.id}` : undefined}
          aria-expanded={selected}
          aria-haspopup="dialog"
          onClick={(event) => onOpen(event.currentTarget)}
        >
          <div className="min-w-0 pr-8 sm:pr-0">
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

          <div className="min-w-0">
            <Flex className="items-center justify-between gap-2 text-[11px]">
              <p className="text-zinc-500">{metric?.label ?? "Usage"}</p>

              <p className="font-mono font-medium text-zinc-700">
                {metric ? agentPoolUsageValue(metric) : "Unavailable"}
              </p>
            </Flex>

            {remaining !== null ? (
              <div
                aria-hidden="true"
                className="mt-2 h-1 rounded-full bg-zinc-100"
              >
                <div
                  className={usageBar({ low: remaining <= 15 })}
                  style={{ width: `${remaining}%` }}
                />
              </div>
            ) : null}
          </div>

          <span className={styles.indicator()}>
            {selected ? (
              <Check aria-hidden="true" className="size-3.5" />
            ) : (
              <ArrowUpRight aria-hidden="true" className="size-3.5" />
            )}
          </span>

          {warning ? (
            <Flex className="items-center gap-1.5 text-[11px] text-amber-700 sm:col-span-3">
              <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />

              <p>{warning}</p>
            </Flex>
          ) : null}
        </button>
      </TooltipTrigger>

      <TooltipContent
        side="top"
        sideOffset={8}
        className="block max-w-72 space-y-2"
      >
        <p className="font-medium">{pool.accountLabel}</p>

        {pool.usage.length ? (
          pool.usage.map((item) => (
            <div key={item.label}>
              <p>
                {item.label}: {item.value}
              </p>

              {item.detail ? (
                <p className="mt-0.5 text-[10px] opacity-75">{item.detail}</p>
              ) : null}
            </div>
          ))
        ) : (
          <p>Usage unavailable</p>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
