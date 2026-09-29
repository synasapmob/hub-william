import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  skipToken,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Bot,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { toast } from "sonner";

import AgentsProviderIcon from "@/components/agents-provider-icon";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import agentConnectionsService, {
  AgentConnectionServiceError,
  type AgentConnection,
  type AgentProvider,
} from "@/services/agent-connections";
import agentPoolsService from "@/services/agent-pools";
import organizationsService from "@/services/organizations";
import playgroundService from "@/services/playground";
import { agentAvailabilityStatusLabel } from "@/utils/utils.agent-pools";

import providerCatalogue from "@/services/provider-catalogue";
import type { ApiKeyProviderId } from "@/services/provider-catalogue.generated";

interface ConnectionFormValues {
  apiKey: string;
  callbackUrl: string;
}

interface AgentsConnectDialogProps {
  onAddExisting?: (connection: AgentConnection) => Promise<void>;
  onConnected?: (connection: AgentConnection) => Promise<void> | void;
  sharedConnectionIds?: string[];
}

interface AgentProviderOptionProps {
  disabled: boolean;
  label: string;
  onConnect: (provider: AgentProvider) => void;
  provider: AgentProvider;
}

interface CompleteConnectionVariables {
  callbackUrl: string;
  connectionId: string;
}

const providers = providerCatalogue.list("connect").map((provider) => ({
  label: provider.connect_label,
  provider: provider.id,
}));

const apiKeyProviders = new Intl.ListFormat("en-GB").format(
  providers
    .filter((option) => providerCatalogue.isApiKeyProvider(option.provider))
    .map((option) => option.label),
);

function AgentProviderOption({
  disabled,
  label,
  onConnect,
  provider,
}: AgentProviderOptionProps) {
  return (
    <li>
      <Button
        className="h-auto w-full flex-wrap justify-between gap-3 p-3"
        disabled={disabled}
        onClick={() => onConnect(provider)}
        type="button"
        variant="outline"
      >
        <Flex className="items-center gap-3">
          <Center className="size-8 rounded-lg bg-slate-100 text-slate-700">
            <AgentsProviderIcon provider={provider} />
          </Center>
          <span>{label}</span>
        </Flex>

        {providerCatalogue.isApiKeyProvider(provider) ? (
          <KeyRound aria-hidden="true" className="size-3.5" />
        ) : (
          <ExternalLink aria-hidden="true" className="size-3.5" />
        )}
      </Button>
    </li>
  );
}

