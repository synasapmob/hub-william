import type { PropsWithChildren } from "react";

import Panel from "@/components/panel";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import ImageFallBack from "@/components/ui/image-fallback";

interface DashboardGateScreenProps extends PropsWithChildren {
  title: string;
  description?: string;
}

/** A page of its own, for the moments before there is a dashboard to show. */
export default function DashboardGateScreen({
  children,
  description,
  title,
}: DashboardGateScreenProps) {
  return (
    <Center className="min-h-svh bg-background p-4 text-foreground">
      <Panel className="w-full max-w-sm space-y-5">
        <Flex className="items-center gap-2.5">
          <Center className="size-10 shrink-0">
            <ImageFallBack
              alt=""
              className="pointer-events-none size-16 object-cover"
              fallback="HW"
              src="/logo.png"
            />
          </Center>

          <p className="text-xs font-semibold tracking-wider uppercase">
            Hub-William Dashboard
          </p>
        </Flex>

        <div className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>

          {description && (
            <p className="text-sm text-muted-foreground">{description}</p>
          )}
        </div>

        {children}
      </Panel>
    </Center>
  );
}
