import { useRef, useState } from "react";
import { Search } from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import AgentsExplorerLinks from "@/components/agents-explorer-links";
import AgentsProviderIcon from "@/components/agents-provider-icon";
import type { AgentPool, AgentProvider } from "@/services/agent-pools";
import { AGENT_PROVIDERS, agentPoolAccess } from "@/utils/utils.agent-pools";

import AgentsAccountRow from "./agents-account-row";
import AgentsPoolCard from "./agents-pool-card";
import AgentsPoolCardSkeleton from "./agents-pool-card-skeleton";

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

const accountSkeletons = [0, 1, 2, 3, 4, 5];
type AccountFilter = "all" | "mine" | "joined";

interface AgentsExplorerProps {
  currentUsername: string | null;
  loading: boolean;
  onCheckRequests: (pool: AgentPool) => void;
  onRequestJoin: (pool: AgentPool) => void;
  pools: AgentPool[];
}

export default function AgentsExplorer({
  currentUsername,
  loading,
  onCheckRequests,
  onRequestJoin,
  pools,
}: AgentsExplorerProps) {
  const boardRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [provider, setProvider] = useState<AgentProvider | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [selectedPool, setSelectedPool] = useState<AgentPool | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const selectedProvider =
    provider ??
    AGENT_PROVIDERS.find((agent) =>
      pools.some((pool) => pool.agent === agent),
    ) ??
    "ChatGPT";
  const normalizedQuery = query.trim().toLowerCase();
  const filteredPools = pools.filter((pool) => {
    const access = agentPoolAccess(pool, currentUsername);
    return (
      pool.agent === selectedProvider &&
      (filter === "all" ||
        (filter === "mine" ? access === "owner" : access === "joined")) &&
      `${pool.accountLabel} ${pool.owner.username} ${pool.plan}`
        .toLowerCase()
        .includes(normalizedQuery)
    );
  });
  const currentPool = pools.find((pool) => pool.id === selectedPool?.id);
  if (selectedPool && !loading && !currentPool) setSelectedPool(null);
  // Keep the selected public account visible while login refreshes the query.
  const openPool = currentPool ?? (loading ? selectedPool : null);

  return (
    <TooltipProvider delayDuration={450}>
      <section
        ref={scrollRef}
        aria-label="Provider and account explorer"
        role={loading ? "status" : undefined}
        aria-busy={loading}
        className="mt-6 min-h-0 flex-1 overflow-y-auto overscroll-contain scrollbar-gutter-stable"
      >
        {loading ? <p className="sr-only">Loading connected accounts</p> : null}

        <div
          ref={boardRef}
          className="relative grid min-h-full items-start gap-x-12 gap-y-8 pt-1 pr-2 pb-8 pl-4 lg:grid-cols-[10rem_minmax(0,1fr)]"
        >
          <AgentsExplorerLinks
            accounts={loading ? [] : filteredPools}
            boardRef={boardRef}
            highlightedId={hoveredId ?? focusedId}
          />

          <nav
            aria-label="Agent providers"
            className="min-w-0 lg:sticky lg:top-0 lg:z-20 lg:bg-background"
          >
            <h2 className="relative z-10 mb-4 text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
              Providers
            </h2>

            <Flex className="flex-wrap gap-2 lg:flex-col">
              {AGENT_PROVIDERS.map((agent) =>
                loading ? (
                  <Flex
                    key={agent}
                    aria-hidden="true"
                    className="min-h-12 min-w-32 items-center gap-2.5 rounded-xl px-3"
                  >
                    <div className="size-6 shrink-0 animate-pulse rounded-md bg-zinc-200" />

                    <div className="h-3 w-16 animate-pulse rounded bg-zinc-200" />

                    <div className="ml-auto size-3 animate-pulse rounded bg-zinc-200" />
                  </Flex>
                ) : (
                  <button
                    key={agent}
                    type="button"
                    className={providerButton({
                      selected: selectedProvider === agent,
                    })}
                    data-agent-node={`provider:${agent}`}
                    aria-label={`${agent}, ${pools.filter((pool) => pool.agent === agent).length} ${pools.filter((pool) => pool.agent === agent).length === 1 ? "account" : "accounts"}`}
                    aria-pressed={selectedProvider === agent}
                    onClick={() => {
                      setProvider(agent);
                      scrollRef.current?.scrollTo?.({ top: 0 });
                    }}
                  >
                    <AgentsProviderIcon provider={agent} />
                    <span className="font-medium">{agent}</span>
                    <span className="ml-auto pl-2 font-mono text-[10px] opacity-60">
                      {pools.filter((pool) => pool.agent === agent).length}
                    </span>
                  </button>
                ),
              )}
            </Flex>
          </nav>

          <section
            aria-label={`${selectedProvider} accounts`}
            className="min-w-0"
          >
            <Flex className="relative z-10 mb-4 items-center gap-4">
              <div className="relative min-w-0 flex-1">
                {loading ? (
                  <div
                    aria-hidden="true"
                    className="h-10 w-full animate-pulse rounded-lg bg-zinc-200/70"
                  />
                ) : (
                  <>
                    <Search
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-zinc-400"
                    />

                    <Input
                      aria-label="Search accounts"
                      className="h-10 w-full bg-white pl-9 text-xs"
                      placeholder="Search accounts…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                  </>
                )}
              </div>

              {loading ? (
                <div
                  aria-hidden="true"
                  className="h-10 w-28 shrink-0 animate-pulse rounded-lg bg-zinc-200/70"
                />
              ) : (
                <Select
                  onValueChange={(value) => setFilter(value as AccountFilter)}
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
                    <SelectItem value="joined">Joined</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </Flex>

            {!loading && filteredPools.length === 0 ? (
              <p className="relative z-10 rounded-xl border border-dashed border-zinc-200 bg-background p-5 text-xs/relaxed text-zinc-500">
                No accounts match. Try another provider or filter.
              </p>
            ) : null}

            <ul className="space-y-3">
              {loading
                ? accountSkeletons.map((key) => (
                    <AgentsPoolCardSkeleton key={key} />
                  ))
                : filteredPools.map((pool) => (
                    <li
                      key={pool.id}
                      onMouseEnter={() => setHoveredId(pool.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      onFocusCapture={() => setFocusedId(pool.id)}
                      onBlurCapture={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                          setFocusedId(null);
                      }}
                    >
                      <AgentsAccountRow
                        currentUsername={currentUsername}
                        pool={pool}
                        selected={selectedPool?.id === pool.id}
                        onOpen={(button) => {
                          triggerRef.current = button;
                          setHoveredId(null);
                          setSelectedPool(pool);
                        }}
                      />
                    </li>
                  ))}
            </ul>
          </section>
        </div>
      </section>

      <Dialog
        open={openPool !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPool(null);
        }}
      >
        {openPool ? (
          <DialogContent
            id={`agent-info-${openPool.id}`}
            className="max-h-[calc(100svh-2rem)] overflow-y-auto gap-0 p-0 sm:max-w-lg"
            showCloseButton={false}
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              if (triggerRef.current?.isConnected)
                triggerRef.current.focus({ preventScroll: true });
              else {
                const nodes =
                  boardRef.current?.querySelectorAll<HTMLElement>(
                    "[data-agent-node]",
                  );
                const targets = Array.from(nodes ?? []);
                const target =
                  targets.find(
                    (node) =>
                      node.dataset.agentNode ===
                      triggerRef.current?.dataset.agentNode,
                  ) ??
                  targets.find(
                    (node) =>
                      node.dataset.agentNode === `provider:${selectedProvider}`,
                  );
                target?.focus({ preventScroll: true });
              }
            }}
          >
            <DialogTitle className="sr-only">
              {openPool.agent} account {openPool.accountLabel} details
            </DialogTitle>

            <DialogDescription className="sr-only">
              Usage limits, members, and access for this connected account.
            </DialogDescription>

            <AgentsPoolCard
              currentUsername={currentUsername}
              onCheckRequests={onCheckRequests}
              onClose={() => setSelectedPool(null)}
              onRequestJoin={onRequestJoin}
              pool={openPool}
            />
          </DialogContent>
        ) : null}
      </Dialog>
    </TooltipProvider>
  );
}
