import { useRef, useState } from "react";
import { Search, Trash2, X } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { tv } from "tailwind-variants";

import AgentsExplorerLinks from "@/components/agents-explorer-links";
import AgentsProviderIcon from "@/components/agents-provider-icon";
import AgentsUsageMetrics from "@/components/agents-usage-metrics";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { AgentProvider } from "@/services/agent-pools";
import organizationsService, {
  type OrganizationAgentDetails,
} from "@/services/organizations";
import {
  availabilityLabel,
  formatCount,
  formatTokenCount,
  providerLabel,
} from "@/routes/_app.organization/organization-format";
import {
  AGENT_PROVIDERS,
  agentPoolPrimaryUsage,
  agentPoolUsageValue,
  agentProviderShowsUsage,
} from "@/utils/utils.agent-pools";

const providerButton = tv({
  base: "relative z-10 flex min-h-12 shrink-0 items-center gap-2.5 rounded-xl border px-3 text-left text-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-500 lg:w-full",
  variants: {
    selected: {
      true: "border-indigo-200 bg-indigo-50 text-indigo-700",
      false:
        "border-transparent bg-background text-zinc-600 hover:border-zinc-200 hover:bg-white",
    },
  },
});

const accountButton = tv({
  base: "relative z-10 grid w-full min-w-0 items-center gap-3 rounded-xl border bg-white p-4 text-left shadow-xs transition-colors focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-indigo-500 sm:grid-cols-[minmax(0,1fr)_auto]",
  variants: {
    selected: {
      true: "border-indigo-300 ring-1 ring-indigo-100",
      false: "border-zinc-200 hover:border-zinc-400",
    },
  },
});

interface OrganizationAgentsExplorerProps {
  agents: OrganizationAgentDetails[];
  currentUsername: string | null;
  isOrganizationOwner: boolean;
  onRemove: (id: string) => void;
  organizationId: string;
  removeError: string | null;
  removeErrorId: string | null;
  removing: boolean;
}

function agentProvider(agent: OrganizationAgentDetails): AgentProvider {
  return providerLabel(agent.provider) as AgentProvider;
}

