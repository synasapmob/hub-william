import { useState, type PropsWithChildren } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, LoaderCircle, Trash2 } from "lucide-react";
import { Navigate } from "react-router";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { formatDate } from "@/routes/_app.organization/organization-format";
import { serviceBillingService } from "@/services/service-billing/service-billing-service";
import { serviceKeysService } from "@/services/service-keys/service-keys-service";
import type {
  CreatedServiceKey,
  ServiceKey,
} from "@/services/service-keys/service-keys-types";
import { copyText } from "@/utils/utils.clipboard";

import ServiceKeysGuide from "./service-keys-guide";

function KeysFrame({ children }: PropsWithChildren) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Keys
        </h1>

        <p className="mt-1 text-xs text-zinc-500">
          A service key bills your balance. Create one, give it to a client, and
          pay for what it uses.
        </p>
      </header>

      {children}
    </div>
  );
}

export default function ServiceKeysRoute() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const [created, setCreated] = useState<CreatedServiceKey | null>(null);
  const keysQueryKey = [
    ...serviceKeysService.queryKey,
    session.user?.id ?? "guest",
  ] as const;
  const keysQuery = useQuery({
    enabled: Boolean(session.user),
    queryFn: () => serviceKeysService.list(),
    queryKey: keysQueryKey,
  });
  // The prices are cached by the Pricing page; the minimum balance comes with them.
  const pricingQuery = useQuery({
    queryFn: () => serviceBillingService.pricing(),
    queryKey: serviceBillingService.pricingQueryKey,
  });
  const createKey = useMutation({
    mutationFn: () => serviceKeysService.create(),
    onSuccess: (key) => {
      setCreated(key);
      queryClient.setQueryData<ServiceKey[]>(keysQueryKey, (items) => [
        key,
        ...(items ?? []),
      ]);
    },
  });
  const revokeKey = useMutation({
    mutationFn: (keyId: string) => serviceKeysService.revoke(keyId),
    onSuccess: (_, keyId) => {
      queryClient.setQueryData<ServiceKey[]>(keysQueryKey, (items) =>
        (items ?? []).filter((key) => key.id !== keyId),
      );
      setCreated((key) => (key?.id === keyId ? null : key));
    },
  });
  const keys = keysQuery.data;
  const failure = createKey.error ?? revokeKey.error;

  // Keys are of a signed-in user; a guest is left with Pricing alone.
  if (session.status === "guest") {
    return <Navigate replace to="/service/pricing" />;
  }

  if (keysQuery.error) {
    return (
      <KeysFrame>
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{keysQuery.error.message}</p>

          <Button
            className="mt-3"
            onClick={() => void keysQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      </KeysFrame>
    );
  }

  if (!keys) {
    return (
      <KeysFrame>
        <p role="status" className="sr-only">
          Loading keys
        </p>

        <Skeleton aria-hidden="true" className="h-40 rounded-xl bg-zinc-200" />
      </KeysFrame>
    );
  }

  return (
    <KeysFrame>
      <Flex className="flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-zinc-500">
          {keys.length === 0
            ? "You have no keys yet."
            : `${keys.length} active ${keys.length === 1 ? "key" : "keys"}.`}
        </p>

        <Button
          disabled={createKey.isPending}
          onClick={() => createKey.mutate()}
          type="button"
        >
          {createKey.isPending ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : (
            <KeyRound aria-hidden="true" />
          )}
          {createKey.isPending ? "Creating…" : "Create key"}
        </Button>
      </Flex>

      {failure ? (
        <Alert variant="destructive">
          <AlertDescription>{failure.message}</AlertDescription>
        </Alert>
      ) : null}

      {created ? (
        <section className="space-y-2 rounded-xl border border-indigo-200 bg-indigo-50 p-4">
          <Label htmlFor="created-service-key">
            Copy it now — this key is shown once
          </Label>

          <Flex className="items-center gap-2">
            <Input
              className="bg-white font-mono text-xs"
              id="created-service-key"
              readOnly
              value={created.key}
            />

            <Button
              aria-label="Copy service key"
              onClick={() => void copyText(created.key)}
              size="icon"
              type="button"
              variant="outline"
            >
              <Copy aria-hidden="true" />
            </Button>
          </Flex>
        </section>
      ) : null}

      {keys.length > 0 ? (
        <ul className="divide-y divide-zinc-100 rounded-xl border border-zinc-200 bg-white shadow-xs">
          {keys.map((key) => (
            <li key={key.id} className="p-4">
              <Flex className="items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-semibold">
                    hw_svc_********{key.lastFour}
                  </p>

                  <p className="mt-0.5 text-[11px] text-zinc-500">
                    Created {formatDate(key.createdAt)} ·{" "}
                    {key.lastUsedAt
                      ? `last used ${formatDate(key.lastUsedAt)}`
                      : "never used"}
                  </p>
                </div>

                <Button
                  aria-label={`Revoke key ending ${key.lastFour}`}
                  disabled={
                    revokeKey.isPending && revokeKey.variables === key.id
                  }
                  onClick={() => revokeKey.mutate(key.id)}
                  size="sm"
                  type="button"
                  variant="destructive"
                >
                  <Trash2 aria-hidden="true" />
                  Revoke
                </Button>
              </Flex>
            </li>
          ))}
        </ul>
      ) : null}

      <ServiceKeysGuide
        createdKey={created ?? undefined}
        pricing={pricingQuery.data}
        onTested={() => {
          // The charge lands just after the answer ends, so look again once more.
          const refresh = () =>
            queryClient.invalidateQueries({
              queryKey: serviceBillingService.walletQueryKey(session.user?.id),
            });

          void refresh();
          window.setTimeout(() => void refresh(), 1500);
        }}
      />
    </KeysFrame>
  );
}