export default function AgentsConnectDialog({
  onAddExisting,
  onConnected,
  sharedConnectionIds = [],
}: AgentsConnectDialogProps) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [activeConnection, setActiveConnection] =
    useState<AgentConnection | null>(null);
  const [keyProvider, setKeyProvider] = useState<ApiKeyProviderId | null>(null);
  const keyProviderLabel = keyProvider
    ? providerCatalogue.byId(keyProvider).label
    : "";
  const [popupError, setPopupError] = useState<string | null>(null);
  const [addingExistingId, setAddingExistingId] = useState<string | null>(null);
  const [shareProvider, setShareProvider] = useState<AgentProvider>("chatgpt");
  const notifiedConnectionIds = useRef(new Set<string>());
  const connectionSchema = z
    .object({
      apiKey: z.string().trim(),
      callbackUrl: z.string(),
    })
    .superRefine((values, context) => {
      if (
        keyProvider &&
        (values.apiKey.length < 20 ||
          values.apiKey.length > 512 ||
          !/^[A-Za-z0-9_-]+$/.test(values.apiKey))
      ) {
        context.addIssue({
          code: "custom",
          path: ["apiKey"],
          message: `Enter a valid ${keyProviderLabel} API key.`,
        });
      }
    });
  const form = useForm<ConnectionFormValues>({
    defaultValues: { apiKey: "", callbackUrl: "" },
    resolver: zodResolver(connectionSchema),
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
  const keyMutation = useMutation({
    mutationFn: (apiKey: string) =>
      agentConnectionsService.connectApiKey(keyProvider!, apiKey),
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
  const availableConnections = connections.filter(
    (connection) =>
      connection.status === "connected" &&
      !sharedConnectionIds.includes(connection.id),
  );
  const shareProviders = providers.filter((option) =>
    connections.some(
      (connection) =>
        connection.status === "connected" &&
        connection.provider === option.provider,
    ),
  );
  const selectedShareProvider =
    shareProviders.find((option) => option.provider === shareProvider) ??
    shareProviders[0];
  const filteredConnections = availableConnections.filter(
    (connection) => connection.provider === selectedShareProvider?.provider,
  );
  const currentConnection = connectionStatusQuery.data ?? activeConnection;
  const requestError =
    connectionsQuery.error ??
    startMutation.error ??
    completeMutation.error ??
    keyMutation.error ??
    connectionStatusQuery.error;
  const errorMessage =
    popupError ??
    (requestError
      ? requestError instanceof AgentConnectionServiceError
        ? requestError.message
        : "Connections could not be loaded."
      : null);

  const notifyConnected = useCallback(
    async (connection: AgentConnection) => {
      if (notifiedConnectionIds.current.has(connection.id)) return;
      notifiedConnectionIds.current.add(connection.id);
      await Promise.all(
        [
          agentPoolsService.queryKey,
          organizationsService.queryKey,
          playgroundService.queryKey,
        ].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
      );
      try {
        await onConnected?.(connection);
      } catch (error) {
        setPopupError(
          error instanceof Error
            ? `Agent connected, but it could not be added: ${error.message}`
            : "Agent connected, but it could not be added. Share it from the connected agents list above.",
        );
      }
    },
    [onConnected, queryClient],
  );

  useEffect(() => {
    const connection = connectionStatusQuery.data;
    if (
      connection?.status !== "connected" ||
      notifiedConnectionIds.current.has(connection.id)
    )
      return;
    setActiveConnection(connection);
    queryClient.setQueryData<AgentConnection[]>(connectionQueryKey, (items) => [
      ...(items ?? []).filter((item) => item.id !== connection.id),
      connection,
    ]);
    void notifyConnected(connection);
  }, [
    connectionQueryKey,
    connectionStatusQuery.data,
    notifyConnected,
    queryClient,
  ]);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !session.user) {
      session.openAuth();
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      notifiedConnectionIds.current.clear();
      setActiveConnection(null);
      setPopupError(null);
      setKeyProvider(null);
      startMutation.reset();
      completeMutation.reset();
      keyMutation.reset();
      form.reset();
    }
  }

  async function addExisting(connection: AgentConnection) {
    if (!onAddExisting) return;
    setAddingExistingId(connection.id);
    setPopupError(null);
    try {
      await onAddExisting(connection);
      toast.success(
        `${connection.accountLabel ?? "Agent"} shared with the organization.`,
      );
    } catch (error) {
      setPopupError(
        error instanceof Error
          ? error.message
          : "The agent could not be added to the organization.",
      );
    } finally {
      setAddingExistingId(null);
    }
  }

  async function connect(provider: AgentProvider) {
    if (providerCatalogue.isApiKeyProvider(provider)) {
      setActiveConnection(null);
      setPopupError(null);
      setKeyProvider(provider);
      form.reset();
      keyMutation.reset();
      return;
    }
    setKeyProvider(null);
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

  async function complete(values: ConnectionFormValues) {
    if (!currentConnection) return;
    const callbackUrl = values.callbackUrl.trim();
    if (!callbackUrl) {
      form.setError("callbackUrl", {
        message: "Paste the callback URL or authorization code.",
      });
      return;
    }

    try {
      const connection = await completeMutation.mutateAsync({
        callbackUrl,
        connectionId: currentConnection.id,
      });
      setActiveConnection(connection);
      queryClient.setQueryData<AgentConnection[]>(
        connectionQueryKey,
        (items) => [
          ...(items ?? []).filter(
            (item) =>
              item.id !== connection.id && item.id !== currentConnection.id,
          ),
          connection,
        ],
      );
      if (connection.status === "connected") await notifyConnected(connection);
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

  async function connectApiKey(values: ConnectionFormValues) {
    const apiKey = values.apiKey.trim();
    try {
      const connection = await keyMutation.mutateAsync(apiKey);
      setActiveConnection(connection);
      setKeyProvider(null);
      queryClient.setQueryData<AgentConnection[]>(
        connectionQueryKey,
        (items) => [
          ...(items ?? []).filter((item) => item.id !== connection.id),
          connection,
        ],
      );
      await notifyConnected(connection);
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof AgentConnectionServiceError
            ? error.message
            : `The ${keyProviderLabel} API key could not be connected.`,
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 px-4" type="button">
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
            Subscription accounts open their official authorization page.
            {apiKeyProviders} connect with your API key.
          </DialogDescription>
        </DialogHeader>

        {onAddExisting && shareProviders.length > 0 ? (
          <section className="space-y-2 border-b border-zinc-200 pb-4">
            <Flex className="flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Share a connected agent</h3>

              <Select
                value={selectedShareProvider?.provider}
                onValueChange={(value: AgentProvider) =>
                  setShareProvider(value)
                }
                disabled={addingExistingId !== null}
              >
                <SelectTrigger
                  aria-label="Filter connected agents by provider"
                  className="h-10! w-auto min-w-28"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {shareProviders.map((option) => (
                    <SelectItem key={option.provider} value={option.provider}>
                      <AgentsProviderIcon provider={option.provider} />
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Flex>

            <p className="text-xs text-muted-foreground">
              Add your existing account without signing in again. The
              organization gets a link to your Workspace account, not a copy, so
              refreshing, reconnecting or deleting it in Workspace applies here
              too.
            </p>

            {!filteredConnections.length ? (
              <p className="py-2 text-sm text-muted-foreground">
                All your {selectedShareProvider?.label} accounts are already
                shared.
              </p>
            ) : (
              <ul className="max-h-40 space-y-1.5 overflow-y-auto">
                {filteredConnections.map((connection) => (
                  <li key={connection.id}>
                    <Button
                      aria-label={`Add ${selectedShareProvider?.label} ${connection.accountLabel ?? "Connected account"} to organization`}
                      className="h-auto w-full justify-between gap-2 px-3 py-2 text-left"
                      disabled={addingExistingId !== null}
                      onClick={() => void addExisting(connection)}
                      type="button"
                      variant="outline"
                    >
                      <Flex className="min-w-0 gap-2">
                        <AgentsProviderIcon provider={connection.provider} />

                        <div className="min-w-0 space-y-1">
                          <p className="truncate">
                            {connection.accountLabel ?? "Connected account"}
                          </p>

                          <p className="text-xs text-muted-foreground">
                            {agentAvailabilityStatusLabel(
                              connection.availabilityStatus,
                            )}
                          </p>
                        </div>
                      </Flex>

                      <p className="shrink-0 text-xs">
                        {addingExistingId === connection.id ? "Adding…" : "Add"}
                      </p>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}

        <ul className="grid grid-cols-1 gap-2">
          {providers.map(({ label, provider }) => (
            <AgentProviderOption
              key={provider}
              disabled={startMutation.isPending || keyMutation.isPending}
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

        {keyProvider ? (
          <form
            className="space-y-3"
            onSubmit={(event) => void form.handleSubmit(connectApiKey)(event)}
          >
            <div className="space-y-1.5">
              <Label htmlFor="provider-api-key">
                {keyProviderLabel} API key
              </Label>
              <Input
                id="provider-api-key"
                aria-invalid={Boolean(form.formState.errors.apiKey)}
                autoComplete="off"
                placeholder={
                  keyProvider
                    ? providerCatalogue.byId(keyProvider).auth.key_placeholder
                    : undefined
                }
                type="password"
                {...form.register("apiKey")}
              />
              <p className="text-xs text-muted-foreground">
                Your key is verified with {keyProviderLabel} and stored
                securely.
              </p>
              {form.formState.errors.apiKey ? (
                <p className="text-xs text-destructive">
                  {form.formState.errors.apiKey.message}
                </p>
              ) : null}
            </div>
            {form.formState.errors.root ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.root.message}
              </p>
            ) : null}
            <Button disabled={keyMutation.isPending} type="submit">
              {keyMutation.isPending
                ? "Verifying…"
                : `Connect ${keyProviderLabel}`}
            </Button>
          </form>
        ) : null}

        {currentConnection?.status === "pending" ? (
          <Alert>
            {currentConnection.authorization?.requiresCallbackUrl ? (
              <ExternalLink aria-hidden="true" />
            ) : (
              <LoaderCircle aria-hidden="true" className="animate-spin" />
            )}
            <AlertTitle>
              {currentConnection.authorization?.requiresCallbackUrl
                ? "Paste the callback URL"
                : "Waiting for authorization"}
            </AlertTitle>
            <AlertDescription>
              {currentConnection.authorization?.requiresCallbackUrl
                ? "Finish signing in, then copy the final callback URL from the browser and paste it below."
                : `Finish signing in on the provider page.${
                    currentConnection.authorization?.userCode
                      ? ` Confirm code ${currentConnection.authorization.userCode}.`
                      : ""
                  }`}
            </AlertDescription>
          </Alert>
        ) : null}

        {currentConnection?.status === "connected" ? (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>Agent connected</AlertTitle>
            <AlertDescription>
              The credential is encrypted server-side and ready for access you
              grant.
            </AlertDescription>
          </Alert>
        ) : null}

        {currentConnection?.authorization?.requiresCallbackUrl ? (
          <form
            className="space-y-3"
            onSubmit={(event) => void form.handleSubmit(complete)(event)}
          >
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
            <AlertTitle>Connection issue</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
