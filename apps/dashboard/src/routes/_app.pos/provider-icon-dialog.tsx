import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { useProviderIcons } from "@/components/provider-icons-context";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { iconService } from "@/services/icons/icon-service";
import slugify from "@/utils/utils.slug";

import ProviderIconChoice from "./provider-icon-choice";

interface ProviderIconDialogProps {
  /** The provider as the shop writes it; its slug is what the icon is kept under. */
  provider: string;
  /** What to call the provider, and what an uploaded icon's name starts with. */
  name: string;
  onClose: () => void;
}

/**
 * Changes the icon of a provider, or gives one to a provider that lost its own.
 * Nothing changes until "Lưu", and there is no choice of none: a provider has an icon.
 */
export default function ProviderIconDialog({
  name,
  onClose,
  provider,
}: ProviderIconDialogProps) {
  const queryClient = useQueryClient();
  const { iconOf } = useProviderIcons();
  const current = iconOf(provider)?.key ?? null;
  const [selected, setSelected] = useState<string | null>(current);
  const [problem, setProblem] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => iconService.assign(slugify(provider), selected as string),
    onError: (error) => setProblem(error.message),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: iconService.queryKey });
      toast.success(`Đã đổi icon của ${name}`);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Icon của {name}</DialogTitle>

          <DialogDescription>
            Chọn một icon có sẵn hoặc tải icon mới lên. PNG, JPEG, GIF hoặc
            WebP, tối đa 256 KB.
          </DialogDescription>
        </DialogHeader>

        <ProviderIconChoice
          name={name}
          selected={selected}
          onSelect={setSelected}
        />

        {problem && (
          <p className="text-sm text-destructive" role="alert">
            {problem}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Hủy
          </Button>

          <Button
            disabled={
              selected === null || selected === current || save.isPending
            }
            onClick={() => save.mutate()}
          >
            Lưu
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
