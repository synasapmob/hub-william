import { ChevronDown, CircleAlert, Clock3, Users, X } from "lucide-react";

import Flex from "@/components/ui/flex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import agentPoolsService, { type AgentPool } from "@/services/agent-pools";
import {
  agentPoolAccess,
  agentPoolAccessLabels,
  agentPoolAvailabilityLabels,
  agentPoolRemaining,
  agentPoolUsageValue,
  agentPoolWarning,
} from "@/utils/utils.agent-pools";

import AgentsAvatarStack from "./agents-avatar-stack";
import AgentsProviderIcon from "./agents-provider-icon";

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
  const access = agentPoolAccess(pool, currentUsername);
  const warning = agentPoolWarning(pool);
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
        {warning ? (
          <Flex className="items-start gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800">
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 size-3.5 shrink-0"
            />

            <div>
              <p className="font-medium">{warning}</p>

              {pool.availability.retryAt ? (
                <p className="mt-1">
                  Retry after{" "}
                  <time dateTime={pool.availability.retryAt}>
                    {new Date(pool.availability.retryAt).toLocaleString()}
                  </time>
                </p>
              ) : null}
            </div>
          </Flex>
        ) : null}

        <section aria-label="Account usage" className="space-y-3">
          <h4 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
            Usage & limits
          </h4>

          {pool.usage.length ? (
            <dl className="space-y-4">
              {pool.usage.map((metric) => {
                const remaining = agentPoolRemaining(metric);
                return (
                  <div key={metric.label}>
                    <Flex className="items-center justify-between gap-3 text-xs">
                      <dt className="text-zinc-600">{metric.label}</dt>

                      <dd className="text-right font-mono font-medium">
                        {agentPoolUsageValue(metric)}
                      </dd>
                    </Flex>

                    {remaining !== null ? (
                      <Progress
                        className="mt-2"
                        aria-label={`${metric.label} remaining`}
                        value={remaining}
                      />
                    ) : null}

                    {metric.detail ? (
                      <Flex className="mt-2 items-start gap-1.5 text-[10px]/relaxed text-zinc-500">
                        <Clock3
                          aria-hidden="true"
                          className="mt-0.5 size-3 shrink-0"
                        />

                        <p>{metric.detail}</p>
                      </Flex>
                    ) : null}
                  </div>
                );
              })}
            </dl>
          ) : (
            <p className="text-xs text-zinc-500">
              {pool.agent} has not reported usage for this account yet.
            </p>
          )}
        </section>

        <details className="group border-t border-zinc-100 pt-4">
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

            <dd>{agentPoolAvailabilityLabels[pool.availability.status]}</dd>
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
