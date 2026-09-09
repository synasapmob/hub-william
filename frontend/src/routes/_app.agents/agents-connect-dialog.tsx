import { useEffect, useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Bot,
  CheckCircle2,
  Copy,
  ExternalLink,
  KeyRound,
  LoaderCircle,
} from "lucide-react";
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
import gatewayKeysService, {
  GatewayKeyServiceError,
  type CreatedGatewayKey,
  type GatewayKey,
} from "@/services/gateway-keys";
import { copyText } from "@/utils/utils.clipboard";

interface CallbackFormValues {
  callbackUrl: string;
}

interface AgentsConnectDialogProps {
  hasSharedGatewayAccess?: boolean;
  onConnected?: () => void;
}

interface AgentProviderOptionProps {
  connection?: AgentConnection;
  disabled: boolean;
  label: string;
  onConnect: (provider: AgentProvider) => void;
  provider: AgentProvider;
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
  connection,
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
          {connection?.status === "connected" ? (
            <Badge className="bg-emerald-50 text-emerald-700">Connected</Badge>
          ) : null}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </Flex>
      </Button>
    </li>
  );
}

export default function AgentsConnectDialog({
  hasSharedGatewayAccess = false,
  onConnected,
}: AgentsConnectDialogProps) {
  const session = useWorkspaceSession();
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [gatewayKeys, setGatewayKeys] = useState<GatewayKey[]>([]);
  const [createdGatewayKey, setCreatedGatewayKey] =
    useState<CreatedGatewayKey | null>(null);
  const [creatingGatewayKey, setCreatingGatewayKey] = useState(false);
  const [activeConnection, setActiveConnection] =
    useState<AgentConnection | null>(null);
  const [startingProvider, setStartingProvider] =
    useState<AgentProvider | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const form = useForm<CallbackFormValues>({
    defaultValues: { callbackUrl: "" },
    resolver: zodResolver(callbackSchema),
  });

  useEffect(() => {
    if (!open || !session.user) return;

    let cancelled = false;
    Promise.all([agentConnectionsService.list(), gatewayKeysService.list()])
      .then(([connectionItems, keyItems]) => {
        if (!cancelled) {
          setConnections(connectionItems);
          setGatewayKeys(keyItems);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setErrorMessage(
            error instanceof AgentConnectionServiceError ||
              error instanceof GatewayKeyServiceError
              ? error.message
              : "Connections could not be loaded.",
          );
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, session.user]);

  useEffect(() => {
    if (
      !open ||
      !activeConnection ||
      activeConnection.status !== "pending" ||
      activeConnection.authorization?.requiresCallbackUrl
    ) {
      return;
    }

    const timeout = window.setTimeout(
      () => {
        agentConnectionsService
          .get(activeConnection.id)
          .then((connection) => {
            setActiveConnection(connection);
            setConnections((items) => [
              ...items.filter((item) => item.provider !== connection.provider),
              connection,
            ]);
            if (connection.status === "connected") onConnected?.();
          })
          .catch((error) => {
            setErrorMessage(
              error instanceof AgentConnectionServiceError
                ? error.message
                : "Authorization status could not be checked.",
            );
          });
      },
      activeConnection.authorization?.pollAfterSeconds
        ? activeConnection.authorization.pollAfterSeconds * 1_000
        : 5_000,
    );

    return () => window.clearTimeout(timeout);
  }, [activeConnection, onConnected, open]);

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !session.user) {
      session.openAuth();
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setActiveConnection(null);
      setErrorMessage(null);
      setStartingProvider(null);
      setCreatedGatewayKey(null);
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
      setErrorMessage("Allow popups for Hub William, then try again.");
      return;
    }
    popup.opener = null;
    setStartingProvider(provider);
    setErrorMessage(null);

    try {
      const connection = await agentConnectionsService.start(provider);
      if (!connection.authorization) {
        popup.close();
        throw new AgentConnectionServiceError(
          "The provider did not return an authorization page.",
        );
      }
      popup.location.replace(connection.authorization.authorizationUrl);
      setActiveConnection(connection);
      setConnections((items) => [
        ...items.filter((item) => item.provider !== provider),
        connection,
      ]);
    } catch (error) {
      popup.close();
      setErrorMessage(
        error instanceof AgentConnectionServiceError
          ? error.message
          : "The provider authorization could not be started.",
      );
    } finally {
      setStartingProvider(null);
    }
  }

  async function complete(values: CallbackFormValues) {
    if (!activeConnection) return;

    try {
      const connection = await agentConnectionsService.complete(
        activeConnection.id,
        values.callbackUrl,
      );
      setActiveConnection(connection);
      setConnections((items) => [
        ...items.filter((item) => item.provider !== connection.provider),
        connection,
      ]);
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

  async function createGatewayKey() {
    setCreatingGatewayKey(true);
    setErrorMessage(null);
    try {
      const key = await gatewayKeysService.create();
      setCreatedGatewayKey(key);
      setGatewayKeys((items) => [key, ...items]);
    } catch (error) {
      setErrorMessage(
        error instanceof GatewayKeyServiceError
          ? error.message
          : "The gateway key could not be created.",
      );
    } finally {
      setCreatingGatewayKey(false);
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
              connection={connections.find(
                (connection) => connection.provider === provider,
              )}
              disabled={startingProvider !== null}
              label={label}
              onConnect={connect}
              provider={provider}
            />
          ))}
        </ul>

        {startingProvider ? (
          <Flex className="items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle
              aria-hidden="true"
              className="size-3.5 animate-spin"
            />
            Requesting a secure authorization code…
          </Flex>
        ) : null}

        {activeConnection?.status === "pending" ? (
          <Alert>
            <LoaderCircle aria-hidden="true" className="animate-spin" />
            <AlertTitle>Waiting for authorization</AlertTitle>
            <AlertDescription>
              Finish signing in on the provider page.
              {activeConnection.authorization?.userCode
                ? ` Confirm code ${activeConnection.authorization.userCode}.`
                : ""}
            </AlertDescription>
          </Alert>
        ) : null}

        {activeConnection?.status === "connected" ? (
          <Alert className="border-emerald-200 bg-emerald-50 text-emerald-800">
            <CheckCircle2 aria-hidden="true" />
            <AlertTitle>Agent connected</AlertTitle>
            <AlertDescription>
              The credential is encrypted server-side and ready for this pool.
            </AlertDescription>
          </Alert>
        ) : null}

        {hasSharedGatewayAccess ||
        connections.some((connection) => connection.status === "connected") ? (
          <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-3">
            <Flex className="items-start justify-between gap-3">
              <div>
                <Flex className="items-center gap-2">
                  <KeyRound aria-hidden="true" className="size-4" />
                  <h3 className="text-sm font-semibold">Gateway API key</h3>
                </Flex>
                <p className="mt-1 text-xs text-muted-foreground">
                  One key configures every selected agent you can access.
                </p>
              </div>
              {gatewayKeys.length > 0 ? (
                <Badge variant="outline">{gatewayKeys.length} active</Badge>
              ) : null}
            </Flex>

            {createdGatewayKey ? (
              <div className="space-y-2">
                <Label htmlFor="created-gateway-key">
                  Copy now — this key is shown once
                </Label>
                <Flex className="items-center gap-2">
                  <Input
                    id="created-gateway-key"
                    className="font-mono text-xs"
                    readOnly
                    value={createdGatewayKey.key}
                  />
                  <Button
                    aria-label="Copy gateway API key"
                    onClick={() => void copyText(createdGatewayKey.key)}
                    size="icon"
                    type="button"
                    variant="outline"
                  >
                    <Copy aria-hidden="true" />
                  </Button>
                </Flex>
              </div>
            ) : (
              <Button
                disabled={creatingGatewayKey}
                onClick={() => void createGatewayKey()}
                type="button"
                variant="outline"
              >
                {creatingGatewayKey ? (
                  <LoaderCircle aria-hidden="true" className="animate-spin" />
                ) : (
                  <KeyRound aria-hidden="true" />
                )}
                {creatingGatewayKey ? "Creating…" : "Create gateway key"}
              </Button>
            )}
          </section>
        ) : null}

        {activeConnection?.authorization?.requiresCallbackUrl ? (
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
            <Button type="submit" disabled={form.formState.isSubmitting}>
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
