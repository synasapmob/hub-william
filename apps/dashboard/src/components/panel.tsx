import type { PropsWithChildren } from "react";
import { tv } from "tailwind-variants";

const panel = tv({
  base: "rounded-xl border bg-card text-card-foreground",
  variants: { padded: { true: "p-4" } },
});

interface PanelProps extends PropsWithChildren {
  className?: string;
  padded?: boolean;
}

/** The white surface every block of a page sits on. */
export default function Panel({
  children,
  className,
  padded = true,
}: PanelProps) {
  return <div className={panel({ className, padded })}>{children}</div>;
}
