import { useMemo, useState } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import { Bot, CheckCircle2, ExternalLink, LoaderCircle } from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import agentConnectionsService, {
  AgentConnectionServiceError,
  type AgentConnection,
  type AgentProvider,
} from "@/services/agent-connections";

interface CallbackFormValues {
  callbackUrl: string;
}

interface AgentsConnectDialogProps {
  onConnected?: () => void;
}

interface AgentProviderOptionProps {
  connectedCount: number;
  disabled: boolean;
  label: string;
  onConnect: (provider: AgentProvider) => void;
  provider: AgentProvider;
}

interface CompleteConnectionVariables {
  callbackUrl: string;
  connectionId: string;
}

const callbackSchema = z.object({
  callbackUrl: z
    .string()
    .trim()
    .min(1, "Paste the callback URL or authorization code."),
});

const providers: Array<{ label: string; provider: AgentProvider }> = [
  { label: "ChatGPT", provider: "chatgpt" },
  { label: "Claude", provider: "claude" },
  { label: "Grok", provider: "grok" },
];

function AgentProviderOption({
  connectedCount,
  disabled,
  label,
  onConnect,
  provider,
}: AgentProviderOptionProps) {
  return (
    <li>
      <Button
        className="h-auto w-full justify-between p-3"
        disabled={disabled}
        onClick={() => onConnect(provider)}
        type="button"
        variant="outline"
      >
        <Flex className="items-center gap-3">
          <Center className="size-8 rounded-lg bg-slate-100 text-slate-700">
            <Bot aria-hidden="true" className="size-4" />
          </Center>
          <span>{label}</span>
        </Flex>

        <Flex className="items-center gap-2">
          {connectedCount > 0 ? (
            <Badge className="bg-emerald-50 text-emerald-700">
              {connectedCount} connected
            </Badge>
          ) : null}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </Flex>
      </Button>
    </li>
  );
}

