import { useCallback, useEffect, useState } from "react";
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

export default function AgentsRoute() {
  const session = useWorkspaceSession();
  const [pools, setPools] = useState<AgentPool[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [requestPoolId, setRequestPoolId] = useState<string | null>(null);
  const [reviewPoolId, setReviewPoolId] = useState<string | null>(null);
  const requestPool = pools.find((pool) => pool.id === requestPoolId) ?? null;
  const reviewPool = pools.find((pool) => pool.id === reviewPoolId) ?? null;
  const hasSharedGatewayAccess = pools.some(
    (pool) =>
      pool.owner.username !== session.user?.username &&
      pool.members.some((member) => member.username === session.user?.username),
  );

  const loadPools = useCallback(async () => {
    try {
      setPools(await agentPoolsService.list());
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(
        error instanceof AgentPoolServiceError
          ? error.message
          : "The account pools could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    agentPoolsService
      .list()
      .then((items) => {
        if (cancelled) return;
        setPools(items);
        setErrorMessage(null);
      })
      .catch((error) => {
        if (cancelled) return;
        setErrorMessage(
          error instanceof AgentPoolServiceError
            ? error.message
            : "The account pools could not be loaded.",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [session.user?.id]);

  function requestJoin(pool: AgentPool) {
    if (!session.user) {
      session.openAuth();
      return;
    }

    setRequestPoolId(pool.id);
  }

  async function submitRequest(values: RequestFormValues) {
    if (!session.user || !requestPool) return;

    await agentPoolsService.requestJoin(requestPool.id, values);
    await loadPools();
    setRequestPoolId(null);
  }

  async function decideRequest(
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ) {
    if (!reviewPool) return;
    try {
      await agentPoolsService.decide(requestId, status);
      await loadPools();
    } catch (error) {
      setErrorMessage(
        error instanceof AgentPoolServiceError
          ? error.message
          : "The join request could not be updated.",
      );
    }
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

          <Flex className="items-center gap-2">
            <Button asChild className="h-10 px-4" variant="outline">
              <Link to="/tools?node=gateway">
                <Download aria-hidden="true" />
                Install
              </Link>
            </Button>
            <AgentsConnectDialog
              hasSharedGatewayAccess={hasSharedGatewayAccess}
              onConnected={() => void loadPools()}
            />
          </Flex>
        </Flex>

        {errorMessage ? (
          <Alert className="mt-5" variant="destructive">
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}

        {loading ? (
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
        open={reviewPool !== null}
        onDecision={decideRequest}
        onOpenChange={(open) => {
          if (!open) setReviewPoolId(null);
        }}
        pool={reviewPool}
      />
    </section>
  );
}
