import Flex from "@/components/ui/flex";

export default function AgentsPoolCardSkeleton() {
  return (
    <li
      aria-hidden="true"
      className="relative z-10 grid items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs sm:grid-cols-[minmax(0,1fr)_minmax(10rem,0.8fr)_1.5rem]"
    >
      <div className="space-y-2">
        <div className="h-3.5 w-36 max-w-full animate-pulse rounded bg-zinc-200" />

        <div className="h-3 w-24 animate-pulse rounded bg-zinc-100" />
      </div>

      <div>
        <Flex className="items-center justify-between gap-3">
          <div className="h-3 w-16 animate-pulse rounded bg-zinc-100" />

          <div className="h-3 w-20 animate-pulse rounded bg-zinc-200" />
        </Flex>

        <div className="mt-2 h-1 w-full animate-pulse rounded-full bg-zinc-100" />
      </div>

      <div className="absolute top-4 right-4 size-6 animate-pulse rounded-full bg-zinc-100 sm:static" />
    </li>
  );
}
