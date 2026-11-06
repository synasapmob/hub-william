import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import type { ServiceSale } from "@/services/sales/sales-types";
import { formatDateTime, formatUsd } from "@/utils/utils.format";

interface ServiceSalesTableProps {
  /** The state of the request for the sales. */
  status: "pending" | "error" | "success";
  /** The message of the failed request, when it failed. */
  error: string | null;
  /** The tickets that were sold, newest first, after the filters. */
  sales: ServiceSale[];
  onRetry: () => void;
}

/** The tickets Hub William sold: when, which, to whom, by whom, and for how much. */
export default function ServiceSalesTable({
  error,
  onRetry,
  sales,
  status,
}: ServiceSalesTableProps) {
  if (status === "pending") {
    return (
      <div className="space-y-2 rounded-xl border bg-card p-4" role="status">
        <span className="sr-only">Đang tải lịch sử bán Hub William…</span>

        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-10 w-full" />
        ))}
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="space-y-3 rounded-xl border bg-card py-10 text-center">
        <p className="text-sm text-destructive" role="alert">
          {error ?? "Không tải được lịch sử bán Hub William."}
        </p>

        <Button variant="outline" onClick={onRetry}>
          Thử lại
        </Button>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Lúc bán</TableHead>

            <TableHead>Gói</TableHead>

            <TableHead>Người mua</TableHead>

            <TableHead>Người bán</TableHead>

            <TableHead>Key</TableHead>

            <TableHead className="text-right">Giá</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {sales.length === 0 && (
            <TableRow>
              <TableCell
                className="py-10 text-center text-muted-foreground"
                colSpan={6}
              >
                Không có gói nào được bán trong khoảng này.
              </TableCell>
            </TableRow>
          )}

          {sales.map((sale) => (
            <TableRow key={sale.id}>
              <TableCell className="text-muted-foreground tabular-nums">
                {formatDateTime(sale.sold_at)}
              </TableCell>

              <TableCell>
                <p>{sale.name}</p>

                <p className="text-xs text-muted-foreground">
                  {serviceProviderLabels[sale.provider]} · {sale.days} ngày
                </p>
              </TableCell>

              <TableCell>{sale.buyer ? `@${sale.buyer}` : "—"}</TableCell>

              <TableCell>{sale.seller ? `@${sale.seller}` : "—"}</TableCell>

              <TableCell className="font-mono text-xs">
                {sale.key_last_four ? `…${sale.key_last_four}` : "—"}
              </TableCell>

              <TableCell className="text-right font-medium tabular-nums">
                {formatUsd(sale.price_micro)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
