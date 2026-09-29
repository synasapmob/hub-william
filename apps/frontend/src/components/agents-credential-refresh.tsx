import { useEffect, useState, type ReactNode } from "react";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckCircle2, LoaderCircle, RefreshCw } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import agentConnectionsService, {
  AgentConnectionServiceError,
  type AgentConnection,
} from "@/services/agent-connections";

interface CallbackFormValues {
  callbackUrl: string;
}

interface CompleteConnectionVariables {
  callbackUrl: string;
  connectionId: string;
}

interface AgentsCredentialRefreshProps {
  children?: ReactNode;
  disabled: boolean;
  onRefresh: () => Promise<AgentConnection>;
  onRefreshComplete: (connection: AgentConnection) => void;
}

export default function AgentsCredentialRefresh({
  children,
  disabled,
  onRefresh,
  onRefreshComplete,
}: AgentsCredentialRefreshProps) {
  const [refreshConnection, setRefreshConnection] =
    useState<AgentConnection | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const callbackSchema = z.object({
    callbackUrl: z
      .string()
      .trim()
      .min(1, "Paste the callback URL or authorization code."),
  });
  const callbackForm = useForm<CallbackFormValues>({
    defaultValues: { callbackUrl: "" },
    resolver: zodResolver(callbackSchema),
  });
  const pollConnectionId =
    refreshConnection?.authorization &&
    !refreshConnection.authorization.requiresCallbackUrl
      ? refreshConnection.id
      : null;
  const connectionStatusQuery = useQuery({
    queryFn: pollConnectionId
      ? () => agentConnectionsService.get(pollConnectionId)
      : skipToken,
    queryKey: [
      ...agentConnectionsService.queryKey,
      "refresh-status",
      pollConnectionId,
    ],
    refetchInterval: (query) =>
      query.state.data?.authorization
        ? (query.state.data.authorization.pollAfterSeconds ?? 5) * 1_000
        : false,
  });
  const completeMutation = useMutation({
    mutationFn: ({ callbackUrl, connectionId }: CompleteConnectionVariables) =>
      agentConnectionsService.complete(connectionId, callbackUrl),
  });
  const currentRefreshConnection =
    connectionStatusQuery.data ?? refreshConnection;
  const failure =
    refreshError ??
    connectionStatusQuery.error?.message ??
    currentRefreshConnection?.failureMessage;

  useEffect(() => {
    const connection = connectionStatusQuery.data;
    if (
      connection?.status === "connected" &&
      !connection.authorization &&
      !connection.failureMessage
    ) {
      onRefreshComplete(connection);
    }
  }, [connectionStatusQuery.data, onRefreshComplete]);

  async function refreshCredential() {
    const popup = window.open(
      "about:blank",
      "hub-william-agent-refresh",
      "popup,width=720,height=820",
    );
    if (!popup) {
      setRefreshError("Allow popups for Hub William, then try again.");
      return;
    }
    popup.opener = null;
    setRefreshError(null);

    try {
      const connection = await onRefresh();
      setRefreshConnection(connection);
      if (connection.authorization) {
        popup.location.replace(connection.authorization.authorizationUrl);
      } else {
        popup.close();
        onRefreshComplete(connection);
      }
    } catch (error) {
      popup.close();
      setRefreshError(
        error instanceof AgentConnectionServiceError
          ? error.message
          : "The provider credential could not be refreshed.",
      );
    }
  }

  async function completeReauthorization(values: CallbackFormValues) {
    if (!currentRefreshConnection) return;

    try {
      const connection = await completeMutation.mutateAsync({
        callbackUrl: values.callbackUrl,
        connectionId: currentRefreshConnection.id,
      });
      setRefreshConnection(connection);
      callbackForm.reset();
      onRefreshComplete(connection);
    } catch (error) {
      callbackForm.setError("root", {
        message:
          error instanceof AgentConnectionServiceError
            ? error.message
            : "The authorization code could not be exchanged.",
      });
    }
  }

  return (
    <div className="space-y-3">
      <Flex className="flex-wrap items-center gap-2">
        <Button
          disabled={disabled}
          onClick={() => void refreshCredential()}
          size="sm"
          type="button"
          variant="outline"
        >
          <RefreshCw aria-hidden="true" data-icon="inline-start" />
          Refresh
        </Button>

        {children}
      </Flex>

      {currentRefreshConnection?.authorization ? (
        <Alert>
          <LoaderCircle aria-hidden="true" className="animate-spin" />
          <AlertTitle>Waiting for provider authorization</AlertTitle>
          <AlertDescription>
            {currentRefreshConnection.authorization.requiresCallbackUrl
              ? "Finish signing in, then copy the final callback URL from the browser and paste it below."
              : `Finish signing in on the provider page.${
                  currentRefreshConnection.authorization.userCode
                    ? ` Confirm code ${currentRefreshConnection.authorization.userCode}.`
                    : ""
                }`}
          </AlertDescription>
        </Alert>
      ) : null}

      {currentRefreshConnection?.authorization?.requiresCallbackUrl ? (
        <form
          className="space-y-3"
          onSubmit={callbackForm.handleSubmit(completeReauthorization)}
        >
          <div className="space-y-1.5">
            <Label htmlFor="refresh-callback-url">Callback URL or code</Label>
            <Input
              id="refresh-callback-url"
              autoComplete="off"
              placeholder="Paste the URL shown after authorization"
              aria-invalid={Boolean(callbackForm.formState.errors.callbackUrl)}
              {...callbackForm.register("callbackUrl")}
            />
            {callbackForm.formState.errors.callbackUrl ? (
              <p className="text-xs text-destructive">
                {callbackForm.formState.errors.callbackUrl.message}
              </p>
            ) : null}
          </div>

          {callbackForm.formState.errors.root ? (
            <p className="text-xs text-destructive">
              {callbackForm.formState.errors.root.message}
            </p>
          ) : null}

          <Button disabled={completeMutation.isPending} size="sm" type="submit">
            {completeMutation.isPending
              ? "Reconnecting…"
              : "Complete reconnection"}
          </Button>
        </form>
      ) : null}

      {currentRefreshConnection &&
      !currentRefreshConnection.authorization &&
      !currentRefreshConnection.failureMessage ? (
        <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
          <CheckCircle2 aria-hidden="true" />
          <AlertTitle>Provider credential refreshed</AlertTitle>
          <AlertDescription>
            This account is active with the latest provider session everywhere
            it is linked.
          </AlertDescription>
        </Alert>
      ) : null}

      {failure ? (
        <Alert variant="destructive">
          <AlertTitle>Refresh failed</AlertTitle>
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}
