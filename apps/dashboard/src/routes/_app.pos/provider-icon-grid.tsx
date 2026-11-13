import { Trash2 } from "lucide-react";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { iconName, iconUserName } from "@/services/icons/icon-labels";
import type { LibraryIcon } from "@/services/icons/icon-service";

const tile = tv({
  base: "flex size-14 items-center justify-center rounded-lg border bg-card p-2 text-sm font-medium text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
  variants: {
    selected: {
      true: "border-primary ring-2 ring-primary",
      false: "hover:bg-muted",
    },
  },
});

interface ProviderIconGridProps {
  /** Null while the bucket is being read, the icons once it answered. */
  icons: LibraryIcon[] | null;
  failed: boolean;
  /** The name in the bucket of the icon that is picked; null while none is. */
  selected: string | null;
  onDelete: (icon: LibraryIcon) => void;
  onRetry: () => void;
  onSelect: (key: string | null) => void;
}

/** What is in the bucket, to pick one from, wrapping onto as many lines as it takes. */
export default function ProviderIconGrid({
  failed,
  icons,
  onDelete,
  onRetry,
  onSelect,
  selected,
}: ProviderIconGridProps) {
  if (failed) {
    return (
      <div className="space-y-2 text-sm" role="alert">
        <p className="text-destructive">Không tải được danh sách icon.</p>

        <Button size="sm" variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    );
  }

  if (!icons) {
    return (
      <div aria-busy="true" className="flex flex-wrap gap-2 p-1.5">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="size-14 rounded-lg" />
        ))}
      </div>
    );
  }

  if (icons.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Chưa có icon nào trong bucket. Tải icon mới lên để chọn.
      </p>
    );
  }

  return (
    // As many as there are, wrapping onto the next line and then scrolling, so a
    // bucket with dozens does not push the buttons of the dialog off the screen. The
    // padding keeps the trash buttons on the corners from being cut off.
    <ul className="flex max-h-64 flex-wrap gap-2 overflow-y-auto p-1.5">
      {icons.map((icon) => (
        <li key={icon.key} className="group relative">
          <button
            aria-label={iconName(icon.key)}
            aria-pressed={selected === icon.key}
            className={tile({ selected: selected === icon.key })}
            title={
              icon.used_by.length > 0
                ? `${iconName(icon.key)}, đang dùng bởi ${icon.used_by.map(iconUserName).join(", ")}`
                : iconName(icon.key)
            }
            type="button"
            onClick={() => onSelect(icon.key)}
          >
            <img
              alt=""
              className="size-full rounded-md object-contain"
              src={icon.url}
            />
          </button>

          <button
            aria-label={`Xóa icon ${iconName(icon.key)}`}
            className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground opacity-0 shadow-sm outline-none group-hover:opacity-100 hover:text-destructive focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50 [@media(hover:none)]:opacity-100"
            type="button"
            onClick={() => onDelete(icon)}
          >
            <Trash2 aria-hidden={true} className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}
