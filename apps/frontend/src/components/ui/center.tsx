import type { HTMLAttributes, ReactNode } from "react";
import { tv } from "tailwind-variants";

interface CenterProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export default function Center({ className, ...props }: CenterProps) {
  return (
    <div
      className={tv({ base: "flex items-center justify-center" })({
        className,
      })}
      {...props}
    />
  );
}
