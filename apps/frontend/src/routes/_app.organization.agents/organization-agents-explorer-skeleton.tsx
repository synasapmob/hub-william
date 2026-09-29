import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import { AGENT_PROVIDERS } from "@/utils/utils.agent-pools";

const skeletonAccounts = [0, 1, 2];

// Mirrors OrganizationAgentsExplorer: the provider column, the search row and
// the account cards, with only their values left as placeholders.
export default function OrganizationAgentsExplorerSkeleton() {
  return (
    <div
      aria-hidden="true"
      className="relative grid min-h-64 items-start gap-x-12 gap-y-8 pr-2 pb-8 pl-4 lg:grid-cols-[10rem_minmax(0,1fr)]"
    >
      <div className="min-w-0">
        <h2 className="relative z-10 mb-4 text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
          Providers
        </h2>

        <Flex className="flex-wrap gap-2 lg:flex-col">
          {AGENT_PROVIDERS.map((provider) => (
            <Flex
              key={provider}
              className="min-h-12 min-w-32 items-center gap-2.5 rounded-xl border border-transparent px-3"
            >
              <Skeleton className="size-6 shrink-0 bg-zinc-200" />

              <Skeleton className="h-3 w-16 bg-zinc-200" />

              <Skeleton className="ml-auto size-3 bg-zinc-200" />
            </Flex>
          ))}
        </Flex>
      </div>

      <div className="min-w-0">
        <Flex className="mb-4 items-center gap-3">
          <Skeleton className="h-10 min-w-0 flex-1 rounded-lg bg-zinc-200/70" />

          <Skeleton className="h-10 w-32 shrink-0 rounded-lg bg-zinc-200/70" />
        </Flex>

        <ul className="space-y-3">
          {skeletonAccounts.map((key) => (
            <li
              key={key}
              className="grid items-center gap-3 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs sm:grid-cols-[minmax(0,1fr)_auto]"
            >
              <div className="space-y-2">
                <Skeleton className="h-3.5 w-32 max-w-full bg-zinc-200" />

                <Skeleton className="h-3 w-24 bg-zinc-100" />

                <Skeleton className="h-3 w-44 max-w-full bg-zinc-100" />
              </div>

              <Skeleton className="h-5 w-16 rounded-4xl bg-zinc-200 sm:justify-self-end" />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
