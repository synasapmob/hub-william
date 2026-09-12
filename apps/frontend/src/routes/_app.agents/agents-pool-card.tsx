import { useState, type ReactNode } from "react";
import {
  CircleGauge,
  CircleHelp,
  Clock3,
  UserRound,
  Users,
} from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@/components/ui/popover";
import agentPoolsService, {
  type AgentPool,
  type AgentPoolPerson,
  type AgentPoolShareEvidence,
  type AgentProvider,
} from "@/services/agent-pools";
import assetPath from "@/utils/utils.asset-path";

import AgentsAvatarStack from "./agents-avatar-stack";

const actionButton = tv({
  base: "w-full h-10",
  variants: {
    state: {
      accepted: "border-emerald-200 bg-emerald-50 text-emerald-700",
      full: "text-muted-foreground",
      joined: "border-emerald-200 bg-emerald-50 text-emerald-700",
      owner: "border-indigo-200 bg-indigo-50 text-indigo-700",
      pending: "border-amber-200 bg-amber-50 text-amber-800",
      rejected: "border-red-200 bg-red-50 text-red-700",
      request: "",
    },
  },
});

const shareHelpButton = tv({
  base: "inline-flex size-4 shrink-0 items-center justify-center rounded-full",
  variants: {
    open: {
      false: "text-muted-foreground",
      true: "bg-zinc-200 text-slate-800",
    },
  },
});

const agentIcons: Record<AgentProvider, string> = {
  ChatGPT: assetPath("assets/chatgpt-icon.png"),
  Claude: assetPath("assets/claude-icon.png"),
  Grok: assetPath("assets/grok-icon.png"),
};

type PoolActionState =
  "accepted" | "full" | "joined" | "owner" | "pending" | "rejected" | "request";

interface AgentsPoolCardProps {
  currentUsername: string | null;
  onCheckRequests: (pool: AgentPool) => void;
  onRequestJoin: (pool: AgentPool) => void;
  pool: AgentPool;
}

interface AgentsPoolCardSheetProps {
  children: ReactNode;
  description: string;
  title: string;
  triggerIcon: ReactNode;
  triggerLabel: string;
  triggerValue: string;
}

interface AgentsPoolCardMemberRowProps {
  member: AgentPoolPerson;
}

interface AgentsPoolCardShareEvidenceProps {
  share: AgentPoolShareEvidence;
}

function actionState(
  pool: AgentPool,
  username: string | null,
): PoolActionState {
  if (username === pool.owner.username) return "owner";

  const request = pool.requests.find((item) => item.username === username);

  if (request) return request.status;
  if (pool.members.some((member) => member.username === username))
    return "joined";
  if (pool.members.length >= pool.capacity) return "full";
  return "request";
}

function usageTriggerValue(pool: AgentPool) {
  const fiveHour = pool.usage.find((metric) => metric.label === "5-hour limit");
  const weekly = pool.usage.find((metric) => metric.label === "Weekly limit");

  if (fiveHour) return fiveHour.value;
  if (weekly) return weekly.value;
  if (pool.usage.some((metric) => metric.value === "Unavailable")) {
    return "Unavailable";
  }
  if (pool.usage.length === 0) return "No live usage";
  return `${pool.usage.length} metrics`;
}

function membersTriggerValue(pool: AgentPool) {
  return `${pool.members.length} joined`;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en", { maximumFractionDigits: 0 }).format(
    value,
  );
}

function formatUsedPercent(value: number) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function formatUsedFraction(value: number) {
  return (value / 100).toFixed(2);
}

