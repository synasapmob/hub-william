import { ChevronDown, Users, X } from "lucide-react";
import { tv } from "tailwind-variants";

import AgentsProviderIcon from "@/components/agents-provider-icon";
import AgentsUsageMetrics from "@/components/agents-usage-metrics";
import Flex from "@/components/ui/flex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import agentPoolsService, { type AgentPool } from "@/services/agent-pools";
import {
  agentPoolAccess,
  agentPoolAccessLabels,
  agentPoolAvailabilityLabel,
  agentProviderShowsUsage,
} from "@/utils/utils.agent-pools";

import AgentsAvatarStack from "./agents-avatar-stack";

const memberSection = tv({
  base: "group",
  variants: { afterUsage: { true: "border-t border-zinc-100 pt-4" } },
});

interface AgentsPoolCardProps {
  currentUsername: string | null;
  onCheckRequests: (pool: AgentPool) => void;
  onClose: () => void;
  onRequestJoin: (pool: AgentPool) => void;
  pool: AgentPool;
}

export default function AgentsPoolCard({
  currentUsername,
  onCheckRequests,
  onClose,
  onRequestJoin,
  pool,
}: AgentsPoolCardProps) {
  const showUsage = agentProviderShowsUsage(pool.agent);
  const access = agentPoolAccess(pool, currentUsername);
  const actionDisabled = access !== "owner" && access !== "request";

  return (
    <article
      aria-label={`${pool.agent} account ${pool.accountLabel} details`}
      className="min-w-0 overflow-hidden bg-white"
    >
      <header className="border-b border-zinc-100 p-5">
        <Flex className="items-start justify-between gap-3">
          <Flex className="min-w-0 items-center gap-2.5">
            <AgentsProviderIcon provider={pool.agent} />

            <div className="min-w-0">
              <Flex className="flex-wrap items-center gap-2">
                <p className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                  {pool.agent}
                </p>

                <Badge
                  variant="secondary"
                  className="text-[9px] font-normal uppercase"
                >
                  {pool.plan}
                </Badge>
              </Flex>

              <h3 className="mt-0.5 truncate font-mono text-xs font-semibold">
                {pool.accountLabel}
              </h3>
            </div>
          </Flex>

          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="-mt-1 -mr-1 shrink-0 text-zinc-400"
            onClick={onClose}
          >
            <X aria-hidden="true" className="size-4" />
            <span className="sr-only">
              Close {pool.agent} account {pool.accountLabel} details
            </span>
          </Button>
        </Flex>
      </header>

      <div className="space-y-5 p-5">
        {showUsage ? (
          <AgentsUsageMetrics provider={pool.agent} usage={pool.usage} />
        ) : null}

        <details className={memberSection({ afterUsage: showUsage })}>
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 rounded-sm text-xs focus-visible:outline-2 focus-visible:outline-indigo-500 [&::-webkit-details-marker]:hidden">
            <span className="inline-flex items-center gap-2">
              <Users aria-hidden="true" className="size-3.5 text-zinc-400" />
              Members · {pool.members.length}
            </span>
            <ChevronDown
              aria-hidden="true"
              className="size-3.5 text-zinc-400 group-open:rotate-180"
            />
          </summary>

          <ul className="mt-4 space-y-3">
            {pool.members.map((member) => (
              <li
                key={member.username}
                className="flex items-center justify-between gap-3 text-xs"
              >
                <div className="min-w-0">
                  <p className="truncate font-medium">{member.username}</p>

                  <p className="mt-1 text-[10px] text-zinc-400">
                    Joined{" "}
                    <time dateTime={member.joinedAt}>
                      {agentPoolsService.createdLabel(member.joinedAt)}
                    </time>
                  </p>
                </div>

                {member.username === pool.owner.username ? (
                  <Badge variant="outline" className="text-[9px] font-normal">
                    Owner
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        </details>

        <dl className="space-y-2 border-t border-zinc-100 pt-4 text-[11px]">
          <Flex className="items-center justify-between gap-3">
            <dt className="text-zinc-400">Owner</dt>

            <dd className="truncate">{pool.owner.username}</dd>
          </Flex>

          <Flex className="items-center justify-between gap-3">
            <dt className="text-zinc-400">Connected</dt>

            <dd>
              <time dateTime={pool.createdAt}>
                {agentPoolsService.createdLabel(pool.createdAt)}
              </time>
            </dd>
          </Flex>

          <Flex className="items-center justify-between gap-3">
            <dt className="text-zinc-400">Status</dt>

            <dd>{agentPoolAvailabilityLabel(pool)}</dd>
          </Flex>
        </dl>
      </div>

      <footer className="flex items-center justify-between gap-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3">
        <AgentsAvatarStack people={pool.members} />

        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={actionDisabled}
          onClick={() =>
            access === "owner" ? onCheckRequests(pool) : onRequestJoin(pool)
          }
        >
          {access === "owner"
            ? "Manage"
            : access === "request"
              ? "Request Join"
              : agentPoolAccessLabels[access]}
        </Button>
      </footer>
    </article>
  );
}
