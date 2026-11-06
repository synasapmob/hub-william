import Panel from "@/components/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { Revenue } from "@/services/revenue/revenue-service";
import { formatVnd } from "@/utils/utils.format";

const NO_SALES = "Chưa bán được đơn nào trong kỳ này.";

/** The best sellers of the period, by how many orders they came to. */
export function TopItemsTable({ items }: { items: Revenue["top_items"] }) {
  return (
    <Panel className="space-y-3" padded={false}>
      <h2 className="px-4 pt-4 text-sm font-semibold">
        Bán chạy nhất (theo số đơn)
      </h2>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Hàng</TableHead>

            <TableHead className="text-right">Số đơn</TableHead>

            <TableHead className="text-right">Doanh thu</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {items.length === 0 && (
            <TableRow>
              <TableCell
                className="py-8 text-center text-muted-foreground"
                colSpan={3}
              >
                {NO_SALES}
              </TableCell>
            </TableRow>
          )}

          {items.map((item) => (
            <TableRow key={item.title}>
              <TableCell className="font-medium">{item.title}</TableCell>

              <TableCell className="text-right tabular-nums">
                {item.orders}
              </TableCell>

              <TableCell className="text-right tabular-nums">
                {formatVnd(item.total_vnd)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

/** What each seller took in the period; SePay is what no one settled by hand. */
export function SellersTable({ sellers }: { sellers: Revenue["by_seller"] }) {
  return (
    <Panel className="space-y-3" padded={false}>
      <h2 className="px-4 pt-4 text-sm font-semibold">Theo người bán</h2>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Người bán</TableHead>

            <TableHead className="text-right">Doanh thu</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {sellers.length === 0 && (
            <TableRow>
              <TableCell
                className="py-8 text-center text-muted-foreground"
                colSpan={2}
              >
                {NO_SALES}
              </TableCell>
            </TableRow>
          )}

          {sellers.map((row) => (
            <TableRow key={row.seller ?? "sepay"}>
              <TableCell className="font-medium">
                {row.seller ?? "SePay (tự động)"}
              </TableCell>

              <TableCell className="text-right tabular-nums">
                <p>{formatVnd(row.total_vnd)}</p>

                <p className="text-xs text-muted-foreground">
                  {row.orders} đơn
                </p>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}
