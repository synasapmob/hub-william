import type { PropsWithChildren } from "react";

import Flex from "@/components/ui/flex";

interface PageHeaderProps extends PropsWithChildren {
  title: string;
  description: string;
}

/** The title row of a page; `children` are its actions, on the right. */
export default function PageHeader({
  children,
  description,
  title,
}: PageHeaderProps) {
  return (
    <Flex className="flex-wrap items-end justify-between gap-3">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>

        <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
      </header>

      {children && <Flex className="items-center gap-2">{children}</Flex>}
    </Flex>
  );
}
