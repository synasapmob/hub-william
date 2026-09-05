import type { ComponentProps } from "react";
import { tv, type VariantProps } from "tailwind-variants";

const flexVariants = tv({
  base: "flex",
  variants: {
    direction: {
      row: "flex-row",
      column: "flex-col",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      between: "justify-between",
      end: "justify-end",
    },
    gap: {
      none: "gap-0",
      xs: "gap-1.5",
      sm: "gap-2",
      md: "gap-3",
      lg: "gap-4",
      xl: "gap-6",
    },
    wrap: {
      true: "flex-wrap",
    },
  },
  defaultVariants: {
    direction: "row",
    align: "center",
    gap: "md",
  },
});

interface FlexProps
  extends ComponentProps<"div">, VariantProps<typeof flexVariants> {}

export default function Flex({
  align,
  className,
  direction,
  gap,
  justify,
  wrap,
  ...props
}: FlexProps) {
  return (
    <div
      className={flexVariants({
        align,
        direction,
        gap,
        justify,
        wrap,
        className,
      })}
      {...props}
    />
  );
}
