import { useState } from "react";
import { Check, Search, UsersRound, X } from "lucide-react";
import { tv } from "tailwind-variants";

import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { AgentPool, AgentPoolRequestStatus } from "@/services/agent-pools";

const decisionButton = tv({
  variants: {
    decision: {
      accept: "border-emerald-200 bg-emerald-50 text-emerald-700",
      reject: "border-red-200 bg-red-50 text-red-700",
    },
  },
});

interface AgentsRequestsDialogProps {
  onDecision: (
    requestId: string,
    status: Exclude<AgentPoolRequestStatus, "pending">,
  ) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  pool: AgentPool | null;
}

export default function AgentsRequestsDialog({
  onDecision,
  onOpenChange,
  open,
  pool,
}: AgentsRequestsDialogProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const requests = (pool?.requests ?? []).filter(
    (request) =>
      request.username.toLowerCase().includes(normalizedQuery) ||
      request.telegram.toLowerCase().includes(normalizedQuery),
  );

  function changeOpen(nextOpen: boolean) {
    onOpenChange(nextOpen);
    if (!nextOpen) setQuery("");
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <Center className="mb-1 size-10 rounded-xl border border-indigo-200 bg-indigo-50 text-indigo-600">
            <UsersRound aria-hidden="true" className="size-5" />
          </Center>

          <DialogTitle>Join requests</DialogTitle>
          <DialogDescription>
            Review requests for {pool?.accountLabel}. Search by Hub William or
            Telegram username.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search username or Telegram"
            className="pl-8"
          />
        </div>

        {requests.length > 0 ? (
          <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
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
                    <Flex className="flex-wrap justify-between gap-2">
                      <div>
                        <p className="font-semibold">{request.username}</p>
                        <p className="font-mono text-[11px] text-indigo-600">
                          {request.telegram}
                        </p>
                      </div>

                      {request.status !== "pending" ? (
                        <p className="font-mono text-[10px] font-semibold uppercase">
                          {request.status}
                        </p>
                      ) : null}
                    </Flex>

                    <p className="mt-2 text-xs/relaxed text-muted-foreground">
                      {request.reason}
                    </p>

                    {request.status === "pending" ? (
                      <Flex className="mt-3 justify-end gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={decisionButton({ decision: "reject" })}
                          onClick={() => onDecision(request.id, "rejected")}
                        >
                          <X aria-hidden="true" data-icon="inline-start" />
                          Reject
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            pool ? pool.members.length >= pool.capacity : true
                          }
                          className={decisionButton({ decision: "accept" })}
                          onClick={() => onDecision(request.id, "accepted")}
                        >
                          <Check aria-hidden="true" data-icon="inline-start" />
                          Accept
                        </Button>
                      </Flex>
                    ) : null}
                  </div>
                </Flex>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-zinc-50 p-6 text-center text-sm text-muted-foreground">
            No requests match this search.
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}
