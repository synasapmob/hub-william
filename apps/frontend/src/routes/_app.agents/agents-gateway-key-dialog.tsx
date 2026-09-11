import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { Link } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import gatewayKeysService, {
  GatewayKeyServiceError,
  type CreatedGatewayKey,
  type GatewayKey,
} from "@/services/gateway-keys";
import { copyText } from "@/utils/utils.clipboard";

export default function AgentsGatewayKeyDialog() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreatedGatewayKey | null>(null);
  const gatewayKeyQueryKey = [
    ...gatewayKeysService.queryKey,
    session.user?.id ?? "guest",
  ] as const;
  const keysQuery = useQuery({
    enabled: open && Boolean(session.user),
    queryFn: gatewayKeysService.list,
    queryKey: gatewayKeyQueryKey,
  });
  const createMutation = useMutation({
    mutationFn: gatewayKeysService.create,
    onSuccess: (key) => {
      setCreatedKey(key);
      queryClient.setQueryData<GatewayKey[]>(gatewayKeyQueryKey, (items) => [
        key,
        ...(items ?? []),
      ]);
    },
  });
  const revokeMutation = useMutation({
    mutationFn: gatewayKeysService.revoke,
    onSuccess: (_, keyId) => {
      queryClient.setQueryData<GatewayKey[]>(gatewayKeyQueryKey, (items) =>
        (items ?? []).filter((key) => key.id !== keyId),
      );
      setCreatedKey((key) => (key?.id === keyId ? null : key));
    },
  });
  const keys = keysQuery.data ?? [];
  const requestError =
    keysQuery.error ?? createMutation.error ?? revokeMutation.error;
  const errorMessage = requestError
    ? requestError instanceof GatewayKeyServiceError
      ? requestError.message
      : "The gateway key request could not be completed."
    : null;

  function changeOpen(nextOpen: boolean) {
    if (nextOpen && !session.user) {
      session.openAuth();
      return;
    }
    setOpen(nextOpen);
    if (!nextOpen) {
      setCreatedKey(null);
      createMutation.reset();
      revokeMutation.reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button className="h-10 px-4" type="button" variant="outline">
          <KeyRound aria-hidden="true" />
          Gateway Key
        </Button>
      </DialogTrigger>

      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <Flex className="items-center justify-between gap-3 pr-8">
            <DialogTitle>Gateway API key</DialogTitle>
            <Badge variant="outline">{keys.length} active</Badge>
          </Flex>
          <DialogDescription>
            One key configures every selected agent. Paste it into Codex, Claude
            Code, or Grok from{" "}
            <Link
              className="font-medium text-indigo-600 hover:underline"
              onClick={() => changeOpen(false)}
              to="/tools?node=gateway"
            >
              Tools → Gateway
            </Link>
            .
          </DialogDescription>
        </DialogHeader>

        <Button
          disabled={createMutation.isPending || keysQuery.isPending}
          onClick={() => createMutation.mutate()}
          type="button"
        >
          {createMutation.isPending ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : (
            <KeyRound aria-hidden="true" />
          )}
          {createMutation.isPending ? "Creating…" : "Create gateway key"}
        </Button>

        {createdKey ? (
          <section className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-3">
            <Label htmlFor="created-gateway-key">
              Copy now — this key is shown once
            </Label>
            <Flex className="items-center gap-2">
              <Input
                className="font-mono text-xs"
                id="created-gateway-key"
                readOnly
                value={createdKey.key}
              />
              <Button
                aria-label="Copy gateway API key"
                onClick={() => void copyText(createdKey.key)}
                size="icon"
                type="button"
                variant="outline"
              >
                <Copy aria-hidden="true" />
              </Button>
            </Flex>
          </section>
        ) : null}

        {keysQuery.isPending ? (
          <Flex className="items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Loading gateway keys…
          </Flex>
        ) : keys.length > 0 ? (
          <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200">
            {keys.map((key) => (
              <li key={key.id} className="p-3">
                <Flex className="justify-between gap-3">
                  <p className="min-w-0 truncate font-mono text-xs font-semibold">
                    hw_live_********{key.lastFour}
                  </p>
                  <Button
                    disabled={
                      revokeMutation.isPending &&
                      revokeMutation.variables === key.id
                    }
                    onClick={() => revokeMutation.mutate(key.id)}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    {revokeMutation.isPending &&
                    revokeMutation.variables === key.id ? (
                      <LoaderCircle
                        aria-hidden="true"
                        className="animate-spin"
                      />
                    ) : (
                      <Trash2 aria-hidden="true" />
                    )}
                    Delete
                  </Button>
                </Flex>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-center text-sm text-muted-foreground">
            No active gateway keys.
          </p>
        )}

        {errorMessage ? (
          <Alert variant="destructive">
            <AlertTitle>Gateway key request failed</AlertTitle>
            <AlertDescription>{errorMessage}</AlertDescription>
          </Alert>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
