import { useCallback } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";

import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import AgentsConnectDialog from "@/components/agents-connect-dialog";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import agentConnectionsService from "@/services/agent-connections";
import organizationsService from "@/services/organizations";
import {
  requireOrganization,
  useOrganizationContext,
} from "@/routes/_app.organization/organization-context";
import { invalidateAgentQueries } from "@/utils/utils.agent-queries";

import OrganizationAgentsExplorer from "./organization-agents-explorer";
import OrganizationAgentsExplorerSkeleton from "./organization-agents-explorer-skeleton";

export default function OrganizationAgentsRoute() {
  const { organization } = useOrganizationContext();
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const agentsQuery = useQuery({
    queryFn: organization
      ? () => organizationsService.agents(organization.id, true)
      : skipToken,
    queryKey: [
      ...organizationsService.queryKey,
      organization?.id ?? null,
      "agents",
      "usage",
    ],
  });
  const addMutation = useMutation({
    mutationFn: (connectionId: string) =>
      organizationsService.addAgent(
        requireOrganization(organization).id,
        connectionId,
      ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [
          ...organizationsService.queryKey,
          requireOrganization(organization).id,
        ],
      });
    },
  });
  const refreshAgentData = useCallback(
    () => invalidateAgentQueries(queryClient),
    [queryClient],
  );
  const removeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      organizationsService.removeAgent(
        requireOrganization(organization).id,
        connectionId,
      ),
    onSuccess: refreshAgentData,
  });
  // Refresh is owner-only on the API: it renews the Workspace connection this
  // organization agent links to, so every view of that account updates.
  const refreshMutation = useMutation({
    mutationFn: (connectionId: string) =>
      agentConnectionsService.refresh(connectionId),
    onSuccess: refreshAgentData,
  });
  const agents = agentsQuery.data ?? [];

  return (
    <div className="space-y-6">
      {agentsQuery.isPending ? (
        <p role="status" className="sr-only">
          Loading agents
        </p>
      ) : null}

      <header className="flex flex-wrap items-end justify-between gap-4 border-b border-zinc-200/80 pb-5">
        <div className="space-y-2">
          <h1 className="font-heading text-3xl font-bold tracking-tight">
            Agents
          </h1>

          {organization ? (
            <p className="text-sm text-muted-foreground">
              Explore connected accounts and usage shared with{" "}
              {organization.name}.
            </p>
          ) : (
            <Flex className="h-5 items-center">
              <Skeleton className="h-3.5 w-80 max-w-full bg-zinc-200" />
            </Flex>
          )}
        </div>

        {organization ? (
          <AgentsConnectDialog
            onAddExisting={async (connection) => {
              await addMutation.mutateAsync(connection.id);
            }}
            onConnected={async (connection) => {
              const shared =
                agentsQuery.data ?? (await agentsQuery.refetch()).data ?? [];
              if (shared.some((agent) => agent.id === connection.id)) return;
              await addMutation.mutateAsync(connection.id);
            }}
            sharedConnectionIds={agents.map((agent) => agent.id)}
          />
        ) : (
          <Skeleton className="h-10 w-32 rounded-lg bg-zinc-200" />
        )}
      </header>

      {agentsQuery.error || removeMutation.error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {(agentsQuery.error ?? removeMutation.error)?.message}
        </p>
      ) : null}

      {organization && !agentsQuery.isPending ? (
        <OrganizationAgentsExplorer
          agents={agents}
          currentUsername={session.user?.username ?? null}
          isOrganizationOwner={organization.role === "owner"}
          onRefresh={(id) => refreshMutation.mutateAsync(id)}
          onRefreshComplete={refreshAgentData}
          onRemove={(id) => removeMutation.mutate(id)}
          organizationId={organization.id}
          refreshing={refreshMutation.isPending}
          removeError={removeMutation.error?.message ?? null}
          removeErrorId={removeMutation.variables ?? null}
          removing={removeMutation.isPending}
        />
      ) : (
        <OrganizationAgentsExplorerSkeleton />
      )}
    </div>
  );
}
