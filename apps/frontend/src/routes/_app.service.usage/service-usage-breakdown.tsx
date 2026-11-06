import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatCount,
  formatTokenCount,
  providerLabel,
} from "@/routes/_app.organization/organization-format";
import type { ServiceUsageRow } from "@/services/service-usage/service-usage-types";
import { formatDollars } from "@/utils/utils.money";

// Requests without a key come from a key that was deleted since.
function keyLabel(row: ServiceUsageRow) {
  return row.keyLastFour ? `Key …${row.keyLastFour}` : "Removed key";
}

// A request that reported no usage counts as a request, not as zero tokens.
function knownTokens(row: ServiceUsageRow, value: number) {
  return row.tokenKnownRequests > 0 ? formatTokenCount(value) : "—";
}

function rowKey(row: ServiceUsageRow) {
  return `${row.gatewayKeyId ?? "none"}:${row.provider}:${row.model ?? ""}`;
}

interface ServiceUsageBreakdownProps {
  rows: ServiceUsageRow[];
}

export default function ServiceUsageBreakdown({
  rows,
}: ServiceUsageBreakdownProps) {
  if (rows.length === 0) {
    return (
      <p className="mt-3 text-xs text-zinc-500">No requests in this period.</p>
    );
  }

  return (
    <>
      <ul className="mt-3 space-y-2 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-3"
          >
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold text-zinc-800">
                  {keyLabel(row)}
                </p>

                <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                  {providerLabel(row.provider)}
                </p>
              </div>

              <div className="text-right">
                <p className="font-heading text-lg leading-none font-semibold">
                  {formatCount(row.requests)}
                </p>

                <p className="mt-1 text-[10px] text-zinc-500">requests</p>
              </div>
            </div>

            <p className="mt-2 truncate rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-700">
              {row.model ?? "Unknown model"}
            </p>

            <dl className="mt-2 grid grid-cols-3 border-t border-zinc-200 pt-2 text-xs">
              <div>
                <dt className="text-[10px] text-zinc-500">Input tokens</dt>

                <dd className="mt-0.5 font-mono font-medium">
                  {knownTokens(row, row.knownInputTokens)}
                </dd>
              </div>

              <div className="border-l border-zinc-200 pl-3">
                <dt className="text-[10px] text-zinc-500">Output tokens</dt>

                <dd className="mt-0.5 font-mono font-medium">
                  {knownTokens(row, row.knownOutputTokens)}
                </dd>
              </div>

              <div className="border-l border-zinc-200 pl-3">
                <dt className="text-[10px] text-zinc-500">Spent</dt>

                <dd className="mt-0.5 font-mono font-medium">
                  {formatDollars(row.spentMicro)}
                </dd>
              </div>
            </dl>
          </li>
        ))}
      </ul>

      <div className="hidden md:block">
        <Table className="mt-3" containerProps={{ tabIndex: 0 }}>
          <TableHeader>
            <TableRow>
              <TableHead className="text-[11px]">Key</TableHead>
              <TableHead className="text-[11px]">Agent</TableHead>
              <TableHead className="text-[11px]">Model</TableHead>
              <TableHead className="text-right text-[11px]">Requests</TableHead>
              <TableHead className="text-right text-[11px]">Input</TableHead>
              <TableHead className="text-right text-[11px]">Output</TableHead>
              <TableHead className="text-right text-[11px]">Spent</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                <TableCell className="py-2.5 text-xs">
                  {keyLabel(row)}
                </TableCell>
                <TableCell className="py-2.5 text-xs">
                  {providerLabel(row.provider)}
                </TableCell>
                <TableCell className="py-2.5 font-mono text-xs">
                  {row.model ?? "Unknown"}
                </TableCell>
                <TableCell className="py-2.5 text-right text-xs">
                  {formatCount(row.requests)}
                </TableCell>
                <TableCell className="py-2.5 text-right text-xs">
                  {knownTokens(row, row.knownInputTokens)}
                </TableCell>
                <TableCell className="py-2.5 text-right text-xs">
                  {knownTokens(row, row.knownOutputTokens)}
                </TableCell>
                <TableCell className="py-2.5 text-right text-xs">
                  {formatDollars(row.spentMicro)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
