import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { iconService } from "@/services/icons/icon-service";
import slugify from "@/utils/utils.slug";

import ProviderIconChoice from "./provider-icon-choice";

const MAX_NAME = 64;

interface ProviderCreateDialogProps {
  /** Every provider the shop can already choose, so one is not made twice under two spellings. */
  known: string[];
  onClose: () => void;
  /** The new provider's name, once its icon is kept; the first package is added under it. */
  onContinue: (name: string) => void;
}

/**
 * Names a provider the shop does not have yet and gives it an icon, chosen from the
 * bucket or put there now. A provider exists once it has a package, so "Tiếp tục"
 * opens the form of its first one; the icon is kept at once, under the provider's slug.
 */
export default function ProviderCreateDialog({
  known,
  onClose,
  onContinue,
}: ProviderCreateDialogProps) {
  const queryClient = useQueryClient();
  const { enabled } = useProviderIcons();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const slug = slugify(name);
  const exists = slug !== "" && known.some((other) => slugify(other) === slug);

  const next = useMutation({
    mutationFn: async () => {
      if (selected) await iconService.assign(slug, selected);
    },
    onError: (error) => setProblem(error.message),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: iconService.queryKey });
      onContinue(name.trim());
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();

            if (slug !== "" && !exists && !next.isPending) next.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Thêm nhà cung cấp</DialogTitle>

            <DialogDescription>
              Đặt tên và chọn icon cho nhà cung cấp mới. Bước tiếp theo là thêm
              gói đầu tiên của họ: nhà cung cấp có card khi đã có gói.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="provider-name">Tên nhà cung cấp</Label>

            <Input
              id="provider-name"
              aria-invalid={exists}
              autoComplete="off"
              maxLength={MAX_NAME}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />

            {exists && (
              <p className="text-sm text-destructive" role="alert">
                Đã có nhà cung cấp này. Thêm gói ở card của họ, hoặc chọn họ
                trong form thêm gói.
              </p>
            )}
          </div>

          {enabled && (
            <ProviderIconChoice
              name={name.trim() || "Icon"}
              selected={selected}
              onSelect={setSelected}
            />
          )}

          {problem && (
            <p className="text-sm text-destructive" role="alert">
              {problem}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Hủy
            </Button>

            <Button
              disabled={slug === "" || exists || next.isPending}
              type="submit"
            >
              Tiếp tục
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
