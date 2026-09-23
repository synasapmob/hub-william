import { useEffect, useRef, useState } from "react";
import type { UseFormReturn } from "react-hook-form";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, FlaskConical, Paperclip, Square, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import agentPoolsService from "@/services/agent-pools";
import { agentPoolAccess } from "@/utils/utils.agent-pools";
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

const providerNames: Record<PlaygroundProviderId, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  grok: "Grok",
  deepseek: "DeepSeek",
};
const selectStyle =
  "h-11 w-full min-w-0 rounded-lg border border-input bg-white px-3 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

export default function PlaygroundWorkspace({
  form,
}: PlaygroundWorkspaceProps) {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [readingFiles, setReadingFiles] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [turns, setTurns] = useState<PlaygroundTurn[]>([]);
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const viewport = useRef<HTMLDivElement>(null);
  const followOutput = useRef(true);
  const userId = session.user?.id;
  const poolQuery = useQuery({
    queryKey: [...agentPoolsService.queryKey, userId ?? "guest"],
    queryFn: () => agentPoolsService.list(),
    enabled: session.status !== "loading",
  });
  const providerIds = Object.keys(providerNames) as PlaygroundProviderId[];
  const provider =
    providerIds.find((id) => id === form.watch("provider")) ?? "chatgpt";
  const accounts = (poolQuery.data ?? []).filter((pool) => {
    if (!userId || pool.agent !== providerNames[provider]) return false;
    const access = agentPoolAccess(pool, session.user?.username ?? null);
    return access === "owner" || access === "joined";
  });
  const selectedAccount =
    accounts.find((pool) => pool.id === form.watch("connectionId")) ??
    accounts[0];
  const connectionId = selectedAccount?.id;

  useEffect(() => {
    const nextConnectionId = connectionId ?? "";
    if (form.getValues("connectionId") === nextConnectionId) return;
    form.setValue("connectionId", nextConnectionId);
    form.setValue("model", "");
    form.clearErrors("root");
  }, [connectionId, form]);

  const modelQuery = useQuery({
    queryKey: [
      ...playgroundService.queryKey,
      "models",
      userId,
      provider,
      connectionId,
    ],
    queryFn: ({ signal }) =>
      playgroundService.models(provider, connectionId!, signal),
    enabled: Boolean(userId && connectionId),
  });
  const models = modelQuery.data ?? [];
  const currentLineupOnly = provider === "chatgpt" || provider === "claude";
  const selectedModel =
    models.find((entry) => entry.id === form.watch("model")) ?? models[0];
  const mutation = useMutation({
    mutationFn: (options: PlaygroundChatOptions) =>
      playgroundService.chat(options),
    retry: false,
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: agentPoolsService.queryKey,
      });
    },
  });
  const busy = form.formState.isSubmitting || mutation.isPending;
  const attachments = form.watch("attachments");
  const hasMessage = Boolean(form.watch("prompt").trim() || attachments.length);
  const queryError = poolQuery.error ?? modelQuery.error;
  const conversationError =
    queryError?.message ?? form.formState.errors.root?.message;

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
    if (!values.prompt && !values.attachments.length) return;
    if (session.status === "loading") return;
    if (!session.user) {
      session.openAuth();
      return;
    }
    if (!connectionId || !selectedModel) {
      form.setError("root", {
        message:
          "Choose an account you can access and an available model first.",
      });
      return;
    }
    if (readingFiles) return;
    if (
      (provider === "grok" || provider === "deepseek") &&
      [
        ...values.attachments,
        ...turns
          .filter((turn) => turn.status === "complete")
          .flatMap((turn) => turn.attachments),
      ].some((file) => file.kind === "image")
    ) {
      form.setError("root", {
        message:
          "Choose ChatGPT, Claude or Gemini for image input, or start a new conversation without images.",
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
      if (
        (provider === "grok" || provider === "deepseek") &&
        uploaded.some((file) => file.kind === "image")
      )
        throw new Error(
          "Image input is available with ChatGPT, Claude and Gemini. This provider accepts text files and PDF text.",
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
    <form
      className="space-y-5"
      onSubmit={(event) => void form.handleSubmit(submit)(event)}
    >
      <section className="space-y-4 rounded-xl border border-border bg-white p-5">
        <header>
          <h2 className="text-sm font-semibold">Setup</h2>
        </header>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="playground-provider">Provider</Label>
            <select
              id="playground-provider"
              className={selectStyle}
              disabled={busy || readingFiles}
              {...form.register("provider", {
                onChange: () => {
                  form.setValue("connectionId", "");
                  form.setValue("model", "");
                  form.clearErrors("root");
                },
              })}
              value={provider}
            >
              {providerIds.map((id) => (
                <option key={id} value={id}>
                  {providerNames[id]}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="playground-account">Account</Label>
            <select
              id="playground-account"
              className={selectStyle}
              disabled={
                busy ||
                readingFiles ||
                !userId ||
                poolQuery.isPending ||
                !accounts.length
              }
              {...form.register("connectionId", {
                onChange: () => {
                  form.setValue("model", "");
                  form.clearErrors("root");
                },
              })}
              value={selectedAccount?.id ?? ""}
            >
              <option value="">
                {!userId
                  ? ""
                  : poolQuery.isPending
                    ? "Loading accounts…"
                    : "No accounts available"}
              </option>
              {accounts.map((pool) => (
                <option key={pool.id} value={pool.id}>
                  {pool.accountLabel} · {pool.owner.username}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="playground-model">Model</Label>
            <select
              id="playground-model"
              className={selectStyle}
              disabled={
                busy || readingFiles || modelQuery.isFetching || !models.length
              }
              {...form.register("model", {
                onChange: () => form.clearErrors("root"),
              })}
              value={selectedModel?.id ?? ""}
            >
              {!models.length ? (
                <option value="">
                  {modelQuery.isFetching
                    ? "Loading models…"
                    : currentLineupOnly
                      ? "No current models available"
                      : "No models available"}
                </option>
              ) : null}
              {models.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </section>

      <section className="flex h-[calc(100svh-18rem)] min-h-112 max-h-192 min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-white">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="text-sm font-semibold">Your conversation</h2>

          <Button
            type="button"
            variant="outline"
            size="sm"
            className="min-h-10"
            disabled={busy || readingFiles || !turns.length}
            onClick={newConversation}
          >
            New Chat
          </Button>
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
          {!turns.length && !conversationError ? (
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
                      {providerNames[turn.provider]} / {turn.model}
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
              {conversationError ? (
                <div className="space-y-3">
                  <p role="alert" className="text-sm/relaxed text-destructive">
                    {conversationError}
                  </p>

                  {queryError ? (
                    <Button
                      type="button"
                      variant="outline"
                      disabled={poolQuery.isFetching || modelQuery.isFetching}
                      onClick={() => {
                        if (poolQuery.error) void poolQuery.refetch();
                        else void modelQuery.refetch();
                      }}
                    >
                      Retry loading
                    </Button>
                  ) : null}
                </div>
              ) : null}
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
                    <p className="min-w-0 text-xs wrap-anywhere">{file.name}</p>

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
    </form>
  );
}
