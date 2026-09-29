import { useQuery } from "@tanstack/react-query";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";
import organizationsService from "@/services/organizations";
import type { Organization } from "@/services/organizations";

import {
  formatCount,
  formatDate,
  formatTokenCount,
} from "./organization-format";

interface OrganizationManageRowProps {
  onRemove: (organization: Organization) => void;
  onSelect: (organization: Organization) => void;
  organization: Organization;
  selected: boolean;
}

export default function OrganizationManageRow({
  onRemove,
  onSelect,
  organization,
  selected,
}: OrganizationManageRowProps) {
  // Same keys as the Overview and Members pages, so the cache is shared.
  const overviewQuery = useQuery({
    queryFn: () => organizationsService.overview(organization.id, 30),
    queryKey: [
      ...organizationsService.queryKey,
      organization.id,
      "overview",
      30,
    ],
  });
  const membersQuery = useQuery({
    queryFn: () => organizationsService.members(organization.id),
    queryKey: [...organizationsService.queryKey, organization.id, "members"],
  });
  const overview = overviewQuery.data;
  const owner = membersQuery.data?.find((member) => member.role === "owner");
  const overviewPending = overviewQuery.isPending;

  return (
    <TableRow
      className="relative"
      data-state={selected ? "selected" : undefined}
    >
      <TableCell>
        <div className="max-w-56 min-w-36">
          <Flex className="flex-wrap items-center gap-1.5">
            <button
              className="cursor-pointer rounded-sm text-left text-xs font-semibold wrap-anywhere whitespace-normal text-zinc-900 outline-hidden after:absolute after:inset-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onSelect(organization)}
              type="button"
            >
              {organization.name}
            </button>

            {selected ? (
              <Badge className="bg-white" variant="outline">
                Default
              </Badge>
            ) : null}
          </Flex>

          {organization.description ? (
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">
              {organization.description}
            </p>
          ) : null}
        </div>
      </TableCell>

      <TableCell className="text-xs text-zinc-700">
        {membersQuery.isPending ? (
          <Skeleton className="h-3 w-20 bg-zinc-200" />
        ) : owner ? (
          <>
            @{owner.username}
            {organization.role === "owner" ? (
              <span className="text-zinc-400"> (you)</span>
            ) : null}
          </>
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {overviewPending ? (
          <Skeleton className="ml-auto h-3 w-6 bg-zinc-200" />
        ) : overview ? (
          formatCount(overview.agentCount)
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {overviewPending ? (
          <Skeleton className="ml-auto h-3 w-6 bg-zinc-200" />
        ) : overview ? (
          formatCount(overview.memberCount)
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {overviewPending ? (
          <Skeleton className="ml-auto h-3 w-8 bg-zinc-200" />
        ) : overview && overview.tokenKnownRequests > 0 ? (
          formatTokenCount(
            overview.knownInputTokens + overview.knownOutputTokens,
          )
        ) : (
          "—"
        )}
      </TableCell>

      <TableCell className="text-xs text-zinc-600">
        <time dateTime={organization.createdAt}>
          {formatDate(organization.createdAt)}
        </time>
      </TableCell>

      <TableCell className="text-right">
        <Button
          className="relative z-10 text-destructive hover:text-destructive"
          onClick={() => onRemove(organization)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Remove
        </Button>
      </TableCell>
    </TableRow>
  );
}
