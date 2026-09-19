import { useEffect, useState } from "react";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Check,
  CheckCircle2,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
  UserPlus,
  UsersRound,
  X,
} from "lucide-react";
import { useForm } from "react-hook-form";
import { tv } from "tailwind-variants";
import { z } from "zod";

import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import agentConnectionsService, {
  AgentConnectionServiceError,
  type AgentConnection,
} from "@/services/agent-connections";
import type { AgentPool, AgentPoolRequestStatus } from "@/services/agent-pools";

const decisionButton = tv({
  variants: {
    decision: {
      accept: "border-emerald-200 bg-emerald-50 text-emerald-700",
      reject: "border-red-200 bg-red-50 text-red-700",
    },
  },
});

interface InviteFormValues {
  username: string;
}

interface CallbackFormValues {
  callbackUrl: string;
}

interface CompleteConnectionVariables {
  callbackUrl: string;
  connectionId: string;
}

interface AgentsRequestsDialogProps {
  busy: boolean;
  onDecision: (
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ) => void;
  onDelete: () => Promise<void>;
  onInvite: (username: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<AgentConnection>;
  onRefreshComplete: () => void;
  onRemoveMember: (username: string) => Promise<void>;
  open: boolean;
  pool: AgentPool | null;
}

export default function AgentsRequestsDialog({
  busy,
  onDecision,
  onDelete,
  onInvite,
  onOpenChange,
  onRefresh,
  onRefreshComplete,
  onRemoveMember,
  open,
  pool,
}: AgentsRequestsDialogProps) {
  const [query, setQuery] = useState("");
  const [refreshConnection, setRefreshConnection] =
    useState<AgentConnection | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const inviteSchema = z.object({
    username: z
      .string()
      .trim()
      .min(3, "Enter a Hub William username.")
      .max(32, "Username must be at most 32 characters.")
      .regex(
        /^[a-zA-Z0-9_-]+$/,
        "Use letters, numbers, underscores, or hyphens.",
      ),
  });
  const form = useForm<InviteFormValues>({
    defaultValues: { username: "" },
    resolver: zodResolver(inviteSchema),
  });
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
  const normalizedQuery = query.trim().toLowerCase();
  const requests = (pool?.requests ?? []).filter(
    (request) =>
      request.status === "pending" &&
      (request.username.toLowerCase().includes(normalizedQuery) ||
        request.telegram.toLowerCase().includes(normalizedQuery)),
  );
  const members = (pool?.members ?? []).filter(
    (member) => member.username !== pool?.owner.username,
  );
  const availabilityLabel =
    pool?.availability.status === "active"
      ? "Active"
      : pool?.availability.status === "half_open"
        ? "Ready to retry"
        : pool?.availability.status === "reauth_required"
          ? "Reconnect required"
          : "Cooling down";

  useEffect(() => {
    const connection = connectionStatusQuery.data;
    if (
      connection?.status === "connected" &&
      !connection.authorization &&
      !connection.failureMessage
    ) {
      onRefreshComplete();
    }
  }, [connectionStatusQuery.data, onRefreshComplete]);

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setQuery("");
      setRefreshConnection(null);
      setRefreshError(null);
      form.reset();
      callbackForm.reset();
    }
  }

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
        onRefreshComplete();
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
      onRefreshComplete();
    } catch (error) {
      callbackForm.setError("root", {
        message:
          error instanceof AgentConnectionServiceError
            ? error.message
            : "The authorization code could not be exchanged.",
      });
    }
  }

  async function submitInvite(values: InviteFormValues) {
    try {
      await onInvite(values.username);
      form.reset();
    } catch (error) {
      form.setError("root", {
        message:
          error instanceof Error
            ? error.message
            : "The invite could not be sent.",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <Center className="mb-1 size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600">
            <UsersRound aria-hidden="true" className="size-5" />
          </Center>

          <DialogTitle>Manage pool access</DialogTitle>
          <DialogDescription>
            Review requests, invite Hub William users, and manage members for{" "}
            {pool?.accountLabel}.
          </DialogDescription>
        </DialogHeader>

        <section
          aria-labelledby="pool-availability-title"
          className="space-y-3"
        >
          <Flex className="items-center justify-between gap-3">
            <div>
              <h3
                id="pool-availability-title"
                className="text-sm font-semibold"
              >
                Pool availability
              </h3>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Refresh stores the latest provider credential. If the provider
                session ended, its official login opens so you can reconnect
                this same pool.
              </p>
            </div>
            <Flex className="flex-wrap items-center justify-end gap-2">
              <Badge variant="outline">{availabilityLabel}</Badge>
              <Button
                disabled={busy}
                onClick={() => void refreshCredential()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" data-icon="inline-start" />
                Refresh
              </Button>
              <Button
                disabled={busy}
                onClick={() => void onDelete()}
                size="sm"
                type="button"
                variant="destructive"
              >
                <Trash2 aria-hidden="true" data-icon="inline-start" />
                Delete
              </Button>
            </Flex>
          </Flex>

          {currentRefreshConnection?.authorization ? (
            <Alert>
              <LoaderCircle aria-hidden="true" className="animate-spin" />
              <AlertTitle>Waiting for provider authorization</AlertTitle>
              <AlertDescription>
                Finish signing in on the provider page.
                {currentRefreshConnection.authorization.userCode
                  ? ` Confirm code ${currentRefreshConnection.authorization.userCode}.`
                  : ""}
              </AlertDescription>
            </Alert>
          ) : null}

          {currentRefreshConnection?.authorization?.requiresCallbackUrl ? (
            <form
              className="space-y-3"
              onSubmit={callbackForm.handleSubmit(completeReauthorization)}
            >
              <div className="space-y-1.5">
                <Label htmlFor="refresh-callback-url">
                  Callback URL or code
                </Label>
                <Input
                  id="refresh-callback-url"
                  autoComplete="off"
                  placeholder="Paste the URL shown after authorization"
                  aria-invalid={Boolean(
                    callbackForm.formState.errors.callbackUrl,
                  )}
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

              <Button
                disabled={completeMutation.isPending}
                size="sm"
                type="submit"
              >
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
                This pool is active with the latest provider session.
              </AlertDescription>
            </Alert>
          ) : null}

          {(refreshError ??
          connectionStatusQuery.error?.message ??
          currentRefreshConnection?.failureMessage) ? (
            <Alert variant="destructive">
              <AlertTitle>Refresh failed</AlertTitle>
              <AlertDescription>
                {refreshError ??
                  connectionStatusQuery.error?.message ??
                  currentRefreshConnection?.failureMessage}
              </AlertDescription>
            </Alert>
          ) : null}
        </section>

        <Separator />

        <section aria-labelledby="join-requests-title" className="space-y-3">
          <div>
            <h3 id="join-requests-title" className="text-sm font-semibold">
              Join requests
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Search pending requests by Hub William or Telegram username.
            </p>
          </div>
          <div className="relative">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              className="pl-8"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search username or Telegram"
              value={query}
            />
          </div>

          {requests.length > 0 ? (
            <ul className="space-y-2">
              {requests.map((request) => (
                <li
                  key={request.id}
                  className="rounded-xl border border-zinc-200 p-3"
                >
                  <Flex className="items-start gap-3">
                    <Avatar>
                      <AvatarFallback className="bg-zinc-900 text-[10px] font-semibold text-white">
                        {request.avatarLabel}
                      </AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{request.username}</p>
                      <p className="font-mono text-[11px] text-indigo-600">
                        {request.telegram}
                      </p>
                      <p className="mt-2 text-xs/relaxed text-muted-foreground">
                        {request.reason}
                      </p>
                      <Flex className="mt-3 justify-end gap-2">
                        <Button
                          className={decisionButton({ decision: "reject" })}
                          disabled={busy}
                          onClick={() => onDecision(request.id, "rejected")}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <X aria-hidden="true" data-icon="inline-start" />
                          Reject
                        </Button>
                        <Button
                          className={decisionButton({ decision: "accept" })}
                          disabled={
                            busy ||
                            (pool ? pool.members.length >= pool.capacity : true)
                          }
                          onClick={() => onDecision(request.id, "accepted")}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          <Check aria-hidden="true" data-icon="inline-start" />
                          Accept
                        </Button>
                      </Flex>
                    </div>
                  </Flex>
                </li>
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-zinc-50 p-5 text-center text-sm text-muted-foreground">
              No pending requests match this search.
            </p>
          )}
        </section>

        <Separator />

        <section aria-labelledby="pool-members-title" className="space-y-3">
          <div>
            <h3 id="pool-members-title" className="text-sm font-semibold">
              Membership
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {members.length} joined{" "}
              {members.length === 1 ? "member" : "members"}.
            </p>
          </div>
          <form
            className="space-y-2"
            onSubmit={form.handleSubmit(submitInvite)}
          >
            <Flex className="items-center gap-2">
              <div className="min-w-0 flex-1">
                <Label className="sr-only" htmlFor="invite-username">
                  Invite member
                </Label>
                <Input
                  aria-invalid={Boolean(form.formState.errors.username)}
                  autoComplete="off"
                  id="invite-username"
                  placeholder="Hub William username"
                  {...form.register("username")}
                />
              </div>
              <Button disabled={busy} type="submit">
                <UserPlus aria-hidden="true" data-icon="inline-start" />
                Invite
              </Button>
            </Flex>
            {form.formState.errors.username ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.username.message}
              </p>
            ) : null}
            {form.formState.errors.root ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.root.message}
              </p>
            ) : null}
          </form>
          {members.length > 0 ? (
            <ul className="space-y-2">
              {members.map((member) => (
                <li
                  key={member.username}
                  className="rounded-xl border border-zinc-200 p-3"
                >
                  <Flex className="items-center gap-3">
                    <Avatar>
                      <AvatarFallback className="bg-zinc-900 text-[10px] font-semibold text-white">
                        {member.avatarLabel}
                      </AvatarFallback>
                    </Avatar>
                    <p className="min-w-0 flex-1 truncate text-sm font-semibold">
                      {member.username}
                    </p>
                    <Button
                      aria-label={`Remove ${member.username}`}
                      disabled={busy}
                      onClick={() => void onRemoveMember(member.username)}
                      size="sm"
                      type="button"
                      variant="destructive"
                    >
                      <Trash2 aria-hidden="true" data-icon="inline-start" />
                      Remove
                    </Button>
                  </Flex>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      </DialogContent>
    </Dialog>
  );
}
