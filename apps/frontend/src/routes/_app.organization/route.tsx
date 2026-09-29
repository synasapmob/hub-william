import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
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
import organizationsService from "@/services/organizations";
import type {
  Organization,
  OrganizationSummary,
} from "@/services/organizations";
import {
  MY_ORGANIZATION_TAB,
  ORGANIZATION_TAB_PARAM,
} from "@/utils/utils.organization-tabs";

import OrganizationCreateForm from "./organization-create-form";
import type { OrganizationCreateValues } from "./organization-create-form";
import type { OrganizationContextValue } from "./organization-context";
import OrganizationHeader from "./organization-header";
import OrganizationManageDialog from "./organization-manage-dialog";

// Marks one organization as the viewer's default, the way the server now does.
function withDefault<T extends Organization>(
  organizations: T[] | undefined,
  id: string,
) {
  return organizations?.map((item) => ({ ...item, isDefault: item.id === id }));
}

export default function OrganizationRoute() {
  const session = useWorkspaceSession();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const userId = session.user?.id;
  const organizationsKey = [
    ...organizationsService.queryKey,
    userId ?? "guest",
  ];
  const summariesKey = [
    ...organizationsService.queryKey,
    "summaries",
    userId ?? "guest",
  ];
  const managing =
    Boolean(session.user) &&
    searchParams.get(ORGANIZATION_TAB_PARAM) === MY_ORGANIZATION_TAB;
  const organizationsQuery = useQuery({
    enabled: Boolean(userId),
    queryFn: organizationsService.list,
    queryKey: organizationsKey,
  });
  // The table's owner, counts and usage cost more to compute than the plain
  // list, so they are only fetched while the dialog shows them.
  const summariesQuery = useQuery({
    enabled: managing && Boolean(userId),
    queryFn: organizationsService.summaries,
    queryKey: summariesKey,
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
    onSuccess: async () => {
      // The server made the new organization the default. Show it once the
      // list says so, not before.
      await queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      });
      showChosenOrganization();
      setCreating(false);
    },
  });
  const organizations = organizationsQuery.data ?? [];
  // The server remembers the default. Until there is one, the oldest
  // organization stands in for it.
  const organization =
    organizations.find((item) => item.isDefault) ?? organizations[0] ?? null;
  const invitations = invitationsQuery.data ?? [];
  // The session or the organization list is still on its way. Pages render
  // their skeletons meanwhile instead of a text placeholder.
  const loading =
    session.status === "loading" ||
    (Boolean(session.user) && organizationsQuery.isPending);

  // One update per user action: successive setSearchParams calls in the same
  // tick each start from the params of the last render and undo one another.
  function updateSearchParams(update: (params: URLSearchParams) => void) {
    const next = new URLSearchParams(searchParams);
    update(next);
    if (next.toString() !== searchParams.toString())
      setSearchParams(next, { replace: true });
  }

  // Filters that belonged to the organization on show do not carry over.
  function showChosenOrganization(closeManage = false) {
    updateSearchParams((params) => {
      params.delete("member");
      if (closeManage) params.delete(ORGANIZATION_TAB_PARAM);
    });
  }

  function chooseOrganization(chosen: OrganizationSummary) {
    queryClient.setQueryData<Organization[]>(organizationsKey, (current) =>
      withDefault(current, chosen.id),
    );
    queryClient.setQueryData<OrganizationSummary[]>(summariesKey, (current) =>
      withDefault(current, chosen.id),
    );
    showChosenOrganization(true);
  }

  function setManaging(open: boolean) {
    updateSearchParams((params) => {
      if (open) params.set(ORGANIZATION_TAB_PARAM, MY_ORGANIZATION_TAB);
      else params.delete(ORGANIZATION_TAB_PARAM);
    });
  }

  async function createOrganization(values: OrganizationCreateValues) {
    await createMutation.mutateAsync(values);
  }

  if (
    session.status !== "loading" &&
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
      <OrganizationHeader
        invitationCount={invitations.length}
        loading={loading}
        onCreate={() => setCreating(true)}
        onManage={() => setManaging(true)}
        organization={organization}
        signedIn={Boolean(session.user)}
      />

      {session.user ? (
        <>
          <Dialog onOpenChange={setCreating} open={creating}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Create an organization</DialogTitle>
                <DialogDescription>
                  Create a team, invite members, then share your agents with
                  them.
                </DialogDescription>
              </DialogHeader>
              <OrganizationCreateForm
                onCancel={() => setCreating(false)}
                onCreate={createOrganization}
              />
            </DialogContent>
          </Dialog>

          <OrganizationManageDialog
            invitations={invitations}
            invitationsError={invitationsQuery.error}
            invitationsLoading={invitationsQuery.isPending}
            onChosen={chooseOrganization}
            onInvitationAccepted={() => showChosenOrganization()}
            onOpenChange={setManaging}
            onRetryInvitations={() => void invitationsQuery.refetch()}
            onRetryOrganizations={() => void summariesQuery.refetch()}
            open={managing}
            organizations={summariesQuery.data ?? []}
            organizationsError={summariesQuery.error}
            organizationsLoading={summariesQuery.isPending}
            selectedId={organization?.id ?? null}
          />
        </>
      ) : null}

      {!session.user && !loading ? (
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
      ) : organizationsQuery.error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {organizationsQuery.error instanceof Error
            ? organizationsQuery.error.message
            : "Organizations could not be loaded."}
        </p>
      ) : (
        <>
          {!loading && !organization ? (
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

          {loading || organization ? (
            <Outlet
              key={organization?.id ?? "loading"}
              context={{ organization } satisfies OrganizationContextValue}
            />
          ) : null}
        </>
      )}
    </section>
  );
}
