import { useCallback, useEffect, useRef, useState } from "react";
import { tv } from "tailwind-variants";
import type { UseFormReturn } from "react-hook-form";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowUp, FlaskConical, Paperclip, Square, X } from "lucide-react";

import AgentsProviderIcon from "@/components/agents-provider-icon";
import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import providerCatalogue from "@/services/provider-catalogue";
import agentPoolsService from "@/services/agent-pools";
import organizationsService from "@/services/organizations";
import { agentPoolAccess } from "@/utils/utils.agent-pools";
import playgroundMedia from "@/utils/utils.playground-media";
import playgroundSpeechPreload from "@/services/playground/playground-speech-preload";
import playgroundService, {
  PlaygroundServiceError,
  type PlaygroundChatOptions,
  type PlaygroundAttachment,
  type PlaygroundProviderId,
} from "@/services/playground";

import readPlaygroundAttachment, {
  PLAYGROUND_FILE_ACCEPT,
} from "@/utils/utils.playground-attachments";

import type { PlaygroundFormValues } from "./route";
import PlaygroundResponse from "./playground-response";
import PlaygroundVoice from "./playground-voice";
import PlaygroundConversation, {
  PlaygroundZoomButton,
} from "./playground-conversation";

interface PlaygroundWorkspaceProps {
  form: UseFormReturn<PlaygroundFormValues>;
}
interface PlaygroundTurn {
  attachments: PlaygroundAttachment[];
  id: string;
  provider: PlaygroundProviderId;
  model: string;
  question: string;
  answer: string;
  error?: string;
  status: "streaming" | "complete" | "interrupted" | "failed";
}

const providers = Object.fromEntries(
  providerCatalogue
    .list("playground")
    .map((provider) => [provider.id, provider]),
) as Record<PlaygroundProviderId, ReturnType<typeof providerCatalogue.byId>>;
const imageProviderNames = providerCatalogue
  .list("playground")
  .filter((provider) => provider.chat_capabilities.includes("image_input"))
  .map((provider) => provider.label);
