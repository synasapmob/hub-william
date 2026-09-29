import { useMutation, useQueryClient } from "@tanstack/react-query";

import FocusReturnDialogContent from "@/components/focus-return-dialog-content";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import organizationsService from "@/services/organizations";
import type { Organization } from "@/services/organizations";

// An owner removing an organization deletes it for everyone; anyone else only
// leaves it. The confirmation says which of the two is about to happen.
const removeCopy = {
  member: {
    action: "Leave organization",
    description:
      "Do you want to leave this organization? You won't be able to use anything related to it anymore, including its shared agents in Playground. Accounts you shared into it are unlinked but stay connected in your Workspace.",
    pending: "Leaving…",
    verb: "Leave",
  },
  owner: {
    action: "Delete organization",
    description:
      "Are you sure you want to delete this organization? Everyone in it will leave, and its members, shared agents and usage history will be removed. Accounts shared into it stay connected in their owners' Workspace.",
    pending: "Deleting…",
    verb: "Delete",
  },
} as const;

interface OrganizationManageRemovePanelProps {
  onClose: () => void;
  onRemoved: (organization: Organization) => void;
  organization: Organization;
}

// Keyed by organization so a failed attempt never leaks into the next one.
function OrganizationManageRemovePanel({
  onClose,
  onRemoved,
  organization,
}: OrganizationManageRemovePanelProps) {
  const queryClient = useQueryClient();
  const copy = removeCopy[organization.role];
  const removeMutation = useMutation({
    mutationFn: () =>
      organization.role === "owner"
        ? organizationsService.deleteOrganization(organization.id)
        : organizationsService.leave(organization.id),
    onSuccess: async () => {
      // The organization no longer exists for this user, so refetching what
      // was cached for it would only produce forbidden responses.
      await queryClient.invalidateQueries({
        queryKey: organizationsService.queryKey,
        predicate: (query) => query.queryKey[1] !== organization.id,
      });
      onRemoved(organization);
    },
  });

  return (
    <FocusReturnDialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle className="wrap-anywhere">
          {copy.verb} {organization.name}?
        </DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>

      {removeMutation.error ? (
        <p role="alert" className="text-sm text-destructive">
          {removeMutation.error.message}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          disabled={removeMutation.isPending}
          onClick={onClose}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>

        <Button
          disabled={removeMutation.isPending}
          onClick={() => removeMutation.mutate()}
          type="button"
          variant="destructive"
        >
          {removeMutation.isPending ? copy.pending : copy.action}
        </Button>
      </DialogFooter>
    </FocusReturnDialogContent>
  );
}

interface OrganizationManageRemoveDialogProps {
  onClose: () => void;
  onRemoved: (organization: Organization) => void;
  organization: Organization | null;
}

export default function OrganizationManageRemoveDialog({
  onClose,
  onRemoved,
  organization,
}: OrganizationManageRemoveDialogProps) {
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      open={organization !== null}
    >
      {organization ? (
        <OrganizationManageRemovePanel
          key={organization.id}
          onClose={onClose}
          onRemoved={onRemoved}
          organization={organization}
        />
      ) : null}
    </Dialog>
  );
}
