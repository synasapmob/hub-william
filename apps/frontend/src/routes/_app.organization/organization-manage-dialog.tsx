import { useState } from "react";

import FocusReturnDialogContent from "@/components/focus-return-dialog-content";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type {
  Organization,
  OrganizationInvitation,
  OrganizationSummary,
} from "@/services/organizations";

import OrganizationManageInvitations from "./organization-manage-invitations";
import OrganizationManageRemoveDialog from "./organization-manage-remove-dialog";
import OrganizationManageTable from "./organization-manage-table";

interface OrganizationManageDialogProps {
  invitations: OrganizationInvitation[];
  invitationsError: Error | null;
  invitationsLoading: boolean;
  onChosen: (organization: OrganizationSummary) => void;
  onInvitationAccepted: (organization: Organization) => void;
  onOpenChange: (open: boolean) => void;
  onRetryInvitations: () => void;
  onRetryOrganizations: () => void;
  open: boolean;
  organizations: OrganizationSummary[];
  organizationsError: Error | null;
  organizationsLoading: boolean;
  selectedId: string | null;
}

export default function OrganizationManageDialog({
  invitations,
  invitationsError,
  invitationsLoading,
  onChosen,
  onInvitationAccepted,
  onOpenChange,
  onRetryInvitations,
  onRetryOrganizations,
  open,
  organizations,
  organizationsError,
  organizationsLoading,
  selectedId,
}: OrganizationManageDialogProps) {
  const [removing, setRemoving] = useState<OrganizationSummary | null>(null);

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

        <OrganizationManageTable
          error={organizationsError}
          loading={organizationsLoading}
          onChosen={onChosen}
          onRemove={setRemoving}
          onRetry={onRetryOrganizations}
          organizations={organizations}
          selectedId={selectedId}
        />

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
