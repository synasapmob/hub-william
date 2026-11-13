import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { iconName } from "@/services/icons/icon-labels";
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
  /** The name in the bucket of the icon that is picked; null for none. */
  selected: string | null;
  /** What shows when there is no icon: the provider's first letter. */
  letter: string;
  onRetry: () => void;
  onSelect: (key: string | null) => void;
}

/** What is in the bucket, to pick one from, and the choice of none. */
export default function ProviderIconGrid({
  failed,
  icons,
  letter,
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
      <div aria-busy="true" className="flex flex-wrap gap-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="size-14 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <ul className="flex flex-wrap gap-2">
      <li>
        <button
          aria-label="Không dùng icon"
          aria-pressed={selected === null}
          className={tile({ selected: selected === null })}
          type="button"
          onClick={() => onSelect(null)}
        >
          {letter}
        </button>
      </li>

      {icons.map((icon) => (
        <li key={icon.key}>
          <button
            aria-label={iconName(icon.key)}
            aria-pressed={selected === icon.key}
            className={tile({ selected: selected === icon.key })}
            title={iconName(icon.key)}
            type="button"
            onClick={() => onSelect(icon.key)}
          >
            <img
              alt=""
              className="size-full rounded-md object-contain"
              src={icon.url}
            />
          </button>
        </li>
      ))}
    </ul>
  );
}
