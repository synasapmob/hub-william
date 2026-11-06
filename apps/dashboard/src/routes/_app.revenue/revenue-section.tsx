import Panel from "@/components/panel";
import RevenueChart, { type RevenuePoint } from "@/components/revenue-chart";
import StatCard from "@/components/stat-card";
import StockTypeBadge from "@/components/stock-type-badge";
import Flex from "@/components/ui/flex";
import { stockTypeCurrency } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";
import { formatMoney } from "@/utils/utils.format";

interface RevenueSectionProps {
  type: StockType;
  /** Every day on record, oldest first. */
  points: RevenuePoint[];
  /** Length of the period shown; the same length before it is the comparison. */
  days: number;
}

function sum(points: RevenuePoint[], field: "orders" | "total") {
  return points.reduce((total, point) => total + point[field], 0);
}

// Percent change, or nothing to compare against.
function change(now: number, before: number) {
  return before === 0 ? undefined : ((now - before) / before) * 100;
}

/** One side of the business: its takings, against the period before, by day. */
export default function RevenueSection({
  days,
  points,
  type,
}: RevenueSectionProps) {
  const currency = stockTypeCurrency[type];
  const current = points.slice(-days);
  const previous = points.slice(-2 * days, -days);
  const total = sum(current, "total");
  const orders = sum(current, "orders");

  return (
    <Panel className="space-y-4">
      <Flex className="items-center justify-between gap-2">
        <StockTypeBadge type={type} />

        <span className="text-xs text-muted-foreground">
          Tính bằng {currency === "VND" ? "đồng (VND)" : "đô la (USD)"}
        </span>
      </Flex>

      <div className="grid gap-3 sm:grid-cols-3">
        <StatCard
          change={change(total, sum(previous, "total"))}
          label="Doanh thu"
          value={formatMoney(total, currency)}
        />

        <StatCard
          change={change(orders, sum(previous, "orders"))}
          label="Số đơn"
          value={String(orders)}
        />

        <StatCard
          label="Trung bình mỗi đơn"
          value={formatMoney(
            orders === 0 ? 0 : Math.round(total / orders),
            currency,
          )}
        />
      </div>

      <RevenueChart points={current} type={type} />
    </Panel>
  );
}
