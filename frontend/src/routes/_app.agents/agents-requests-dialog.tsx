import { useState } from "react";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  Check,
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

interface AgentsRequestsDialogProps {
  busy: boolean;
  onDecision: (
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ) => void;
  onInvite: (username: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRefresh: () => Promise<void>;
  onRemoveMember: (username: string) => Promise<void>;
  open: boolean;
  pool: AgentPool | null;
}

export default function AgentsRequestsDialog({
  busy,
  onDecision,
  onInvite,
  onOpenChange,
  onRefresh,
  onRemoveMember,
  open,
  pool,
}: AgentsRequestsDialogProps) {
  const [query, setQuery] = useState("");
  const form = useForm<InviteFormValues>({
    defaultValues: { username: "" },
    resolver: zodResolver(
      z.object({
        username: z
          .string()
          .trim()
          .min(3, "Enter a Hub William username.")
          .max(32, "Username must be at most 32 characters.")
          .regex(
            /^[a-zA-Z0-9_-]+$/,
            "Use letters, numbers, underscores, or hyphens.",
          ),
      }),
    ),
  });
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
        : "Cooling down";

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setQuery("");
      form.reset();
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
                {pool?.availability.status === "rate_limited" &&
                pool.availability.retryAt
                  ? `Automatic retry after ${new Date(pool.availability.retryAt).toLocaleString()}.`
                  : "A retry is verified by the next real gateway request."}
              </p>
            </div>
            <Flex className="items-center gap-2">
              <Badge variant="outline">{availabilityLabel}</Badge>
              <Button
                disabled={busy || pool?.availability.status === "active"}
                onClick={() => void onRefresh()}
                size="sm"
                type="button"
                variant="outline"
              >
                <RefreshCw aria-hidden="true" data-icon="inline-start" />
                Refresh
              </Button>
            </Flex>
          </Flex>
        </section>

        <Separator />

        <section aria-labelledby="invite-member-title" className="space-y-3">
          <div>
            <h3 id="invite-member-title" className="text-sm font-semibold">
              Invite member
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Add an existing Hub William user without waiting for a request.
            </p>
          </div>
          <form
            className="space-y-2"
            onSubmit={form.handleSubmit(submitInvite)}
          >
            <Flex className="items-start gap-2">
              <div className="min-w-0 flex-1 space-y-1">
                <Label className="sr-only" htmlFor="invite-username">
                  Hub William username
                </Label>
                <Input
                  aria-invalid={Boolean(form.formState.errors.username)}
                  autoComplete="off"
                  id="invite-username"
                  placeholder="Hub William username"
                  {...form.register("username")}
                />
                {form.formState.errors.username ? (
                  <p className="text-xs text-destructive">
                    {form.formState.errors.username.message}
                  </p>
                ) : null}
              </div>
              <Button disabled={busy} type="submit">
                <UserPlus aria-hidden="true" data-icon="inline-start" />
                Invite
              </Button>
            </Flex>
            {form.formState.errors.root ? (
              <p className="text-xs text-destructive">
                {form.formState.errors.root.message}
              </p>
            ) : null}
          </form>
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
          ) : (
            <p className="rounded-xl bg-zinc-50 p-5 text-center text-sm text-muted-foreground">
              No one has joined this pool yet.
            </p>
          )}
        </section>
      </DialogContent>
    </Dialog>
  );
}