const imageProviderLabel = new Intl.ListFormat("en-GB", {
  type: "disjunction",
}).format(imageProviderNames);
const imageProviderAndLabel = new Intl.ListFormat("en-GB", {
  type: "conjunction",
}).format(imageProviderNames);
// Keep setup stable during conversations; mounting, selection changes and
// explicit account-management invalidation still load current server data.
const setupQueryOptions = {
  refetchOnWindowFocus: false,
  refetchOnReconnect: false,
};
const chatConversation = tv({
  base: "flex min-w-0 flex-col overflow-hidden border border-border bg-white",
  variants: {
    zoomed: {
      true: "min-h-112",
      false: "h-[calc(100svh-18rem)] min-h-112 max-h-192 rounded-xl",
    },
  },
});
export default function PlaygroundWorkspace({
  form,
}: PlaygroundWorkspaceProps) {
  const session = useWorkspaceSession();
  useEffect(() => {
    if (session.status === "loading") return;
    return playgroundSpeechPreload.preload();
  }, [session.status]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  const exitZoom = useCallback(() => setZoomed(false), []);
  const fileInput = useRef<HTMLInputElement>(null);
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const userId = session.user?.id;
  const organizationId = form.watch("organizationId");
  const organizationRequested = Boolean(organizationId);
  const poolQuery = useQuery({
    ...setupQueryOptions,
    queryKey: [...agentPoolsService.queryKey, userId ?? "guest"],
    queryFn: () => agentPoolsService.list(),
    enabled: session.status !== "loading" && !organizationRequested,
  });
  const organizationsQuery = useQuery({
    ...setupQueryOptions,
    queryKey: [...organizationsService.queryKey, userId ?? "guest"],
    queryFn: organizationsService.list,
    enabled: Boolean(userId),
  });
  const selectedOrganization = (organizationsQuery.data ?? []).find(
    (organization) => organization.id === organizationId,
  );
  const organizationAgentsQuery = useQuery({
    ...setupQueryOptions,
    queryKey: [...organizationsService.queryKey, organizationId, "agents"],
    queryFn: () => organizationsService.agents(organizationId),
    enabled: Boolean(userId && selectedOrganization),
  });
  const savedMode = form.watch("mode");
  const providerIds = Object.keys(providers) as PlaygroundProviderId[];
  const accessibleAccounts = organizationRequested
    ? (selectedOrganization ? (organizationAgentsQuery.data ?? []) : []).map(
        (agent) => ({
          id: agent.id,
          accountLabel: agent.accountLabel ?? "Connected account",
          availabilityStatus: agent.availabilityStatus,
          provider: agent.provider.toLowerCase(),
        }),
      )
    : (poolQuery.data ?? [])
        .filter((pool) => {
          if (!userId) return false;
          const access = agentPoolAccess(pool, session.user?.username ?? null);
          return access === "owner" || access === "joined";
        })
        .map((pool) => ({
          id: pool.id,
          accountLabel: pool.accountLabel,
          availabilityStatus: pool.availability.status,
          provider: providerIds.find(
            (id) => providers[id].label === pool.agent,
          ),
        }));
  const availableProviderIds = providerIds.filter(
    (id) =>
      providerCatalogue.supportsMode(id, savedMode) &&
      accessibleAccounts.some((account) => account.provider === id),
  );
  const requestedProvider = form.watch("provider");
  const legacyProvider =
    availableProviderIds.find((id) => id === requestedProvider) ??
    availableProviderIds[0];
  const mode =
    savedMode === "voice"
      ? legacyProvider &&
        !providerCatalogue.supportsMode(legacyProvider, "call-live")
        ? "call-whisper"
        : "call-live"
      : savedMode;
  const visibleProviderIds = availableProviderIds.filter((id) =>
    providerCatalogue.supportsMode(id, mode),
  );
  const provider =
    visibleProviderIds.find((id) => id === requestedProvider) ??
    visibleProviderIds[0] ??
    "chatgpt";
  const accounts = accessibleAccounts.filter(
    (account) =>
      visibleProviderIds.includes(provider) && account.provider === provider,
  );
  const accountLoading = organizationRequested
    ? organizationsQuery.isPending ||
      Boolean(selectedOrganization && organizationAgentsQuery.isPending)
    : poolQuery.isPending;
  const selectedAccount =
    accounts.find((pool) => pool.id === form.watch("connectionId")) ??
    accounts.find(
      (account) => account.availabilityStatus !== "reauth_required",
    ) ??
    accounts[0];
  const connectionId = selectedAccount?.id;
  const needsReconnect =
    selectedAccount?.availabilityStatus === "reauth_required";

  useEffect(() => {
    if (
      savedMode !== "voice" ||
      !legacyProvider ||
      accountLoading ||
      session.status === "loading"
    )
      return;
    form.setValue("mode", mode);
    playgroundMedia.writeMode(mode);
  }, [accountLoading, form, legacyProvider, mode, savedMode, session.status]);

  useEffect(() => {
    if (accountLoading) return;
    const nextConnectionId = connectionId ?? "";
    if (form.getValues("connectionId") === nextConnectionId) return;
    form.setValue("connectionId", nextConnectionId);
    form.setValue("model", "");
    form.clearErrors("root");
  }, [accountLoading, connectionId, form]);

  const modelQuery = useQuery({
    ...setupQueryOptions,
    queryKey: [
      ...playgroundService.queryKey,
      "models",
      userId,
      provider,
      connectionId,
      selectedOrganization?.id,
    ],
    queryFn: ({ signal }) =>
      playgroundService.models(
        provider,
        connectionId!,
        signal,
        selectedOrganization?.id,
      ),
    enabled: Boolean(
      userId &&
      connectionId &&
      !needsReconnect &&
      (!organizationRequested || selectedOrganization),
    ),
  });
  const models = (needsReconnect ? [] : (modelQuery.data ?? [])).filter(
    (entry) => {
      if (mode === "chat" || mode === "call-whisper")
        return entry.modes.includes("chat");
      const profile =
        entry.call ?? providerCatalogue.callProfile(provider, entry.id);
      return (
        entry.modes.includes("voice") &&
        profile?.provider === provider &&
        profile.selector_model === entry.id &&
        providerCatalogue.callMode(profile) === mode
      );
    },
  );
  const currentLineupOnly =
    providers[provider].discovery.strategy === "official_docs";
  const selectedModel =
    models.find((entry) => entry.id === form.watch("model")) ?? models[0];
  const supportsChat = Boolean(selectedModel?.modes.includes("chat"));
  const supportsImages = (
    selectedModel?.capabilities ?? providers[provider].chat_capabilities
  ).includes("image_input");
  const mutation = useMutation({
    mutationFn: (options: PlaygroundChatOptions) =>
      playgroundService.chat(options),
    retry: false,
  });
  const busy = form.formState.isSubmitting || mutation.isPending;
  const attachments = form.watch("attachments");
  const hasMessage = Boolean(form.watch("prompt").trim() || attachments.length);
  const queryError = organizationRequested
    ? (organizationsQuery.error ??
      organizationAgentsQuery.error ??
      modelQuery.error)
    : (poolQuery.error ?? modelQuery.error);
  const conversationError =
    queryError?.message ??
    (organizationRequested &&
    !organizationsQuery.isPending &&
    !selectedOrganization
      ? "This organization is unavailable. Select another organization."
      : form.formState.errors.root?.message);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (viewport.current && followOutput.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [turns]);

  async function submit(values: PlaygroundFormValues) {
    if (mode !== "chat") return;
    if (!values.prompt && !values.attachments.length) return;
    if (session.status === "loading") return;
    if (!session.user) {
      session.openAuth();
      return;
    }
    if (organizationRequested && !selectedOrganization) {
      form.setError("root", {
        message:
          "This organization is unavailable. Select another organization.",
      });
      return;
    }
    if (!connectionId || !selectedModel) {
      form.setError("root", {
        message:
          "Choose an account you can access and an available model first.",
      });
      return;
    }
    if (!supportsChat) {
      form.setError("root", {
        message: "Choose an available chat model first.",
      });
      return;
    }
    if (readingFiles) return;
    if (
      !supportsImages &&
      [
        ...values.attachments,
        ...turns
          .filter((turn) => turn.status === "complete")
          .flatMap((turn) => turn.attachments),
      ].some((file) => file.kind === "image")
    ) {
      form.setError("root", {
        message: `Choose ${imageProviderLabel} for image input, or start a new conversation without images.`,
      });
      return;
    }
    form.clearErrors("root");
    const request = new AbortController();
    controller.current = request;
    const id = crypto.randomUUID();
    const history = turns
      .filter((turn) => turn.status === "complete")
      .flatMap((turn) => [
        {
          role: "user" as const,
          content: turn.question,
          attachments: turn.attachments,
        },
        { role: "assistant" as const, content: turn.answer },
      ]);
    followOutput.current = true;
    setTurns((current) => [
      ...current,
      {
        id,
        provider,
        model: selectedModel.name,
        question: values.prompt,
        attachments: values.attachments,
        answer: "",
        status: "streaming",
      },
    ]);
    form.resetField("prompt");
    form.setValue("attachments", []);
    try {
      await mutation.mutateAsync({
        provider,
        connectionId,
        organizationId: selectedOrganization?.id,
        model: selectedModel.id,
        messages: [
          ...history,
          {
            role: "user",
            content: values.prompt,
            attachments: values.attachments,
          },
        ],
        signal: request.signal,
        onDelta: (text) => {
          if (mounted.current)
            setTurns((current) =>
              current.map((turn) =>
                turn.id === id ? { ...turn, answer: turn.answer + text } : turn,
              ),
            );
        },
      });
      if (!mounted.current) return;
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id ? { ...turn, status: "complete" } : turn,
        ),
      );
    } catch (error) {
      if (!mounted.current) return;
      setTurns((current) =>
        current.map((turn) =>
          turn.id === id
            ? {
                ...turn,
                status: request.signal.aborted ? "interrupted" : "failed",
                error: request.signal.aborted
                  ? undefined
                  : error instanceof Error
                    ? error.message
                    : "The request failed. Please try again.",
              }
            : turn,
        ),
      );
      if (!request.signal.aborted) {
        if (error instanceof PlaygroundServiceError && error.status === 401)
          session.openAuth();
      } else {
        form.setValue("prompt", values.prompt);
        form.setValue("attachments", values.attachments);
      }
    } finally {
      if (controller.current === request) controller.current = null;
    }
  }

  async function addFiles(files: File[]) {
    if (attachments.length + files.length > 4) {
      form.setError("root", { message: "Attach up to 4 files per message." });
      return;
    }
    setReadingFiles(true);
    form.clearErrors("root");
    try {
      const uploaded = await Promise.all(files.map(readPlaygroundAttachment));
      if (!mounted.current) return;
      if (!supportsImages && uploaded.some((file) => file.kind === "image"))
        throw new Error(
          `Image input is available with ${imageProviderAndLabel}. This provider accepts text files and PDF text.`,
        );
      form.setValue(
        "attachments",
        [...form.getValues("attachments"), ...uploaded],
        { shouldValidate: true },
      );
    } catch (error) {
      if (mounted.current)
        form.setError("root", {
          message:
            error instanceof Error
              ? error.message
              : "The files could not be read.",
        });
    } finally {
      if (mounted.current) setReadingFiles(false);
    }
  }

  function newConversation() {
    setTurns([]);
    form.resetField("prompt");
    form.setValue("attachments", []);
    form.clearErrors();
    mutation.reset();
    form.setFocus("prompt");
  }

  return (
    <form onSubmit={(event) => void form.handleSubmit(submit)(event)}>
      <PlaygroundConversation zoomed={zoomed} onExitZoom={exitZoom}>
        <div className="space-y-5">
          <section className="space-y-4 rounded-xl border border-border bg-white p-5">
            <header>
              <h2 className="text-sm font-semibold">Setup</h2>
            </header>

            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
              <div className="space-y-2">
                <Label htmlFor="playground-organization">Organization</Label>
                <Select
                  disabled={busy || voiceActive || readingFiles || !userId}
                  onValueChange={(value) => {
                    form.setValue(
                      "organizationId",
                      value === "personal" ? "" : value,
                    );
                    form.setValue("connectionId", "");
                    form.setValue("model", "");
                    form.clearErrors("root");
                    setTurns([]);
                  }}
                  value={organizationId || "personal"}
                >
                  <SelectTrigger
                    className="h-11! w-full min-w-0 bg-white"
                    id="playground-organization"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="personal">Personal</SelectItem>
                    {(organizationsQuery.data ?? []).map((organization) => (
                      <SelectItem key={organization.id} value={organization.id}>
                        {organization.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!organizationRequested && organizationsQuery.error ? (
                  <div className="space-y-2">
                    <p className="text-xs text-destructive">
                      Organizations could not be loaded.
                    </p>
                    <Button
                      className="min-h-11"
                      onClick={() => void organizationsQuery.refetch()}
                      size="sm"
                      type="button"
                      variant="outline"
                    >
                      Retry organizations
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="space-y-2">
                <Label htmlFor="playground-mode">Mode</Label>
                <Select
                  value={mode}
                  disabled={busy || readingFiles}
                  onValueChange={(value) => {
                    if (
                      value !== "chat" &&
                      value !== "call-live" &&
                      value !== "call-whisper"
                    )
                      return;
                    form.setValue("mode", value);
                    playgroundMedia.writeMode(value);
                    form.setValue("model", "");
                    const nextProvider =
                      providerCatalogue.supportsMode(provider, value) &&
                      visibleProviderIds.includes(provider)
                        ? provider
                        : (providerIds.find(
                            (id) =>
                              providerCatalogue.supportsMode(id, value) &&
                              accessibleAccounts.some(
                                (account) => account.provider === id,
                              ),
                          ) ?? "");
                    form.setValue("provider", nextProvider);
                    if (nextProvider !== provider) {
                      form.setValue("connectionId", "");
                    }
                    form.clearErrors("root");
                  }}
                >
                  <SelectTrigger
                    id="playground-mode"
                    className="h-11! w-full min-w-0 bg-white"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="chat">Chat</SelectItem>
                    <SelectItem value="call-live">Call Live</SelectItem>
                    <SelectItem value="call-whisper">Call Whisper</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="playground-provider">Provider</Label>
                <Select
                  disabled={
                    busy ||
                    voiceActive ||
                    readingFiles ||
                    accountLoading ||
                    !visibleProviderIds.length
                  }
                  onValueChange={(value) => {
                    if (!visibleProviderIds.some((id) => id === value)) return;
                    form.setValue("provider", value);
                    form.setValue("connectionId", "");
                    form.setValue("model", "");
                    form.clearErrors("root");
                  }}
                  value={visibleProviderIds.length ? provider : ""}
                >
                  <SelectTrigger
                    className="h-11! w-full min-w-0 bg-white"
                    id="playground-provider"
                  >
                    <SelectValue
                      placeholder={
                        accountLoading
                          ? "Loading providers…"
                          : "No providers available"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {visibleProviderIds.map((id) => (
                      <SelectItem key={id} value={id}>
                        <AgentsProviderIcon provider={id} />
                        <span>
                          {providers[id].label} (
                          {
                            accessibleAccounts.filter(
                              (account) => account.provider === id,
                            ).length
                          }
                          )
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="playground-account">Account</Label>
                <Select
                  disabled={
                    busy ||
                    voiceActive ||
                    readingFiles ||
                    !userId ||
                    accountLoading ||
                    !accounts.length
                  }
                  onValueChange={(value) => {
                    form.setValue("connectionId", value);
                    form.setValue("model", "");
                    form.clearErrors("root");
                  }}
                  value={selectedAccount?.id ?? ""}
                >
                  <SelectTrigger
                    className="h-11! w-full min-w-0 bg-white"
                    id="playground-account"
                  >
                    <SelectValue
                      placeholder={
                        userId && accountLoading
                          ? "Loading accounts…"
                          : "Sign in to continue"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map((account) => (
                      <SelectItem key={account.id} value={account.id}>
                        {account.accountLabel}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="playground-model">Model</Label>
                <Select
                  disabled={
                    busy ||
                    voiceActive ||
                    readingFiles ||
                    modelQuery.isFetching ||
                    !models.length
                  }
                  onValueChange={(value) => {
                    form.setValue("model", value);
                    form.clearErrors("root");
                  }}
                  value={selectedModel?.id ?? ""}
                >
                  <SelectTrigger
                    className="h-11! w-full min-w-0 bg-white"
                    id="playground-model"
                  >
                    <SelectValue
                      placeholder={
                        !connectionId
                          ? "Sign in to continue"
                          : modelQuery.isFetching
                            ? "Loading models…"
                            : mode !== "chat"
                              ? "No call models available"
                              : currentLineupOnly
                                ? "No current models available"
                                : "No models available"
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {models.map((entry) => (
                      <SelectItem key={entry.id} value={entry.id}>
                        {mode === "chat" ? entry.name : entry.id}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {needsReconnect ? (
              <div className="space-y-2">
                <p className="text-sm text-destructive">
                  This account needs provider reauthorization or verification.
                  Its owner must reconnect it in Agents. You can choose another
                  account.
                </p>

                <Button
                  disabled={
                    organizationRequested
                      ? organizationAgentsQuery.isFetching
                      : poolQuery.isFetching
                  }
                  onClick={() =>
                    void (organizationRequested
                      ? organizationAgentsQuery.refetch()
                      : poolQuery.refetch())
                  }
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Refresh account status
                </Button>
              </div>
            ) : null}
          </section>

          {conversationError ? (
            <div className="space-y-3">
              <p role="alert" className="text-sm/relaxed text-destructive">
                {conversationError}
              </p>

              {queryError ? (
                <Button
                  type="button"
                  variant="outline"
                  disabled={
                    (organizationRequested
                      ? organizationsQuery.isFetching ||
                        organizationAgentsQuery.isFetching
                      : poolQuery.isFetching) || modelQuery.isFetching
                  }
                  onClick={() => {
                    if (organizationRequested) {
                      if (organizationsQuery.error)
                        void organizationsQuery.refetch();
                      if (organizationAgentsQuery.error)
                        void organizationAgentsQuery.refetch();
                    } else if (poolQuery.error) {
                      void poolQuery.refetch();
                    }
                    if (modelQuery.error) void modelQuery.refetch();
                  }}
                >
                  Retry loading
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {mode !== "chat" ? (
          <PlaygroundVoice
            key={`${mode}:${connectionId}:${selectedModel?.id}`}
            connectionId={connectionId}
            organizationId={selectedOrganization?.id}
            provider={provider}
            model={selectedModel?.id}
            callProfile={selectedModel?.call}
            mode={mode}
            disabled={
              accountLoading ||
              modelQuery.isFetching ||
              Boolean(conversationError)
            }
            zoomed={zoomed}
            onToggleZoom={() => setZoomed((value) => !value)}
            onActiveChange={setVoiceActive}
          />
        ) : (
          <section className={chatConversation({ zoomed })}>
            <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
              <h2 className="text-sm font-semibold">Your conversation</h2>

              <Flex className="flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  className="min-h-10"
                  disabled={busy || readingFiles || !turns.length}
                  onClick={newConversation}
                >
                  New Chat
                </Button>

                <PlaygroundZoomButton
                  zoomed={zoomed}
                  onToggle={() => setZoomed((value) => !value)}
                />
              </Flex>
            </header>

            <div
              ref={viewport}
              className="min-h-0 flex-1 overflow-y-auto p-5"
              onScroll={() => {
                const node = viewport.current;
                if (node)
                  followOutput.current =
                    node.scrollHeight - node.scrollTop - node.clientHeight < 80;
              }}
            >
              {!turns.length ? (
                <Center className="h-full flex-col gap-4 text-center">
                  <FlaskConical
                    aria-hidden="true"
                    className="size-7 text-zinc-400"
                  />

                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold">
                      What would you like to try?
                    </h3>

                    <p className="text-sm text-muted-foreground">
                      Start with a question or a small idea.
                    </p>
                  </div>
                </Center>
              ) : (
                <div className="space-y-6">
                  {turns.map((turn) => (
                    <article key={turn.id} className="space-y-4">
                      <div className="space-y-2 rounded-lg bg-zinc-50 p-3">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          You
                        </h3>

                        <p className="text-sm/relaxed whitespace-pre-wrap wrap-anywhere">
                          {turn.question}
                        </p>
                        {turn.attachments.length ? (
                          <ul
                            className="flex flex-wrap gap-2"
                            aria-label="Sent attachments"
                          >
                            {turn.attachments.map((file, index) => (
                              <li
                                key={index}
                                className="max-w-full rounded-md border border-border px-2 py-1 text-xs wrap-anywhere"
                              >
                                {file.name}
                              </li>
                            ))}
                          </ul>
                        ) : null}
                      </div>

                      <div className="space-y-2">
                        <h3 className="text-xs font-medium text-muted-foreground">
                          {providers[turn.provider].label} / {turn.model}
                        </h3>

                        {turn.answer ? (
                          <PlaygroundResponse
                            streaming={turn.status === "streaming"}
                            text={turn.answer}
                          />
                        ) : null}

                        {turn.error ? (
                          <p
                            role="alert"
                            className="text-sm/relaxed whitespace-pre-wrap wrap-anywhere text-destructive"
                          >
                            {turn.error}
                          </p>
                        ) : null}

                        {!turn.answer && !turn.error ? (
                          <p className="text-sm/relaxed text-muted-foreground">
                            {turn.status === "streaming"
                              ? "Waiting for the model…"
                              : "No answer received."}
                          </p>
                        ) : null}

                        {turn.status !== "failed" ? (
                          <p className="text-xs text-muted-foreground">
                            {turn.status === "streaming"
                              ? "Receiving response…"
                              : turn.status === "complete"
                                ? "Completed"
                                : "Stopped · Incomplete response"}
                          </p>
                        ) : null}
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </div>

            <div className="shrink-0 space-y-3 border-t border-border p-5">
              <Label className="sr-only" htmlFor="playground-prompt">
                Message
              </Label>

              <input
                ref={fileInput}
                type="file"
                className="sr-only"
                tabIndex={-1}
                aria-label="Attach files"
                accept={PLAYGROUND_FILE_ACCEPT}
                multiple
                disabled={busy || readingFiles}
                onChange={(event) => {
                  const files = Array.from(event.currentTarget.files ?? []);
                  event.currentTarget.value = "";
                  if (files.length) void addFiles(files);
                }}
              />

              {readingFiles ? (
                <p role="status" className="text-xs text-muted-foreground">
                  Reading files…
                </p>
              ) : null}

              <div
                role="group"
                aria-label="Message composer"
                className="min-h-14 rounded-xl border border-input bg-white p-2 focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
              >
                {attachments.length ? (
                  <ul
                    className="flex flex-wrap gap-2 pb-2"
                    aria-label="Attachments"
                  >
                    {attachments.map((file, index) => (
                      <li
                        key={index}
                        className="flex max-w-full items-center gap-1 rounded-lg border border-border pl-3"
                      >
                        <p className="min-w-0 text-xs wrap-anywhere">
                          {file.name}
                        </p>

                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="min-h-10 min-w-10"
                          aria-label={`Remove ${file.name}`}
                          disabled={busy || readingFiles}
                          onClick={() =>
                            form.setValue(
                              "attachments",
                              attachments.filter((_, at) => at !== index),
                              { shouldValidate: true },
                            )
                          }
                        >
                          <X aria-hidden="true" className="size-4" />
                        </Button>
                      </li>
                    ))}
                  </ul>
                ) : null}

                <Flex className="min-h-10 items-end gap-1">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="min-h-10 min-w-10"
                    aria-label="Upload files"
                    title="Images, text files and PDF text · Up to 4 files, 5 MB each"
                    disabled={busy || readingFiles || attachments.length >= 4}
                    onClick={() => fileInput.current?.click()}
                  >
                    <Paperclip aria-hidden="true" className="size-4" />
                  </Button>

                  <Textarea
                    id="playground-prompt"
                    rows={1}
                    onKeyDown={(event) => {
                      if (
                        event.key === "Enter" &&
                        !event.shiftKey &&
                        !event.nativeEvent.isComposing
                      ) {
                        event.preventDefault();
                        if (
                          hasMessage &&
                          !busy &&
                          !readingFiles &&
                          session.status !== "loading"
                        )
                          event.currentTarget.form?.requestSubmit();
                      }
                    }}
                    className="min-h-10 max-h-40 min-w-0 flex-1 resize-none overflow-y-auto border-0 p-2 focus-visible:border-transparent focus-visible:ring-0"
                    placeholder="Ask a question…"
                    disabled={busy}
                    {...form.register("prompt")}
                  />

                  {busy ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="min-h-10 min-w-10"
                      aria-label="Stop"
                      onClick={() => controller.current?.abort()}
                    >
                      <Square aria-hidden="true" className="size-3" />
                    </Button>
                  ) : (
                    <Button
                      type="submit"
                      size="icon"
                      className="min-h-10 min-w-10"
                      aria-label="Send message"
                      disabled={
                        !hasMessage ||
                        readingFiles ||
                        session.status === "loading" ||
                        Boolean(
                          userId &&
                          (!connectionId ||
                            !selectedModel ||
                            !supportsChat ||
                            queryError ||
                            modelQuery.isFetching),
                        )
                      }
                    >
                      <ArrowUp aria-hidden="true" className="size-4" />
                    </Button>
                  )}
                </Flex>
              </div>
            </div>
          </section>
        )}
      </PlaygroundConversation>
    </form>
  );
}
