import type { HTMLAttributes, ReactNode } from "react";
import { tv } from "tailwind-variants";

interface FlexProps extends HTMLAttributes<HTMLDivElement> {
  children?: ReactNode;
}

export default function Flex({ className, ...props }: FlexProps) {
  return <div className={tv({ base: "flex" })({ className })} {...props} />;
}
