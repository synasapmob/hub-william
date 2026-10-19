import type { QueryClient } from "@tanstack/react-query";

import { agentService } from "@/services/agent/agent-service";
import { organizationsService } from "@/services/organizations/organizations-service";
import { playgroundService } from "@/services/playground/playground-service";

// An organization agent is a live link to its owner's Workspace connection, so
// a refresh, reconnect, delete or organization removal changes what Workspace,
// every organization view and Playground show for that account.
export function invalidateAgentQueries(queryClient: QueryClient) {
  return Promise.all(
    [
      agentService.poolsQueryKey,
      agentService.connectionsQueryKey,
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
