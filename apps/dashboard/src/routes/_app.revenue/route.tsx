import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { useDashboardSession } from "@/components/dashboard-shell/dashboard-session-context";
import PageBody from "@/components/page-body";
import PageHeader from "@/components/page-header";
import PermissionGate from "@/components/permission-gate";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  revenueService,
  type RevenueDays,
} from "@/services/revenue/revenue-service";

import RevenueSection from "./revenue-section";
import { SellersTable, TopItemsTable } from "./revenue-tables";

export default function RevenueRoute() {
  const session = useDashboardSession();
  const [days, setDays] = useState<RevenueDays>(7);

  const revenue = useQuery({
    // A role without the revenue permission is shown the refusal, not an error.
    enabled: session.can("revenue"),
    // The previous period stays up while the next one loads.
    placeholderData: keepPreviousData,
    queryFn: () => revenueService.get(days),
    queryKey: [...revenueService.queryKey, days],
  });

  return (
    <PermissionGate permission="revenue">
      <PageBody>
        <PageHeader
          description="Doanh thu của bot Telegram, tính bằng đồng. So với cùng độ dài kỳ liền trước."
          title="Doanh thu"
        >
          <Select
            value={String(days)}
            onValueChange={(next) => setDays(Number(next) as RevenueDays)}
          >
            <SelectTrigger aria-label="Kỳ báo cáo" className="w-40">
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="7">7 ngày qua</SelectItem>

              <SelectItem value="14">14 ngày qua</SelectItem>

              <SelectItem value="30">30 ngày qua</SelectItem>
            </SelectContent>
          </Select>
        </PageHeader>

        {revenue.status === "pending" && (
          <div className="space-y-3" role="status">
            <span className="sr-only">Đang tải doanh thu…</span>

            <Skeleton className="h-80 w-full rounded-xl" />

            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        )}

        {revenue.status === "error" && (
          <div className="space-y-3 py-10 text-center">
            <p className="text-sm text-destructive" role="alert">
              {revenue.error.message}
            </p>

            <Button variant="outline" onClick={() => void revenue.refetch()}>
              Thử lại
            </Button>
          </div>
        )}

        {revenue.data && (
          <>
            <RevenueSection
              days={revenue.data.days}
              points={revenue.data.daily}
              type="telegram"
            />

            <div className="grid gap-5 xl:grid-cols-2">
              <TopItemsTable items={revenue.data.top_items} />

              <SellersTable sellers={revenue.data.by_seller} />
            </div>
          </>
        )}
      </PageBody>
    </PermissionGate>
  );
}
