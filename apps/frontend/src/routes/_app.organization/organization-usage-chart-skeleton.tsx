import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";

// Fixed heights, in percent, so the placeholder never jitters between renders.
const barHeights = [35, 60, 25, 75, 50, 20, 65, 45, 85, 30, 55, 40, 70, 25];

// Mirrors OrganizationUsageChart: the bars, the date row and the "Daily values"
// disclosure, at the same heights.
export default function OrganizationUsageChartSkeleton() {
  return (
    <div aria-hidden="true">
      <Flex className="h-32 items-end gap-0.5 border-b border-zinc-200">
        {barHeights.map((height, index) => (
          <Flex
            key={index}
            className="h-full min-w-0 flex-1 items-end justify-center"
          >
            <Skeleton
              className="w-full max-w-3 rounded-b-none rounded-t-sm bg-zinc-200"
              style={{ height: `${height}%` }}
            />
          </Flex>
        ))}
      </Flex>

      <Flex className="mt-2 h-4 items-center justify-between gap-2">
        <Skeleton className="h-3 w-16 bg-zinc-200" />

        <Skeleton className="h-3 w-16 bg-zinc-200" />
      </Flex>

      <Flex className="mt-1 h-9 items-center">
        <Skeleton className="h-3 w-24 bg-zinc-200" />
      </Flex>
    </div>
  );
}
