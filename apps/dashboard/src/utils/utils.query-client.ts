import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ServiceError } from "@/services/api/api-client";
import {
  sessionService,
  type SessionState,
} from "@/services/session/session-service";

/**
 * "Log in to continue." that is still there after the session was refreshed means
 * the session is over. Wrong credentials are a 401 too, with a code of their own,
 * and are the sign-in form's to report. The sign-in screen takes over, and a toast
 * says why; what the pages fetched is forgotten once they are gone (see the
 * session gate), since emptying the cache while they are still there only makes
 * them ask again. Answers whether that is what happened.
 */
function endSessionOn(client: QueryClient, error: unknown) {
  if (!(error instanceof ServiceError) || error.code !== "unauthorized")
    return false;

  client.setQueryData<SessionState>(sessionService.queryKey, {
    status: "signed-out",
  });
  toast.error("Your session has expired", {
    description: "Log in again to continue.",
    id: "session-expired",
  });

  return true;
}

export default function createQueryClient() {
  const client: QueryClient = new QueryClient({
    defaultOptions: {
      mutations: { retry: false },
      queries: { retry: false },
    },
    // What a page does with its own failure is its business: it shows the panel
    // and offers a retry. Whatever a page does, the person is told in a toast.
    mutationCache: new MutationCache({
      // A refused change is reported by the page that asked for it; only the end
      // of the session is the same everywhere.
      onError: (error) => {
        endSessionOn(client, error);
      },
    }),
    queryCache: new QueryCache({
      onError: (error, query) => {
        // The session's own states have a screen each.
        if (query.queryKey[1] === sessionService.queryKey[1]) return;

        if (endSessionOn(client, error)) return;

        // The same query failing again replaces its toast instead of stacking.
        toast.error(error.message, { id: query.queryHash });
      },
    }),
  });

  return client;
}
