import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { TableCell, TableRow } from "@/components/ui/table";
import type { OrganizationSummary } from "@/services/organizations";

import {
  formatCount,
  formatDate,
  formatTokenCount,
} from "./organization-format";

interface OrganizationManageRowProps {
  // A choice is on its way to the server, so another one has to wait.
  choosing: boolean;
  onRemove: (organization: OrganizationSummary) => void;
  onSelect: (organization: OrganizationSummary) => void;
  organization: OrganizationSummary;
  selected: boolean;
}

export default function OrganizationManageRow({
  choosing,
  onRemove,
  onSelect,
  organization,
  selected,
}: OrganizationManageRowProps) {
  return (
    <TableRow
      className="relative"
      data-state={selected ? "selected" : undefined}
    >
      <TableCell>
        <div className="max-w-56 min-w-36">
          <Flex className="flex-wrap items-center gap-1.5">
            <button
              className="cursor-pointer rounded-sm text-left text-xs font-semibold wrap-anywhere whitespace-normal text-zinc-900 outline-hidden after:absolute after:inset-0 hover:underline focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait"
              disabled={choosing}
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
        @{organization.ownerUsername}
        {organization.role === "owner" ? (
          <span className="text-zinc-400"> (you)</span>
        ) : null}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatCount(organization.agentCount)}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {formatCount(organization.memberCount)}
      </TableCell>

      <TableCell className="text-right font-mono text-xs tabular-nums">
        {organization.tokenKnownRequests > 0
          ? formatTokenCount(
              organization.knownInputTokens + organization.knownOutputTokens,
            )
          : "—"}
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