export default function OrganizationAgentsExplorer({
  agents,
  currentUsername,
  isOrganizationOwner,
  onRemove,
  organizationId,
  removeError,
  removeErrorId,
  removing,
}: OrganizationAgentsExplorerProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "mine">("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const selectedProvider =
    provider ?? (agents[0] ? agentProvider(agents[0]) : AGENT_PROVIDERS[0]);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredAgents = agents.filter(
    (agent) =>
      agentProvider(agent) === selectedProvider &&
      (filter === "all" || agent.ownerUsername === currentUsername) &&
      `${agent.accountLabel ?? ""} ${agent.ownerUsername} ${agent.plan}`
        .toLowerCase()
        .includes(normalizedQuery),
  );
  const selectedAgent = agents.find((agent) => agent.id === selectedId) ?? null;
  const usageQuery = useQuery({
    enabled: selectedAgent !== null,
    queryFn: () =>
      organizationsService.usage(organizationId, {
        connectionId: selectedId ?? undefined,
        days: 30,
      }),
    queryKey: [
      ...organizationsService.queryKey,
      organizationId,
      "agent-usage",
      selectedId,
      30,
    ],
  });

  return (
    <>
      <section aria-label="Provider and account explorer" className="min-w-0">
        <div
          ref={boardRef}
          className="relative grid min-h-64 items-start gap-x-12 gap-y-8 pr-2 pb-8 pl-4 lg:grid-cols-[10rem_minmax(0,1fr)]"
        >
          <AgentsExplorerLinks
            accounts={filteredAgents.map((agent) => ({
              agent: agentProvider(agent),
              id: agent.id,
            }))}
            boardRef={boardRef}
            highlightedId={highlightedId}
          />

          <nav aria-label="Agent providers" className="min-w-0">
            <h2 className="relative z-10 mb-4 text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
              Providers
            </h2>
            <Flex className="flex-wrap gap-2 lg:flex-col">
              {AGENT_PROVIDERS.map((item) => {
                const count = agents.filter(
                  (agent) => agentProvider(agent) === item,
                ).length;
                return (
                  <button
                    key={item}
                    aria-label={`${item}, ${count} ${count === 1 ? "account" : "accounts"}`}
                    aria-pressed={selectedProvider === item}
                    className={providerButton({
                      selected: selectedProvider === item,
                    })}
                    data-agent-node={`provider:${item}`}
                    onClick={() => setProvider(item)}
                    type="button"
                  >
                    <AgentsProviderIcon provider={item} />
                    <span className="font-medium">{item}</span>
                    <span className="ml-auto pl-2 font-mono text-[10px] opacity-60">
                      {count}
                    </span>
                  </button>
                );
              })}
            </Flex>
          </nav>

          <section
            aria-label={`${selectedProvider} accounts`}
            className="min-w-0"
          >
            <Flex className="relative z-10 mb-4 items-center gap-3">
              <div className="relative min-w-0 flex-1">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400"
                />
                <Input
                  aria-label="Search accounts"
                  className="h-10 w-full bg-white pl-9 text-xs"
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="Search accounts…"
                  value={query}
                />
              </div>
              <Select
                onValueChange={(value) => setFilter(value as "all" | "mine")}
                value={filter}
              >
                <SelectTrigger
                  aria-label="Filter accounts"
                  className="h-10! w-32 shrink-0 bg-white text-xs"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All accounts</SelectItem>
                  <SelectItem value="mine">Mine</SelectItem>
                </SelectContent>
              </Select>
            </Flex>

            {agents.length > 0 && filteredAgents.length === 0 ? (
              <p className="relative z-10 rounded-xl border border-dashed border-zinc-200 bg-background p-5 text-xs/relaxed text-zinc-500">
                No accounts match. Try another provider or filter.
              </p>
            ) : null}

            <ul className="space-y-3">
              {filteredAgents.map((agent) => {
                const name = agentProvider(agent);
                const primaryUsage = agentProviderShowsUsage(name)
                  ? agentPoolPrimaryUsage(agent)
                  : undefined;
                return (
                  <li
                    key={agent.id}
                    onBlurCapture={() => setHighlightedId(null)}
                    onFocusCapture={() => setHighlightedId(agent.id)}
                    onMouseEnter={() => setHighlightedId(agent.id)}
                    onMouseLeave={() => setHighlightedId(null)}
                  >
                    <button
                      aria-controls={
                        selectedId === agent.id
                          ? `organization-agent-info-${agent.id}`
                          : undefined
                      }
                      aria-expanded={selectedId === agent.id}
                      aria-haspopup="dialog"
                      aria-label={`Open ${name} account ${agent.accountLabel ?? "Connected account"}`}
                      className={accountButton({
                        selected: selectedId === agent.id,
                      })}
                      data-agent-node={`account:${agent.id}`}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        setSelectedId(agent.id);
                      }}
                      type="button"
                    >
                      <div className="min-w-0">
                        <p className="truncate font-mono text-xs font-semibold text-zinc-900">
                          {agent.accountLabel ?? "Connected account"}
                        </p>
                        <p className="mt-1 text-[11px] text-zinc-500">
                          {name} · {agent.plan} · added by @
                          {agent.ownerUsername}
                        </p>
                        {primaryUsage ? (
                          <p className="mt-2 text-[10px] text-zinc-500">
                            {primaryUsage.label} ·{" "}
                            {agentPoolUsageValue(primaryUsage)}
                          </p>
                        ) : null}
                      </div>
                      <Badge
                        className="justify-self-start sm:justify-self-end"
                        variant="secondary"
                      >
                        {availabilityLabel(agent.availabilityStatus)}
                      </Badge>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </section>

      <Dialog
        onOpenChange={(open) => {
          if (!open) setSelectedId(null);
        }}
        open={selectedAgent !== null}
      >
        {selectedAgent ? (
          <DialogContent
            className="max-h-[calc(100svh-2rem)] overflow-y-auto gap-0 p-0 sm:max-w-lg"
            id={`organization-agent-info-${selectedAgent.id}`}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              triggerRef.current?.focus({ preventScroll: true });
            }}
            showCloseButton={false}
          >
            <DialogTitle className="sr-only">
              {agentProvider(selectedAgent)} account{" "}
              {selectedAgent.accountLabel} details
            </DialogTitle>
            <DialogDescription className="sr-only">
              Account details and available usage for this organization.
            </DialogDescription>

            <article className="min-w-0 overflow-hidden bg-white">
              <header className="border-b border-zinc-100 p-5">
                <Flex className="items-start justify-between gap-3">
                  <Flex className="min-w-0 items-center gap-2.5">
                    <AgentsProviderIcon
                      provider={agentProvider(selectedAgent)}
                    />
                    <div className="min-w-0">
                      <Flex className="flex-wrap items-center gap-2">
                        <p className="text-[10px] font-medium tracking-wider text-zinc-500 uppercase">
                          {agentProvider(selectedAgent)}
                        </p>
                        <Badge
                          className="text-[9px] font-normal uppercase"
                          variant="secondary"
                        >
                          {selectedAgent.plan}
                        </Badge>
                      </Flex>
                      <h3 className="mt-0.5 truncate font-mono text-xs font-semibold">
                        {selectedAgent.accountLabel ?? "Connected account"}
                      </h3>
                    </div>
                  </Flex>
                  <Button
                    className="-mt-1 -mr-1 shrink-0 text-zinc-400"
                    onClick={() => setSelectedId(null)}
                    size="icon-sm"
                    type="button"
                    variant="ghost"
                  >
                    <X aria-hidden="true" className="size-4" />
                    <span className="sr-only">Close account details</span>
                  </Button>
                </Flex>
              </header>

              <div className="space-y-5 p-5">
                {agentProviderShowsUsage(agentProvider(selectedAgent)) ? (
                  <AgentsUsageMetrics
                    provider={agentProvider(selectedAgent)}
                    usage={selectedAgent.usage}
                  />
                ) : null}

                {usageQuery.data && usageQuery.data.requests > 0 ? (
                  <section className="space-y-3 border-t border-zinc-100 pt-4">
                    <h4 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
                      Organization usage · last 30 days
                    </h4>
                    <dl className="grid grid-cols-2 gap-3 text-xs">
                      <div>
                        <dt className="text-zinc-500">Requests</dt>
                        <dd className="mt-1 font-mono font-semibold">
                          {formatCount(usageQuery.data.requests)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-zinc-500">Reported tokens</dt>
                        <dd className="mt-1 font-mono font-semibold">
                          {usageQuery.data.tokenKnownRequests
                            ? formatTokenCount(
                                usageQuery.data.knownInputTokens +
                                  usageQuery.data.knownOutputTokens,
                              )
                            : "—"}
                        </dd>
                      </div>
                    </dl>
                  </section>
                ) : null}

                {usageQuery.error ? (
                  <div
                    role="alert"
                    className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
                  >
                    <p>
                      Organization activity could not be loaded:{" "}
                      {usageQuery.error.message}
                    </p>
                    <Button
                      className="mt-2"
                      onClick={() => void usageQuery.refetch()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Retry activity
                    </Button>
                  </div>
                ) : null}

                <dl className="space-y-2 border-t border-zinc-100 pt-4 text-[11px]">
                  <Flex className="items-center justify-between gap-3">
                    <dt className="text-zinc-400">Added by</dt>
                    <dd>@{selectedAgent.ownerUsername}</dd>
                  </Flex>
                  <Flex className="items-center justify-between gap-3">
                    <dt className="text-zinc-400">Status</dt>
                    <dd>
                      {availabilityLabel(selectedAgent.availabilityStatus)}
                    </dd>
                  </Flex>
                </dl>
              </div>

              {isOrganizationOwner ||
              selectedAgent.ownerUsername === currentUsername ? (
                <footer className="space-y-3 border-t border-zinc-100 bg-zinc-50/60 px-5 py-3">
                  {removeError && removeErrorId === selectedAgent.id ? (
                    <p role="alert" className="text-xs text-destructive">
                      {removeError}
                    </p>
                  ) : null}
                  <Button
                    className="ml-auto"
                    disabled={removing}
                    onClick={() => onRemove(selectedAgent.id)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <Trash2 aria-hidden="true" />
                    Remove from organization
                  </Button>
                </footer>
              ) : null}
            </article>
          </DialogContent>
        ) : null}
      </Dialog>
    </>
  );
}
