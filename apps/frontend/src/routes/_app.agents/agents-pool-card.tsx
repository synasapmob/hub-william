import { type ReactNode } from "react";
import { Bot, CircleGauge, Clock3, UserRound, Users } from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import Center from "@/components/ui/center";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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

const agentIcons: Partial<Record<AgentProvider, string>> = {
  ChatGPT: assetPath("assets/chatgpt-icon.png"),
  Claude: assetPath("assets/claude-icon.png"),
  Gemini: assetPath("assets/gemini-icon.svg"),
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
  triggerValue: ReactNode;
}

interface AgentsPoolCardUsageWindow {
  label: string;
  metricLabel: string;
}

interface AgentsPoolCardMemberRowProps {
  member: AgentPoolPerson;
}

interface AgentsPoolCardTokenUsage {
  label: string;
  value: number;
}

interface AgentsPoolCardMembersDialogProps {
  pool: AgentPool;
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
  const windows: AgentsPoolCardUsageWindow[] = [
    { label: "5 hours limit", metricLabel: "5-hour limit" },
    { label: "Weekly limit", metricLabel: "Weekly limit" },
  ];

  return (
    <span className="grid justify-items-end gap-0.5 text-right leading-tight">
      {windows.map(({ label, metricLabel }) => {
        const metric = pool.usage.find((item) => item.label === metricLabel);
        const value =
          metric && metric.value !== "Unavailable" ? metric.value : "N/A";

        return (
          <span key={metricLabel}>
            {value} | {label}
          </span>
        );
      })}
    </span>
  );
}

function membersTriggerValue(pool: AgentPool) {
  return `${pool.members.length} joined`;
}

function formatTokenCount(value: number) {
  return new Intl.NumberFormat("en", {
    maximumFractionDigits: 1,
    notation: "compact",
  }).format(value);
}

function AgentsPoolCardMemberRow({ member }: AgentsPoolCardMemberRowProps) {
  const tokenUsage: AgentsPoolCardTokenUsage[] = [
    { label: "Token Input", value: member.share.userInputTokens },
    { label: "Token Cached", value: member.share.userCachedTokens },
    { label: "Token Output", value: member.share.userOutputTokens },
  ].filter(({ value }) => value > 0);

  return (
    <div>
      <Flex className="justify-between gap-3">
        <p className="min-w-0 truncate text-sm font-semibold">
          {member.username}
        </p>
      </Flex>
      {tokenUsage.length > 0 ? (
        <dl className="mt-2 space-y-1">
          {tokenUsage.map(({ label, value }) => (
            <Flex key={label} className="justify-between gap-3 text-[10px]">
              <dt className="text-muted-foreground">{label}</dt>
              <dd className="font-mono font-semibold text-slate-700">
                {formatTokenCount(value)}
              </dd>
            </Flex>
          ))}
        </dl>
      ) : (
        <p className="mt-2 text-[10px] text-muted-foreground">
          No recorded tokens in the current usage window.
        </p>
      )}
      <Flex className="mt-1 gap-1 text-[10px] text-muted-foreground">
        <Clock3 aria-hidden="true" className="size-3" />
        Joined{" "}
        <time dateTime={member.joinedAt}>
          {agentPoolsService.createdLabel(member.joinedAt)}
        </time>
      </Flex>
    </div>
  );
}

function AgentsPoolCardMembersDialog({
  pool,
}: AgentsPoolCardMembersDialogProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          className="w-full justify-between"
        >
          <span className="inline-flex items-center gap-1.5">
            <Users aria-hidden="true" className="size-4" />
            Members
          </span>
          <span className="font-mono text-[10px] text-muted-foreground">
            {membersTriggerValue(pool)}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Pool members</DialogTitle>
          <DialogDescription>
            Joined members and their recorded token usage in the current window.
          </DialogDescription>
        </DialogHeader>

        {pool.members.length > 0 ? (
          <ul className="space-y-2">
            {pool.members.map((member) => (
              <li
                key={member.username}
                className="rounded-xl border border-zinc-200 p-3"
              >
                <AgentsPoolCardMemberRow member={member} />
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-lg border border-dashed border-zinc-300 p-4 text-center text-xs text-muted-foreground">
            No members have joined this pool yet.
          </p>
        )}
      </DialogContent>
    </Dialog>
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
              {agentIcons[pool.agent] ? (
                <img src={agentIcons[pool.agent]} alt="" className="size-9" />
              ) : (
                <Center className="size-9 rounded-lg bg-sky-50 text-sky-700">
                  <Bot aria-hidden="true" className="size-5" />
                </Center>
              )}

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

          <AgentsPoolCardMembersDialog pool={pool} />
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
