import { Skeleton } from "@/components/ui/skeleton";
import { TableCell, TableRow } from "@/components/ui/table";

// Mirrors OrganizationManageRow while the organization list is still loading.
export default function OrganizationManageRowSkeleton() {
  return (
    <TableRow aria-hidden="true" className="hover:bg-transparent">
      <TableCell>
        <div className="max-w-56 min-w-36 space-y-1.5">
          <Skeleton className="h-3.5 w-28 bg-zinc-200" />

          <Skeleton className="h-2.5 w-40 max-w-full bg-zinc-100" />
        </div>
      </TableCell>

      <TableCell>
        <Skeleton className="h-3 w-20 bg-zinc-200" />
      </TableCell>

      <TableCell>
        <Skeleton className="ml-auto h-3 w-6 bg-zinc-200" />
      </TableCell>

      <TableCell>
        <Skeleton className="ml-auto h-3 w-6 bg-zinc-200" />
      </TableCell>

      <TableCell>
        <Skeleton className="ml-auto h-3 w-8 bg-zinc-200" />
      </TableCell>

      <TableCell>
        <Skeleton className="h-3 w-20 bg-zinc-200" />
      </TableCell>

      <TableCell>
        <Skeleton className="ml-auto h-7 w-16 rounded-lg bg-zinc-200" />
      </TableCell>
    </TableRow>
  );
}
