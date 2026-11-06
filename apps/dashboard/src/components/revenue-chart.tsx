import { useState } from "react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { stockTypeCurrency } from "@/services/sales/sales-labels";
import type { StockType } from "@/services/sales/sales-types";
import {
  formatCompactMoney,
  formatDay,
  formatMoney,
} from "@/utils/utils.format";

const column = tv({
  slots: {
    bar: "w-full max-w-6 transition-opacity group-hover:opacity-75 group-focus-visible:opacity-75",
    key: "h-0.5 w-3 rounded-full",
  },
  variants: {
    type: {
      telegram: { bar: "bg-chart-4", key: "bg-chart-4" },
      "hub-william": { bar: "bg-chart-1", key: "bg-chart-1" },
    },
  },
});

export interface RevenuePoint {
  /** `YYYY-MM-DD`, in shop time. */
  date: string;
  /** Takings of the day, in the currency of the chart's type. */
  total: number;
  orders: number;
}

interface RevenueChartProps {
  type: StockType;
  points: RevenuePoint[];
}

type ChartView = "chart" | "table";

// The axis top: a round number, so the half-way tick is round too.
function niceCeil(value: number) {
  if (value <= 0) return 1;

  const magnitude = 10 ** Math.floor(Math.log10(value));
  const fraction = value / magnitude;
  const nice = [1, 2, 4, 5, 10].find((step) => fraction <= step) ?? 10;

  return nice * magnitude;
}

function RevenueChartColumns({ points, type }: RevenueChartProps) {
  const [active, setActive] = useState<number | null>(null);

  const currency = stockTypeCurrency[type];
  const { bar, key } = column({ type });
  const top = niceCeil(Math.max(...points.map((point) => point.total)));
  // Label about seven days, always ending on the latest one.
  const labelEvery = Math.ceil(points.length / 7);
  const activePoint = active === null ? null : points[active];

  return (
    <Flex className="gap-2 pt-2">
      <div className="relative h-56 w-11 shrink-0 text-right text-[11px] text-muted-foreground tabular-nums">
        {[1, 0.5, 0].map((share) => (
          <span
            key={share}
            className="absolute right-0 -translate-y-1/2"
            style={{ top: `${(1 - share) * 100}%` }}
          >
            {formatCompactMoney(top * share, currency)}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div className="relative h-56" onPointerLeave={() => setActive(null)}>
          {[0, 50, 100].map((offset) => (
            <div
              key={offset}
              className="absolute inset-x-0 border-t border-border"
              style={{ top: `${offset}%` }}
            />
          ))}

          <Flex className="absolute inset-0">
            {points.map((point, index) => (
              <button
                key={point.date}
                aria-label={`${formatDay(point.date)}: ${formatMoney(point.total, currency)}, ${point.orders} đơn`}
                className="group relative flex h-full min-w-0 flex-1 items-end justify-center px-px outline-none"
                onBlur={() => setActive(null)}
                onFocus={() => setActive(index)}
                onPointerEnter={() => setActive(index)}
              >
                <span
                  className={bar()}
                  style={{
                    height: `${(point.total / top) * 100}%`,
                    // The chart mark's 4px data end, not a theme radius.
                    borderTopLeftRadius: 4,
                    borderTopRightRadius: 4,
                  }}
                />
              </button>
            ))}
          </Flex>

          {active !== null && activePoint && (
            <div
              className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded-lg border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md"
              style={{
                left: `${Math.min(88, Math.max(12, ((active + 0.5) / points.length) * 100))}%`,
                top: `${Math.max(24, (1 - activePoint.total / top) * 100)}%`,
              }}
            >
              <Flex className="items-center gap-1.5">
                <span className={key()} />

                <span className="text-sm font-semibold tabular-nums">
                  {formatMoney(activePoint.total, currency)}
                </span>
              </Flex>

              <p className="text-muted-foreground">
                {formatDay(activePoint.date)} · {activePoint.orders} đơn
              </p>
            </div>
          )}
        </div>

        <Flex className="mt-1.5">
          {points.map((point, index) => (
            <div key={point.date} className="relative h-4 min-w-0 flex-1">
              {(points.length - 1 - index) % labelEvery === 0 && (
                <span className="absolute left-1/2 -translate-x-1/2 text-[11px] whitespace-nowrap text-muted-foreground">
                  {formatDay(point.date)}
                </span>
              )}
            </div>
          ))}
        </Flex>
      </div>
    </Flex>
  );
}

function RevenueChartTable({ points, type }: RevenueChartProps) {
  const currency = stockTypeCurrency[type];

  return (
    <div className="max-h-64 overflow-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Ngày</TableHead>

            <TableHead className="text-right">Số đơn</TableHead>

            <TableHead className="text-right">Doanh thu</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {[...points].reverse().map((point) => (
            <TableRow key={point.date}>
              <TableCell>{formatDay(point.date)}</TableCell>

              <TableCell className="text-right tabular-nums">
                {point.orders}
              </TableCell>

              <TableCell className="text-right tabular-nums">
                {formatMoney(point.total, currency)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Daily takings as columns, with a table of the same numbers one tab away. */
export default function RevenueChart({ points, type }: RevenueChartProps) {
  const [view, setView] = useState<ChartView>("chart");

  const currency = stockTypeCurrency[type];
  const peak = points.reduce<RevenuePoint | null>(
    (best, point) => (!best || point.total > best.total ? point : best),
    null,
  );

  if (!peak) {
    return (
      <p className="py-10 text-center text-sm text-muted-foreground">
        Chưa có doanh thu trong khoảng này.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <Flex className="items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          Cao nhất {formatMoney(peak.total, currency)} · {formatDay(peak.date)}
        </p>

        <Tabs value={view} onValueChange={(next) => setView(next as ChartView)}>
          <TabsList>
            <TabsTrigger value="chart">Biểu đồ</TabsTrigger>

            <TabsTrigger value="table">Bảng</TabsTrigger>
          </TabsList>
        </Tabs>
      </Flex>

      {view === "chart" ? (
        <RevenueChartColumns points={points} type={type} />
      ) : (
        <RevenueChartTable points={points} type={type} />
      )}
    </div>
  );
}
