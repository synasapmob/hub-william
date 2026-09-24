import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Navigate, Outlet, useLocation, useSearchParams } from "react-router";

import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import organizationsService from "@/services/organizations";

import OrganizationCreateForm from "./organization-create-form";
import type { OrganizationCreateValues } from "./organization-create-form";
import type { OrganizationContextValue } from "./organization-context";

function storageKey(userId: string) {
  return `hub-william:organization:${userId}`;
}

function storedOrganizationId(userId: string | undefined) {
  if (!userId || typeof window === "undefined") return null;
  try {
    return window.localStorage?.getItem(storageKey(userId)) ?? null;
  } catch {
    return null;
  }
}

function rememberOrganizationId(userId: string | undefined, id: string) {
  if (!userId || typeof window === "undefined") return;
  try {
    window.localStorage?.setItem(storageKey(userId), id);
  } catch {
    return;
  }
}

export default function OrganizationRoute() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const userId = session.user?.id;
  const organizationsQuery = useQuery({
    enabled: Boolean(userId),
    queryFn: organizationsService.list,
    queryKey: [...organizationsService.queryKey, userId ?? "guest"],
  });
  const invitationsQuery = useQuery({
    enabled: Boolean(userId),
    queryFn: organizationsService.invitations,
    queryKey: [
      ...organizationsService.queryKey,
      "invitations",
      userId ?? "guest",
    ],
  });
  const createMutation = useMutation({
    mutationFn: organizationsService.create,
    onSuccess: async (organization) => {
      selectOrganization(organization.id);
      setCreating(false);
      await queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      });
    },
  });
  const acceptMutation = useMutation({
    mutationFn: organizationsService.acceptInvitation,
    onSuccess: async (organization) => {
      selectOrganization(organization.id);
      await queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      });
    },
  });
  const declineMutation = useMutation({
    mutationFn: organizationsService.declineInvitation,
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      }),
  });
  const organizations = organizationsQuery.data ?? [];
  const storedId = storedOrganizationId(userId);
  const organization =
    organizations.find((item) => item.id === selectedId) ??
    organizations.find((item) => item.id === storedId) ??
    organizations[0] ??
    null;
  const invitations = invitationsQuery.data ?? [];

  function selectOrganization(id: string) {
    setSelectedId(id);
    rememberOrganizationId(userId, id);
    if (searchParams.has("member")) {
      const next = new URLSearchParams(searchParams);
      next.delete("member");
      setSearchParams(next, { replace: true });
    }
  }

  async function createOrganization(values: OrganizationCreateValues) {
    await createMutation.mutateAsync(values);
  }

  if (session.status === "loading") {
    return <p className="p-8 text-sm text-muted-foreground">Loading…</p>;
  }

  if (
    location.pathname !== "/organization" &&
    (!session.user ||
      (!organizationsQuery.isPending &&
        !organizationsQuery.error &&
        !organization))
  ) {
    return <Navigate replace to="/organization" />;
  }

  return (
    <section className="mx-auto w-full max-w-7xl space-y-5 px-4 pt-5 pb-8 sm:px-6 lg:px-8">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-200/80 pb-4">
        <Flex className="flex-wrap items-center gap-2.5">
          <p className="font-mono text-xs tracking-widest text-zinc-400 uppercase">
            Organization
          </p>
          {organization ? (
            <Select onValueChange={selectOrganization} value={organization.id}>
              <SelectTrigger
                aria-label="Selected organization"
                className="h-9! max-w-full min-w-36 bg-white px-3 text-sm font-semibold text-zinc-900"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {organizations.map((item) => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </Flex>

        {session.user && organization ? (
          <Button
            onClick={() => setCreating(true)}
            size="sm"
            type="button"
            variant="outline"
          >
            <Plus aria-hidden="true" />
            New organization
          </Button>
        ) : null}
      </header>

      {session.user ? (
        <Dialog onOpenChange={setCreating} open={creating}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Create an organization</DialogTitle>
              <DialogDescription>
                Create a team, invite members, then share your agents with them.
              </DialogDescription>
            </DialogHeader>
            <OrganizationCreateForm
              onCancel={() => setCreating(false)}
              onCreate={createOrganization}
            />
          </DialogContent>
        </Dialog>
      ) : null}

      {!session.user ? (
        <div className="rounded-2xl border border-zinc-200 bg-white py-20 text-center">
          <h1 className="font-heading text-xl font-semibold">
            Your teams, in one place
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Sign in to create an organization or accept an invitation.
          </p>
          <Button className="mt-4" onClick={session.openAuth} type="button">
            Sign in
          </Button>
        </div>
      ) : organizationsQuery.isPending ? (
        <p className="text-sm text-muted-foreground">Loading organizations…</p>
      ) : organizationsQuery.error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {organizationsQuery.error instanceof Error
            ? organizationsQuery.error.message
            : "Organizations could not be loaded."}
        </p>
      ) : (
        <>
          {!organization ? (
            <section className="mx-auto max-w-xl space-y-5 rounded-2xl border border-zinc-200 bg-white p-5 shadow-xs sm:p-7">
              <h1 className="font-heading text-lg font-semibold">
                Create an organization
              </h1>
              <p className="text-sm text-muted-foreground">
                Bring your team together to share agents and see usage.
              </p>

              <OrganizationCreateForm onCreate={createOrganization} />
            </section>
          ) : null}

          {invitationsQuery.error ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
            >
              <p>
                {invitationsQuery.error instanceof Error
                  ? invitationsQuery.error.message
                  : "Invitations could not be loaded."}
              </p>
              <Button
                className="mt-3"
                onClick={() => void invitationsQuery.refetch()}
                size="sm"
                type="button"
                variant="outline"
              >
                Retry invitations
              </Button>
            </div>
          ) : null}

          {invitations.length > 0 ? (
            <section className="space-y-3 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-5">
              <h2 className="font-heading text-lg font-semibold">
                Invitations for you
              </h2>
              <ul className="space-y-3">
                {invitations.map((invitation) => (
                  <li
                    key={invitation.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-white p-3"
                  >
                    <p className="text-sm">
                      <strong>{invitation.organizationName}</strong> · invited
                      by @{invitation.invitedByUsername ?? "unknown"}
                    </p>
                    <Flex className="gap-2">
                      <Button
                        disabled={
                          acceptMutation.isPending || declineMutation.isPending
                        }
                        onClick={() => acceptMutation.mutate(invitation.id)}
                        type="button"
                      >
                        Accept
                      </Button>
                      <Button
                        disabled={
                          acceptMutation.isPending || declineMutation.isPending
                        }
                        onClick={() => declineMutation.mutate(invitation.id)}
                        type="button"
                        variant="outline"
                      >
                        Decline
                      </Button>
                    </Flex>
                  </li>
                ))}
              </ul>
              {acceptMutation.error || declineMutation.error ? (
                <p className="text-sm text-destructive">
                  {(acceptMutation.error ?? declineMutation.error)?.message}
                </p>
              ) : null}
            </section>
          ) : null}

          {organization ? (
            <Outlet
              key={organization.id}
              context={{ organization } satisfies OrganizationContextValue}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
