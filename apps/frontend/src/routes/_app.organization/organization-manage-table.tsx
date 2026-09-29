import { useMutation } from "@tanstack/react-query";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import organizationsService, {
  ORGANIZATION_SUMMARY_DAYS,
} from "@/services/organizations";
import type { OrganizationSummary } from "@/services/organizations";

import OrganizationManageRow from "./organization-manage-row";
import OrganizationManageRowSkeleton from "./organization-manage-row-skeleton";

const columnHead = tv({
  base: "h-9 text-[11px] font-medium tracking-wide text-zinc-500 uppercase",
  variants: {
    numeric: { true: "text-right" },
  },
});

const skeletonRows = [0, 1];

interface OrganizationManageTableProps {
  error: Error | null;
  loading: boolean;
  // The organization is now the default, or already was: the pages can show it.
  onChosen: (organization: OrganizationSummary) => void;
  onRemove: (organization: OrganizationSummary) => void;
  onRetry: () => void;
  organizations: OrganizationSummary[];
  // The organization the Organization pages are showing right now.
  selectedId: string | null;
}

// The choice lives here, inside the open dialog, so a failed attempt is gone
// once the dialog closes instead of greeting the next visit.
export default function OrganizationManageTable({
  error,
  loading,
  onChosen,
  onRemove,
  onRetry,
  organizations,
  selectedId,
}: OrganizationManageTableProps) {
  const chooseMutation = useMutation({
    mutationFn: (organization: OrganizationSummary) =>
      organizationsService.setDefault(organization.id),
    onSuccess: (_, organization) => onChosen(organization),
  });

  function select(organization: OrganizationSummary) {
    if (organization.isDefault) onChosen(organization);
    else chooseMutation.mutate(organization);
  }

  return (
    <section className="min-w-0 space-y-2">
      {loading ? (
        <p role="status" className="sr-only">
          Loading organizations
        </p>
      ) : null}

      <Flex className="items-center justify-between gap-3">
        <h3 className="font-heading text-sm font-semibold">
          Joined organizations
        </h3>

        {loading ? (
          <Skeleton className="size-4 bg-zinc-200" />
        ) : error ? null : (
          <p className="font-mono text-[11px] text-zinc-500">
            {organizations.length}
          </p>
        )}
      </Flex>

      {error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{error.message || "Organizations could not be loaded."}</p>

          <Button
            className="mt-3"
            onClick={onRetry}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry organizations
          </Button>
        </div>
      ) : loading || organizations.length > 0 ? (
        <div className="min-w-0 rounded-xl border border-zinc-200">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className={columnHead()}>Organization</TableHead>

                <TableHead className={columnHead()}>Owner</TableHead>

                <TableHead className={columnHead({ numeric: true })}>
                  Agents
                </TableHead>

                <TableHead className={columnHead({ numeric: true })}>
                  Members
                </TableHead>

                <TableHead className={columnHead({ numeric: true })}>
                  Tokens{" "}
                  <span className="text-zinc-400">
                    {ORGANIZATION_SUMMARY_DAYS}d
                  </span>
                </TableHead>

                <TableHead className={columnHead()}>Created</TableHead>

                <TableHead className="h-9">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>

            <TableBody>
              {loading
                ? skeletonRows.map((key) => (
                    <OrganizationManageRowSkeleton key={key} />
                  ))
                : organizations.map((organization) => (
                    <OrganizationManageRow
                      key={organization.id}
                      choosing={chooseMutation.isPending}
                      onRemove={onRemove}
                      onSelect={select}
                      organization={organization}
                      selected={organization.id === selectedId}
                    />
                  ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-xs text-zinc-500">
          You have not joined an organization yet. Create one or accept an
          invitation below.
        </p>
      )}

      {chooseMutation.error ? (
        <p role="alert" className="text-sm text-destructive">
          {chooseMutation.error.message}
        </p>
      ) : null}
    </section>
  );
}