function AgentsPoolCardShareEvidence({
  share,
}: AgentsPoolCardShareEvidenceProps) {
  const providerUsed = share.providerUsedPercent;
  const windowLabel = share.windowLabel ?? "live window";

  return (
    <div className="mt-2 space-y-1 rounded-lg bg-zinc-50 p-2">
      <p className="font-mono text-[10px] text-slate-700">
        U = input + output + cached
      </p>
      <p className="font-mono text-[10px] text-slate-700">
        You used {formatTokenCount(share.userInputTokens)} +{" "}
        {formatTokenCount(share.userOutputTokens)} +{" "}
        {formatTokenCount(share.userCachedTokens)} ={" "}
        {formatTokenCount(share.userUnits)}
      </p>
      <p className="font-mono text-[10px] text-slate-700">
        Pool used {formatTokenCount(share.poolInputTokens)} +{" "}
        {formatTokenCount(share.poolOutputTokens)} +{" "}
        {formatTokenCount(share.poolCachedTokens)} ={" "}
        {formatTokenCount(share.poolUnits)}
      </p>
      {providerUsed != null ? (
        <p className="font-mono text-[10px] text-slate-700">
          Provider used p = {formatUsedPercent(providerUsed)}% of the{" "}
          {windowLabel}
        </p>
      ) : (
        <p className="font-mono text-[10px] text-slate-700">
          No live 5-hour or weekly window was reported.
        </p>
      )}
      {share.budgetUnits != null &&
      share.capUnits != null &&
      share.remainingUnits != null &&
      providerUsed != null ? (
        <>
          <p className="font-mono text-[10px] text-slate-700">
            B = U_pool / p = {formatTokenCount(share.poolUnits)} /{" "}
            {formatUsedFraction(providerUsed)} ={" "}
            {formatTokenCount(share.budgetUnits)}
          </p>
          <p className="font-mono text-[10px] text-slate-700">
            N = {share.memberCount} members
          </p>
          <p className="font-mono text-[10px] text-slate-700">
            Cap = B / N = {formatTokenCount(share.capUnits)}
          </p>
          <p className="font-mono text-[10px] text-slate-700">
            Remaining = cap − you = {formatTokenCount(share.remainingUnits)}
          </p>
          <p className="font-mono text-[10px] font-semibold text-slate-800">
            Available = remaining / cap = {share.availablePercent}%
          </p>
        </>
      ) : null}
      {share.failOpenReason ? (
        <p className="text-[10px] text-muted-foreground">
          {share.failOpenReason} Available stays {share.availablePercent}% until
          Hub can estimate the cap.
        </p>
      ) : null}
    </div>
  );
}

function AgentsPoolCardMemberRow({ member }: AgentsPoolCardMemberRowProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="py-2 first:pt-0 last:pb-0">
      <Flex className="justify-between gap-3">
        <dt className="text-xs text-muted-foreground">{member.username}</dt>
        <dd>
          <Flex className="justify-end gap-1">
            <p className="font-mono text-xs font-semibold">
              {member.usageAvailablePercent}% available
            </p>
            <button
              type="button"
              className={shareHelpButton({ open })}
              onClick={() => setOpen((current) => !current)}
            >
              <CircleHelp aria-hidden="true" className="size-3" />
              <span className="sr-only">Why this available percent</span>
            </button>
          </Flex>
        </dd>
      </Flex>
      <Flex className="mt-1 justify-end gap-1 text-[10px] text-muted-foreground">
        <Clock3 aria-hidden="true" className="size-3" />
        Joined{" "}
        <time dateTime={member.joinedAt}>
          {agentPoolsService.createdLabel(member.joinedAt)}
        </time>
      </Flex>
      {open ? <AgentsPoolCardShareEvidence share={member.share} /> : null}
    </div>
  );
}

function AgentsPoolCardSheet({
  children,
  description,
  title,
  triggerIcon,
  triggerLabel,
  triggerValue,
}: AgentsPoolCardSheetProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between"
        >
          <span className="inline-flex items-center gap-1.5">
            {triggerIcon}
            {triggerLabel}
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {triggerValue}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-(--radix-popover-trigger-width)"
      >
        <PopoverHeader>
          <PopoverTitle>{title}</PopoverTitle>
          <PopoverDescription>{description}</PopoverDescription>
        </PopoverHeader>

        {children}
      </PopoverContent>
    </Popover>
  );
}

