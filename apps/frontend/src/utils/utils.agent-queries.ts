import type { QueryClient } from "@tanstack/react-query";

import agentConnectionsService from "@/services/agent-connections";
import agentPoolsService from "@/services/agent-pools";
import organizationsService from "@/services/organizations";
import playgroundService from "@/services/playground";

// An organization agent is a live link to its owner's Workspace connection, so
// a refresh, reconnect, delete or organization removal changes what Workspace,
// every organization view and Playground show for that account.
export function invalidateAgentQueries(queryClient: QueryClient) {
  return Promise.all(
    [
      agentPoolsService.queryKey,
      agentConnectionsService.queryKey,
      organizationsService.queryKey,
      playgroundService.queryKey,
    ].map((queryKey) =>
      queryClient.invalidateQueries({
        queryKey,
        // Completion polling already supplied the fresh connection. Refetching
        // it here would trigger onRefreshComplete and invalidate it forever.
        predicate: (query) =>
          query.queryKey[1] !== "refresh-status" &&
          query.queryKey[1] !== "status",
      }),
    ),
  );
}
