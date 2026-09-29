import { useState } from "react";
import { tv } from "tailwind-variants";

import FocusReturnDialogContent from "@/components/focus-return-dialog-content";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  Organization,
  OrganizationInvitation,
} from "@/services/organizations";

import OrganizationManageInvitations from "./organization-manage-invitations";
import OrganizationManageRemoveDialog from "./organization-manage-remove-dialog";
import OrganizationManageRow from "./organization-manage-row";
import OrganizationManageRowSkeleton from "./organization-manage-row-skeleton";

const columnHead = tv({
  base: "h-9 text-[11px] font-medium tracking-wide text-zinc-500 uppercase",
  variants: {
    numeric: { true: "text-right" },
  },
});

const skeletonRows = [0, 1];

interface OrganizationManageDialogProps {
  invitations: OrganizationInvitation[];
  invitationsError: Error | null;
  invitationsLoading: boolean;
  onInvitationAccepted: (organization: Organization) => void;
  onOpenChange: (open: boolean) => void;
  onRetryInvitations: () => void;
  onSelect: (organization: Organization) => void;
  open: boolean;
  organizations: Organization[];
  organizationsLoading: boolean;
  selectedId: string | null;
}

export default function OrganizationManageDialog({
  invitations,
  invitationsError,
  invitationsLoading,
  onInvitationAccepted,
  onOpenChange,
  onRetryInvitations,
  onSelect,
  open,
  organizations,
  organizationsLoading,
  selectedId,
}: OrganizationManageDialogProps) {
  const [removing, setRemoving] = useState<Organization | null>(null);

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!next) setRemoving(null);
        onOpenChange(next);
      }}
      open={open}
    >
      <FocusReturnDialogContent className="gap-5 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>My organizations</DialogTitle>
          <DialogDescription>
            Organizations you own or have joined. Select one to make it the
            default for Overview, Agents, Members and Usage.
          </DialogDescription>
        </DialogHeader>

        <section className="min-w-0 space-y-2">
          {organizationsLoading ? (
            <p role="status" className="sr-only">
              Loading organizations
            </p>
          ) : null}

          <Flex className="items-center justify-between gap-3">
            <h3 className="font-heading text-sm font-semibold">
              Joined organizations
            </h3>

            {organizationsLoading ? (
              <Skeleton className="size-4 bg-zinc-200" />
            ) : (
              <p className="font-mono text-[11px] text-zinc-500">
                {organizations.length}
              </p>
            )}
          </Flex>

          {organizationsLoading || organizations.length > 0 ? (
            <div className="min-w-0 rounded-xl border border-zinc-200">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className={columnHead()}>Organization</TableHead>

                    <TableHead className={columnHead()}>Owner</TableHead>

                    <TableHead className={columnHead({ numeric: true })}>
                      Agents
                    </TableHead>

                    <TableHead className={columnHead({ numeric: true })}>
                      Members
                    </TableHead>

                    <TableHead className={columnHead({ numeric: true })}>
                      Tokens <span className="text-zinc-400">30d</span>
                    </TableHead>

                    <TableHead className={columnHead()}>Created</TableHead>

                    <TableHead className="h-9">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>

                <TableBody>
                  {organizationsLoading
                    ? skeletonRows.map((key) => (
                        <OrganizationManageRowSkeleton key={key} />
                      ))
                    : organizations.map((organization) => (
                        <OrganizationManageRow
                          key={organization.id}
                          onRemove={setRemoving}
                          onSelect={onSelect}
                          organization={organization}
                          selected={organization.id === selectedId}
                        />
                      ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-xs text-zinc-500">
              You have not joined an organization yet. Create one or accept an
              invitation below.
            </p>
          )}
        </section>

        <OrganizationManageInvitations
          error={invitationsError}
          invitations={invitations}
          loading={invitationsLoading}
          onAccepted={onInvitationAccepted}
          onRetry={onRetryInvitations}
        />

        <OrganizationManageRemoveDialog
          onClose={() => setRemoving(null)}
          onRemoved={() => setRemoving(null)}
          organization={removing}
        />
      </FocusReturnDialogContent>
    </Dialog>
  );
}