export default function AgentsConnectDialog({
  onConnected,
}: AgentsConnectDialogProps) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeConnection, setActiveConnection] =
    useState<AgentConnection | null>(null);
  const [popupError, setPopupError] = useState<string | null>(null);
  const form = useForm<CallbackFormValues>({
    defaultValues: { callbackUrl: "" },
    resolver: zodResolver(callbackSchema),
  });
  const connectionQueryKey = useMemo(
    () => [...agentConnectionsService.queryKey, session.user?.id ?? "guest"],
    [session.user?.id],
  );
  const connectionsQuery = useQuery({
    enabled: open && Boolean(session.user),
    queryFn: agentConnectionsService.list,
    queryKey: connectionQueryKey,
  });
  const startMutation = useMutation({
    mutationFn: agentConnectionsService.start,
  });
  const completeMutation = useMutation({
    mutationFn: ({ callbackUrl, connectionId }: CompleteConnectionVariables) =>
      agentConnectionsService.complete(connectionId, callbackUrl),
  });
  const pollConnectionId =
    activeConnection?.status === "pending" &&
    !activeConnection.authorization?.requiresCallbackUrl
      ? activeConnection.id
      : null;
  const connectionStatusQuery = useQuery({
    queryFn: pollConnectionId
      ? () => agentConnectionsService.get(pollConnectionId)
      : skipToken,
    queryKey: [...agentConnectionsService.queryKey, "status", pollConnectionId],
    refetchInterval: (query) =>
      query.state.data?.status === "pending"
        ? (activeConnection?.authorization?.pollAfterSeconds ?? 5) * 1_000
        : false,
  });
  const connections = connectionsQuery.data ?? [];
  const currentConnection = connectionStatusQuery.data ?? activeConnection;
  const requestError =
    connectionsQuery.error ??
    startMutation.error ??
    completeMutation.error ??
    connectionStatusQuery.error;
  const errorMessage =
    popupError ??
    (requestError
      ? requestError instanceof AgentConnectionServiceError
        ? requestError.message
        : "Connections could not be loaded."
      : null);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !session.user) {
      session.openAuth();
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setActiveConnection(null);
      setPopupError(null);
      startMutation.reset();
      completeMutation.reset();
      form.reset();
    }
  }

  async function connect(provider: AgentProvider) {
    const popup = window.open(
      "about:blank",
      "hub-william-agent-connect",
      "popup,width=720,height=820",
    );
    if (!popup) {
      setPopupError("Allow popups for Hub William, then try again.");
      return;
    }
    popup.opener = null;
    setPopupError(null);

    try {
      const connection = await startMutation.mutateAsync(provider);
      if (!connection.authorization) {
        popup.close();
        throw new AgentConnectionServiceError(
          "The provider did not return an authorization page.",
        );
      }
      popup.location.replace(connection.authorization.authorizationUrl);
      setActiveConnection(connection);
      queryClient.setQueryData<AgentConnection[]>(
        connectionQueryKey,
        (items) => [...(items ?? []), connection],
      );
    } catch (error) {
      popup.close();
      if (!(error instanceof AgentConnectionServiceError)) {
        setPopupError("The provider authorization could not be started.");
      }
    }
  }

  async function complete(values: CallbackFormValues) {
    if (!currentConnection) return;

    try {
      const connection = await completeMutation.mutateAsync({
        callbackUrl: values.callbackUrl,
        connectionId: currentConnection.id,
      });
      setActiveConnection(connection);
      queryClient.setQueryData<AgentConnection[]>(
        connectionQueryKey,
        (items) => [
          ...(items ?? []).filter((item) => item.id !== connection.id),
          connection,
        ],
      );
      if (connection.status === "connected") onConnected?.();
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof AgentConnectionServiceError
            ? error.message
            : "The authorization code could not be exchanged.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 px-4" aria-label="Connect Agent">
          Connect Agent
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <Center className="mb-1 size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600">
            <Bot aria-hidden="true" className="size-5" />
          </Center>
          <DialogTitle>Connect an agent account</DialogTitle>
          <DialogDescription>
            Hub William opens the provider&apos;s official authorization page.
            Passwords never pass through this app.
          </DialogDescription>
        </DialogHeader>

        <ul className="grid gap-2">
          {providers.map(({ label, provider }) => (
            <AgentProviderOption
              key={provider}
              connectedCount={
                connections.filter(
                  (connection) =>
                    connection.provider === provider &&
                    connection.status === "connected",
                ).length
              }
              disabled={startMutation.isPending}
              label={label}
              onConnect={connect}
              provider={provider}
            />
          ))}
        </ul>

        {startMutation.isPending ? (
          <Flex className="items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
            Requesting a secure authorization code…
          </Flex>
        ) : null}

        {currentConnection?.status === "pending" ? (
          <Alert>
            <LoaderCircle aria-hidden="true" className="animate-spin" />
            <AlertTitle>Waiting for authorization</AlertTitle>
            <AlertDescription>
              Finish signing in on the provider page.
              {currentConnection.authorization?.userCode
                ? ` Confirm code ${currentConnection.authorization.userCode}.`
                : ""}
            </AlertDescription>
          </Alert>
        ) : null}

        {currentConnection?.status === "connected" ? (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>Agent connected</AlertTitle>
            <AlertDescription>
              The credential is encrypted server-side and ready for this pool.
            </AlertDescription>
          </Alert>
        ) : null}

        {currentConnection?.authorization?.requiresCallbackUrl ? (
          <form className="space-y-3" onSubmit={form.handleSubmit(complete)}>
            <div className="space-y-1.5">
              <Label htmlFor="agent-callback-url">Callback URL or code</Label>
              <Input
                id="agent-callback-url"
                autoComplete="off"
                placeholder="Paste the URL shown after authorization"
                aria-invalid={Boolean(form.formState.errors.callbackUrl)}
                {...form.register("callbackUrl")}
              />
              {form.formState.errors.callbackUrl ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.callbackUrl.message}
                </p>
              ) : null}
            </div>
            {form.formState.errors.root ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.root.message}
              </p>
            ) : null}
            <Button
              type="submit"
              disabled={
                form.formState.isSubmitting || completeMutation.isPending
              }
            >
              {form.formState.isSubmitting
                ? "Connecting…"
                : "Complete connection"}
            </Button>
          </form>
        ) : null}

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Connection failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
