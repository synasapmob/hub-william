import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Download, LoaderCircle } from "lucide-react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import Flex from "@/components/ui/flex";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import agentPoolsService, {
  AgentPoolServiceError,
  type AgentPool,
  type AgentPoolRequestStatus,
} from "@/services/agent-pools";

import AgentsPoolCard from "./agents-pool-card";
import AgentsRequestDialog, {
  type RequestFormValues,
} from "./agents-request-dialog";
import AgentsRequestsDialog from "./agents-requests-dialog";
import AgentsConnectDialog from "./agents-connect-dialog";
import AgentsGatewayKeyDialog from "./agents-gateway-key-dialog";

interface RequestJoinVariables {
  poolId: string;
  values: RequestFormValues;
}

interface DecideRequestVariables {
  requestId: string;
  status: Exclude<AgentPoolRequestStatus, "pending">;
}

interface PoolMemberVariables {
  poolId: string;
  username: string;
}

export default function AgentsRoute() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [requestPoolId, setRequestPoolId] = useState<string | null>(null);
  const [reviewPoolId, setReviewPoolId] = useState<string | null>(null);
  const poolsQuery = useQuery({
    queryFn: agentPoolsService.list,
    queryKey: [...agentPoolsService.queryKey, session.user?.id ?? "guest"],
  });
  const requestMutation = useMutation({
    mutationFn: ({ poolId, values }: RequestJoinVariables) =>
      agentPoolsService.requestJoin(poolId, values),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
  });
  const decisionMutation = useMutation({
    mutationFn: ({ requestId, status }: DecideRequestVariables) =>
      agentPoolsService.decide(requestId, status),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
  });
  const inviteMutation = useMutation({
    mutationFn: ({ poolId, username }: PoolMemberVariables) =>
      agentPoolsService.invite(poolId, username),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
  });
  const removeMemberMutation = useMutation({
    mutationFn: ({ poolId, username }: PoolMemberVariables) =>
      agentPoolsService.removeMember(poolId, username),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
  });
  const retryMutation = useMutation({
    mutationFn: (poolId: string) => agentPoolsService.retry(poolId),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: agentPoolsService.queryKey }),
  });
  const pools = poolsQuery.data ?? [];
  const requestPool = pools.find((pool) => pool.id === requestPoolId) ?? null;
  const reviewPool = pools.find((pool) => pool.id === reviewPoolId) ?? null;
  const routeError =
    poolsQuery.error ??
    decisionMutation.error ??
    removeMemberMutation.error ??
    retryMutation.error;
  const errorMessage = routeError
    ? routeError instanceof AgentPoolServiceError
      ? routeError.message
      : "The account pools could not be loaded."
    : null;

  function requestJoin(pool: AgentPool) {
    if (!session.user) {
      session.openAuth();
      return;
    }

    setRequestPoolId(pool.id);
  }

  async function submitRequest(values: RequestFormValues) {
    if (!session.user || !requestPool) return;

    await requestMutation.mutateAsync({ poolId: requestPool.id, values });
    setRequestPoolId(null);
  }

  async function decideRequest(
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ) {
    if (!reviewPool) return;
    decisionMutation.mutate({ requestId, status });
  }

  async function inviteMember(username: string) {
    if (!reviewPool) return;
    await inviteMutation.mutateAsync({ poolId: reviewPool.id, username });
  }

  async function removeMember(username: string) {
    if (!reviewPool) return;
    await removeMemberMutation.mutateAsync({
      poolId: reviewPool.id,
      username,
    });
  }

  async function refreshPool() {
    if (!reviewPool) return;
    await retryMutation.mutateAsync(reviewPool.id);
  }

  return (
    <section
      aria-labelledby="agents-title"
      className="relative isolate min-h-full px-4 pt-10 pb-20 sm:px-6 lg:px-10"
    >
      <div
        aria-hidden="true"
        className="canvas-grid-dots absolute inset-0 -z-20 opacity-45"
      />
      <div
        aria-hidden="true"
        className="absolute top-0 right-0 -z-10 size-80 rounded-full bg-indigo-200/30 blur-3xl"
      />

      <div className="mx-auto w-full max-w-6xl">
        <header className="max-w-3xl">
          <Flex className="items-center gap-2 font-mono text-xs font-semibold tracking-widest text-indigo-600 uppercase">
            <Bot aria-hidden="true" className="size-4" />
            Shared agent accounts
          </Flex>

          <h1
            id="agents-title"
            className="mt-4 font-heading text-3xl font-bold tracking-tight text-balance sm:text-4xl"
          >
            Share the bill. Connect your agent.
          </h1>

          <p className="mt-3 max-w-2xl text-muted-foreground text-sm/relaxed sm:text-base">
            Find people sharing an account, then connect Codex, Claude Code, or
            Grok through the available pool. Browsing is public; login is only
            required when you request to join.
          </p>
        </header>

        <Flex className="mt-10 justify-between gap-4 border-b border-slate-200/90 pb-3">
          <div>
            <h2 className="font-heading text-sm font-bold tracking-tight">
              Account pools
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Usage fields adapt to the agent and plan reported by each account.
            </p>
          </div>

          <Flex className="flex-wrap items-center justify-end gap-2">
            <Button asChild className="h-10 px-4" variant="outline">
              <Link to="/tools?node=gateway">
                <Download aria-hidden="true" />
                Install
              </Link>
            </Button>

            <AgentsGatewayKeyDialog />

            <AgentsConnectDialog
              onConnected={() =>
                void queryClient.invalidateQueries({
                  queryKey: agentPoolsService.queryKey,
                })
              }
            />
          </Flex>
        </Flex>

        {errorMessage ? (
          <Alert className="mt-5" variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {poolsQuery.isPending ? (
          <Flex
            aria-live="polite"
            className="mt-5 items-center gap-2 text-sm text-muted-foreground"
            role="status"
          >
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Loading connected accounts…
          </Flex>
        ) : pools.length > 0 ? (
          <ul className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {pools.map((pool) => (
              <AgentsPoolCard
                key={pool.id}
                currentUsername={session.user?.username ?? null}
                onCheckRequests={(selectedPool) =>
                  setReviewPoolId(selectedPool.id)
                }
                onRequestJoin={requestJoin}
                pool={pool}
              />
            ))}
          </ul>
        ) : (
          <p className="mt-5 rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-muted-foreground">
            No connected accounts yet.
          </p>
        )}
      </div>

      <AgentsRequestDialog
        open={requestPool !== null}
        onOpenChange={(open) => {
          if (!open) setRequestPoolId(null);
        }}
        onSubmitRequest={submitRequest}
        pool={requestPool}
      />

      <AgentsRequestsDialog
        busy={
          decisionMutation.isPending ||
          inviteMutation.isPending ||
          removeMemberMutation.isPending ||
          retryMutation.isPending
        }
        open={reviewPool !== null}
        onDecision={decideRequest}
        onInvite={inviteMember}
        onOpenChange={(open) => {
          if (!open) setReviewPoolId(null);
        }}
        onRefresh={refreshPool}
        onRemoveMember={removeMember}
        pool={reviewPool}
      />
    </section>
  );
}
