import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";

const skeletonBar = tv({
  base: "animate-pulse rounded-md bg-zinc-200",
});

interface AgentsPoolCardSkeletonBarProps {
  className: string;
}

function AgentsPoolCardSkeletonBar({
  className,
}: AgentsPoolCardSkeletonBarProps) {
  return <div className={skeletonBar({ className })} />;
}

export default function AgentsPoolCardSkeleton() {
  return (
    <li className="h-full">
      <Card className="h-full border-0 bg-white/95 py-0 gap-0 shadow-sm ring-slate-200/90">
        <CardHeader className="gap-4 border-b border-slate-100 py-4 flex-1 flex flex-col">
          <Flex className="justify-between flex-wrap gap-3 flex-1 w-full">
            <Flex className="gap-3">
              <AgentsPoolCardSkeletonBar className="size-9 shrink-0 rounded-lg" />

              <div className="space-y-2">
                <AgentsPoolCardSkeletonBar className="h-4 w-32" />

                <AgentsPoolCardSkeletonBar className="h-3 w-24" />
              </div>
            </Flex>

            <AgentsPoolCardSkeletonBar className="h-5 w-12 rounded-full" />
          </Flex>

          <AgentsPoolCardSkeletonBar className="h-10 w-full" />

          <AgentsPoolCardSkeletonBar className="h-10 w-full" />
        </CardHeader>

        <CardFooter className="gap-2 p-3">
          <AgentsPoolCardSkeletonBar className="h-10 w-full" />
        </CardFooter>
      </Card>
    </li>
  );
}
