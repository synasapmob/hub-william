import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { iconName, iconUserName } from "@/services/icons/icon-labels";
import { iconService, type LibraryIcon } from "@/services/icons/icon-service";

interface ProviderIconDeleteDialogProps {
  icon: LibraryIcon;
  onClose: () => void;
  /** The icon is gone from the bucket and from the providers that showed it. */
  onDeleted: () => void;
}

/**
 * Asks before an icon is deleted, and says who it affects: deleting it takes it
 * from every provider that shows it, which go back to their first letter, and
 * from the bucket for good.
 */
export default function ProviderIconDeleteDialog({
  icon,
  onClose,
  onDeleted,
}: ProviderIconDeleteDialogProps) {
  const queryClient = useQueryClient();
  const users = icon.used_by.map(iconUserName);

  const remove = useMutation({
    mutationFn: () => iconService.remove(icon.key),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: iconService.queryKey });
      toast.success("Đã xóa icon");
      onDeleted();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(open) => !open && !remove.isPending && onClose()}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Xóa icon này?</DialogTitle>

          <DialogDescription>
            {users.length > 0
              ? `Icon đang được dùng bởi ${users.join(", ")}. Xóa thì ${users.length > 1 ? "các nhà cung cấp này" : "nhà cung cấp này"} mất icon và hiện chữ cái đầu của tên. `
              : "Chưa nhà cung cấp nào dùng icon này. "}
            Ảnh bị xóa khỏi bucket và không hoàn tác được.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-3 rounded-lg border p-2">
          <img
            alt=""
            className="size-10 rounded-md object-contain"
            src={icon.url}
          />

          <p className="min-w-0 truncate text-sm">{iconName(icon.key)}</p>
        </div>

        {remove.error && (
          <p className="text-sm text-destructive" role="alert">
            {remove.error.message}
          </p>
        )}

        <DialogFooter>
          <Button
            disabled={remove.isPending}
            variant="outline"
            onClick={onClose}
          >
            Hủy
          </Button>

          <Button
            disabled={remove.isPending}
            variant="destructive"
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Đang xóa…" : "Xóa icon"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
