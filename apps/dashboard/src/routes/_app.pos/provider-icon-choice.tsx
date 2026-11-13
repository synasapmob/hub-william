import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import {
  ICON_TYPES,
  MAXIMUM_ICON_BYTES,
  iconService,
} from "@/services/icons/icon-service";

import ProviderIconGrid from "./provider-icon-grid";

interface ProviderIconChoiceProps {
  /** What to call the provider: an uploaded icon's name starts with it, and its first letter stands for no icon. */
  name: string;
  /** The name in the bucket of the icon that is picked; null for none. */
  selected: string | null;
  onSelect: (key: string | null) => void;
}

/**
 * Picks an icon from the bucket, or puts a picture there now and picks it. Nothing
 * is given to a provider here: the dialog around it does that, when it is saved.
 * A picture, once uploaded, stays in the bucket for the next provider that wants it.
 */
export default function ProviderIconChoice({
  name,
  onSelect,
  selected,
}: ProviderIconChoiceProps) {
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const library = useQuery({
    queryFn: () => iconService.library(),
    queryKey: iconService.libraryKey,
  });

  const upload = useMutation({
    mutationFn: (file: File) => iconService.upload(file, name),
    onError: (error) => setProblem(error.message),
    onSuccess: async (key) => {
      setProblem(null);
      onSelect(key);
      await queryClient.invalidateQueries({ queryKey: iconService.libraryKey });
    },
  });

  return (
    <div className="space-y-3">
      <ProviderIconGrid
        failed={library.isError}
        icons={library.data ?? null}
        letter={name.trim().charAt(0).toUpperCase()}
        selected={selected}
        onRetry={() => void library.refetch()}
        onSelect={onSelect}
      />

      {problem && (
        <p className="text-sm text-destructive" role="alert">
          {problem}
        </p>
      )}

      <input
        ref={fileInput}
        accept={ICON_TYPES.join(",")}
        aria-label="Tệp icon"
        className="hidden"
        type="file"
        onChange={(event) => {
          const file = event.target.files?.[0];

          // So choosing the same file again still counts as a choice.
          event.target.value = "";

          if (!file) return;

          if (!(ICON_TYPES as readonly string[]).includes(file.type)) {
            setProblem("Chỉ nhận ảnh PNG, JPEG, GIF hoặc WebP.");

            return;
          }

          if (file.size > MAXIMUM_ICON_BYTES) {
            setProblem("Icon nặng tối đa 256 KB.");

            return;
          }

          upload.mutate(file);
        }}
      />

      <Button
        disabled={upload.isPending}
        size="sm"
        type="button"
        variant="outline"
        onClick={() => fileInput.current?.click()}
      >
        {upload.isPending ? "Đang tải lên…" : "Tải icon mới"}
      </Button>
    </div>
  );
}
