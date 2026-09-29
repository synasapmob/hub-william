import { useMutation, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import organizationsService from "@/services/organizations";
import type {
  Organization,
  OrganizationInvitation,
} from "@/services/organizations";

interface OrganizationManageInvitationsProps {
  error: Error | null;
  invitations: OrganizationInvitation[];
  loading: boolean;
  onAccepted: (organization: Organization) => void;
  onRetry: () => void;
}

export default function OrganizationManageInvitations({
  error,
  invitations,
  loading,
  onAccepted,
  onRetry,
}: OrganizationManageInvitationsProps) {
  const queryClient = useQueryClient();
  const acceptMutation = useMutation({
    mutationFn: (id: string) => organizationsService.acceptInvitation(id),
    onSuccess: async (organization) => {
      onAccepted(organization);
      await queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      });
    },
  });
  const declineMutation = useMutation({
    mutationFn: (id: string) => organizationsService.declineInvitation(id),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
      }),
  });
  const busy = acceptMutation.isPending || declineMutation.isPending;
  const decisionError = acceptMutation.error ?? declineMutation.error;

  return (
    <section className="space-y-3">
      <Flex className="items-center justify-between gap-3">
        <h3 className="font-heading text-sm font-semibold">Invitations</h3>

        {loading ? (
          <Skeleton className="size-4 bg-zinc-200" />
        ) : (
          <p className="font-mono text-[11px] text-zinc-500">
            {invitations.length}
          </p>
        )}
      </Flex>

      {loading ? (
        <>
          <p role="status" className="sr-only">
            Loading invitations
          </p>

          <div
            aria-hidden="true"
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3"
          >
            <Skeleton className="h-4 w-56 max-w-full bg-zinc-200" />

            <Flex className="gap-2">
              <Skeleton className="h-7 w-16 rounded-lg bg-zinc-200" />

              <Skeleton className="h-7 w-16 rounded-lg bg-zinc-200" />
            </Flex>
          </div>
        </>
      ) : null}

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{error.message || "Invitations could not be loaded."}</p>

          <Button
            className="mt-3"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry invitations
          </Button>
        </div>
      ) : null}

      {invitations.length > 0 ? (
        <ul className="space-y-2">
          {invitations.map((invitation) => (
            <li
              key={invitation.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-indigo-200 bg-indigo-50/50 p-3"
            >
              <p className="min-w-0 text-sm wrap-anywhere">
                <strong>{invitation.organizationName}</strong> · invited by @
                {invitation.invitedByUsername ?? "unknown"}
              </p>

              <Flex className="gap-2">
                <Button
                  disabled={busy}
                  onClick={() => acceptMutation.mutate(invitation.id)}
                  size="sm"
                  type="button"
                >
                  Accept
                </Button>

                <Button
                  disabled={busy}
                  onClick={() => declineMutation.mutate(invitation.id)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Decline
                </Button>
              </Flex>
            </li>
          ))}
        </ul>
      ) : null}

      {!loading && invitations.length === 0 && !error ? (
        <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-xs text-zinc-500">
          No pending invitations.
        </p>
      ) : null}

      {decisionError ? (
        <p role="alert" className="text-sm text-destructive">
          {decisionError.message}
        </p>
      ) : null}
    </section>
  );
}
