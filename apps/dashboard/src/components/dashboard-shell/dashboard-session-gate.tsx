import { useEffect, type PropsWithChildren } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  sessionService,
  type SessionState,
} from "@/services/session/session-service";

import DashboardGateScreen from "./dashboard-gate-screen";
import DashboardLogin from "./dashboard-login";
import DashboardSession from "./dashboard-session";

/**
 * Shows the dashboard only to a member of staff. Everyone else sees why not: a
 * sign-in form, a refusal, or a server that did not answer.
 */
export default function DashboardSessionGate({ children }: PropsWithChildren) {
  const queryClient = useQueryClient();

  const session = useQuery({
    queryFn: () => sessionService.load(),
    queryKey: sessionService.queryKey,
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });
  const signOut = useMutation({
    mutationFn: () => sessionService.logout(),
    onError: (error) =>
      toast.warning("Logged out in this browser only", {
        description: `The server could not be told: ${error.message}`,
      }),
    onSuccess: () => toast.success("Logged out"),
    // Whether or not the server heard, this browser is done; what was fetched as
    // that member of staff goes once the pages are gone (below).
    onSettled: () => {
      queryClient.setQueryData<SessionState>(sessionService.queryKey, {
        status: "signed-out",
      });
    },
  });

  const state = session.data;

  // However the session ended, what the pages fetched is not for whoever signs in
  // next. It goes once the pages are gone, since emptying the cache while they are
  // there only makes them ask again.
  const signedOut = state?.status === "signed-out";
  useEffect(() => {
    if (!signedOut) return;

    queryClient.removeQueries({
      predicate: ({ queryKey }) => queryKey[1] !== sessionService.queryKey[1],
    });
  }, [queryClient, signedOut]);

  if (session.isPending) {
    return (
      <DashboardGateScreen title="Checking your session…">
        <div className="sr-only" role="status">
          Loading
        </div>
      </DashboardGateScreen>
    );
  }

  if (!state || state.status === "unavailable") {
    return (
      <DashboardGateScreen
        description="Check the network or the server and try again."
        title="Cannot reach the server"
      >
        <Button
          className="w-full"
          disabled={session.isFetching}
          onClick={() => void session.refetch()}
        >
          Try again
        </Button>
      </DashboardGateScreen>
    );
  }

  if (state.status === "signed-out") return <DashboardLogin />;

  if (state.status === "forbidden") {
    return (
      <DashboardGateScreen
        description={
          state.username
            ? `The account ${state.username} is not on the staff list, or its access has been switched off. Send this username to the shop owner.`
            : "This account is not on the staff list, or its access has been switched off. Ask the shop owner to check."
        }
        title="No access to the dashboard"
      >
        <Button
          className="w-full"
          disabled={signOut.isPending}
          variant="outline"
          onClick={() => signOut.mutate()}
        >
          Log out
        </Button>
      </DashboardGateScreen>
    );
  }

  return (
    <DashboardSession
      identity={state.identity}
      onSignOut={() => signOut.mutate()}
    >
      {children}
    </DashboardSession>
  );
}
