import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { StaffMember } from "@/services/sales/sales-types";

interface StaffDeleteDialogProps {
  member: StaffMember;
  onClose: () => void;
  /** Rejects when the member could not be removed; the dialog then stays. */
  onDelete: () => Promise<void>;
}

export default function StaffDeleteDialog({
  member,
  onClose,
  onDelete,
}: StaffDeleteDialogProps) {
  const [saving, setSaving] = useState(false);

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xóa {member.username}?</DialogTitle>

          <DialogDescription>
            Tài khoản {member.username} không vào được dashboard nữa. Tài khoản
            Hub William và các đơn họ đã bán vẫn giữ nguyên.
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button disabled={saving} variant="outline" onClick={onClose}>
            Giữ lại
          </Button>

          <Button
            disabled={saving}
            variant="destructive"
            onClick={async () => {
              setSaving(true);

              try {
                await onDelete();
              } catch {
                // The page has said why; the dialog stays for another try.
              } finally {
                setSaving(false);
              }
            }}
          >
            Xóa
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