function actionLabel(state: PoolActionState) {
  const labels: Record<PoolActionState, string> = {
    accepted: "Accepted",
    full: "Pool full",
    joined: "Joined",
    owner: "Check Request",
    pending: "Request pending",
    rejected: "Rejected",
    request: "Request Join",
  };

  return labels[state];
}

export default function AgentsPoolCard({
  currentUsername,
  onCheckRequests,
  onRequestJoin,
  pool,
}: AgentsPoolCardProps) {
  const state = actionState(pool, currentUsername);

  const actionDisabled = [
    "accepted",
    "full",
    "joined",
    "pending",
    "rejected",
  ].includes(state);

  function handleAction() {
    if (state === "owner") {
      onCheckRequests(pool);
      return;
    }

    onRequestJoin(pool);
  }

  return (
    <li className="h-full">
      <Card className="h-full border-0 bg-white/95 py-0 gap-0 shadow-sm ring-slate-200/90">
        <CardHeader className="gap-4 border-b border-slate-100 py-4 flex-1 flex flex-col">
          <Flex className="justify-between flex-wrap gap-3 flex-1 w-full">
            <Flex className="gap-3">
              <img src={agentIcons[pool.agent]} alt="" className="size-9" />

              <div>
                <p className="truncate font-mono text-sm font-semibold">
                  {pool.accountLabel}
                </p>

                <Flex className="mt-1 gap-1 text-[10px] text-muted-foreground">
                  <UserRound aria-hidden="true" className="size-3" />
                  {pool.owner.username}{" "}
                  <span className="font-bold text-slate-700">
                    · At {agentPoolsService.createdLabel(pool.createdAt)}
                  </span>
                </Flex>
              </div>
            </Flex>

            <Badge variant="secondary">{pool.plan}</Badge>
          </Flex>

          <AgentsPoolCardSheet
            description="Fields vary by agent and subscription plan."
            title={`${pool.agent} usage`}
            triggerIcon={<CircleGauge aria-hidden="true" className="size-4" />}
            triggerLabel="View Usages"
            triggerValue={usageTriggerValue(pool)}
          >
            {pool.usage.length > 0 ? (
              <dl className="divide-y divide-zinc-100">
                {pool.usage.map((metric) => (
                  <div key={metric.label} className="py-2 first:pt-0 last:pb-0">
                    <Flex className="justify-between gap-3">
                      <dt className="text-xs text-muted-foreground">
                        {metric.label}
                      </dt>
                      <dd className="text-right font-mono text-xs font-semibold">
                        {metric.value}
                      </dd>
                    </Flex>
                    {metric.detail ? (
                      <Flex className="mt-1 justify-end gap-1 text-[10px] text-muted-foreground">
                        <Clock3 aria-hidden="true" className="size-3" />
                        {metric.detail}
                      </Flex>
                    ) : null}
                  </div>
                ))}
              </dl>
            ) : (
              <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-muted-foreground">
                {pool.agent} has not reported usage for this account yet.
              </p>
            )}
          </AgentsPoolCardSheet>

          <AgentsPoolCardSheet
            description="Joined members and remaining share of the live window."
            title="Pool members"
            triggerIcon={<Users aria-hidden="true" className="size-4" />}
            triggerLabel="Members"
            triggerValue={membersTriggerValue(pool)}
          >
            {pool.members.length > 0 ? (
              <dl className="divide-y divide-zinc-100">
                {pool.members.map((member) => (
                  <AgentsPoolCardMemberRow
                    key={member.username}
                    member={member}
                  />
                ))}
              </dl>
            ) : (
              <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-muted-foreground">
                No members have joined this pool yet.
              </p>
            )}
          </AgentsPoolCardSheet>
        </CardHeader>

        <CardFooter className="gap-2 p-3">
          <Button
            type="button"
            variant="outline"
            disabled={actionDisabled}
            onClick={handleAction}
            className={actionButton({ state })}
          >
            <AgentsAvatarStack people={pool.members} />

            <span>{actionLabel(state)}</span>
          </Button>
        </CardFooter>
      </Card>
    </li>
  );
}
