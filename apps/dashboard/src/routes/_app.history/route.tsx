import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search } from "lucide-react";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import StatCard from "@/components/stat-card";
import TablePagination from "@/components/table-pagination";
import Flex from "@/components/ui/flex";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ORDERS_PAGE_SIZE,
  ordersService,
} from "@/services/orders/orders-service";
import useDebouncedValue from "@/utils/utils.debounced-value";
import { serviceProviderLabels } from "@/services/sales/sales-labels";
import { serviceStockService } from "@/services/service-stock/service-stock-service";
import { formatUsd, formatVnd, shopDay } from "@/utils/utils.format";

import HistoryTable from "./history-table";
import ServiceSalesTable from "./service-sales-table";

type RangeFilter = "today" | "7d" | "30d";

// Telegram's orders and Hub William's tickets are sold for different money and are
// kept apart, so each has its own history.
type HistoryType = "telegram" | "hub-william";

const rangeDays: Record<RangeFilter, number> = { today: 1, "7d": 7, "30d": 30 };

const DAY_MS = 86_400_000;

// The last `count` shop days, today included.
function shopDays(count: number) {
  const now = Date.now();

  return {
    from: shopDay(new Date(now - (count - 1) * DAY_MS).toISOString()),
    to: shopDay(new Date(now).toISOString()),
  };
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : undefined;
}

export default function HistoryRoute() {
  const session = useDashboardSession();
  const [type, setType] = useState<HistoryType>("telegram");
  const [range, setRange] = useState<RangeFilter>("7d");
  const [seller, setSeller] = useState("all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const search = useDebouncedValue(query.trim());
  const hubWilliam = type === "hub-william";
  const sales = useQuery({
    // A role without the history permission is shown the refusal, not an error.
    enabled: session.can("history") && !hubWilliam,
    placeholderData: keepPreviousData,
    // The days are worked out when the request is made, so a page left open past
    // midnight asks for the new day, not the one it opened on.
    queryFn: () =>
      ordersService.sales({
        ...shopDays(rangeDays[range]),
        page,
        query: search,
        seller,
      }),
    queryKey: [...ordersService.salesQueryKey, { page, range, search, seller }],
  });

  // Hub William's tickets are few and come in one answer, so the filters are applied
  // here rather than asked of the server.
  const tickets = useQuery({
    enabled: session.can("history") && hubWilliam,
    queryFn: () => serviceStockService.sales(),
    queryKey: serviceStockService.salesKey,
  });
  const days = shopDays(rangeDays[range]);
  const needle = query.trim().toLowerCase();
  const soldInRange = (tickets.data ?? []).filter((sale) => {
    const day = shopDay(sale.sold_at);

    return day >= days.from && day <= days.to;
  });
  const ticketSellers = [
    ...new Set(
      soldInRange.flatMap((sale) => (sale.seller ? [sale.seller] : [])),
    ),
  ];
  const soldTickets = soldInRange.filter(
    (sale) =>
      (seller === "all" || sale.seller === seller) &&
      [
        sale.name,
        serviceProviderLabels[sale.provider],
        sale.buyer ?? "",
        sale.seller ?? "",
        sale.key_last_four ?? "",
      ].some((field) => field.toLowerCase().includes(needle)),
  );
  const ticketsTotal = soldTickets.reduce(
    (total, sale) => total + sale.price_micro,
    0,
  );

  // A page can end up beyond the last one when the sales shrink under it.
  const total = sales.data?.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / ORDERS_PAGE_SIZE));
  if (sales.data && !sales.isPlaceholderData && page > lastPage)
    setPage(lastPage);

  return (
    <PermissionGate permission="history">
      <PageBody>
        <PageHeader
          description="Telegram: mọi đơn đã thanh toán của bot, ai bán và bán lúc nào, tiền tính bằng đồng. Hub William: mọi gói đã bán, ai mua, ai bán, tiền tính bằng đô la. Hai loại tách riêng, không cộng chung."
          title="Lịch sử bán hàng"
        />

        <Flex className="flex-wrap items-center gap-2">
          <Select
            value={type}
            onValueChange={(next) => {
              setType(next as HistoryType);
              // The sellers of one are not the sellers of the other.
              setSeller("all");
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Loại hàng" className="w-36">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="telegram">Telegram</SelectItem>

              <SelectItem value="hub-william">Hub William</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={range}
            onValueChange={(next) => {
              setRange(next as RangeFilter);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Khoảng thời gian" className="w-36">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="today">Hôm nay</SelectItem>

              <SelectItem value="7d">7 ngày qua</SelectItem>

              <SelectItem value="30d">30 ngày qua</SelectItem>
            </SelectContent>
          </Select>

          <Select
            value={seller}
            onValueChange={(next) => {
              setSeller(next);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label="Lọc theo người bán" className="w-48">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="all">Mọi người bán</SelectItem>

              {!hubWilliam && (
                <SelectItem value="bot">SePay (tự động)</SelectItem>
              )}

              {(hubWilliam ? ticketSellers : (sales.data?.sellers ?? [])).map(
                (username) => (
                  <SelectItem key={username} value={username}>
                    {username}
                  </SelectItem>
                ),
              )}
            </SelectContent>
          </Select>
        </Flex>

        <div className="grid gap-3 sm:grid-cols-2">
          <StatCard
            label={hubWilliam ? "Số gói đã bán" : "Số đơn đã bán"}
            value={
              hubWilliam
                ? tickets.data
                  ? String(soldTickets.length)
                  : "—"
                : sales.data
                  ? String(sales.data.total)
                  : "—"
            }
          />

          <StatCard
            label="Doanh thu"
            value={
              hubWilliam
                ? tickets.data
                  ? formatUsd(ticketsTotal)
                  : "—"
                : sales.data
                  ? formatVnd(sales.data.total_vnd)
                  : "—"
            }
          />
        </div>

        <div className="space-y-3">
          <div className="relative">
            <Search
              aria-hidden={true}
              className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />

            <Input
              aria-label="Tìm đơn đã bán"
              className="h-10 w-full pl-9"
              placeholder={
                hubWilliam
                  ? "Tên gói, người mua, người bán..."
                  : "Mã đơn, username, tên hàng..."
              }
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
            />
          </div>

          {hubWilliam ? (
            <ServiceSalesTable
              error={messageOf(tickets.error) ?? null}
              sales={soldTickets}
              status={tickets.status}
              onRetry={() => void tickets.refetch()}
            />
          ) : (
            <>
              <HistoryTable
                error={messageOf(sales.error) ?? null}
                orders={sales.data?.orders ?? []}
                status={sales.status}
                onRetry={() => void sales.refetch()}
              />

              <TablePagination
                page={page}
                pageSize={ORDERS_PAGE_SIZE}
                total={total}
                unit="đơn"
                onPageChange={setPage}
              />
            </>
          )}
        </div>
      </PageBody>
    </PermissionGate>
  );
}
