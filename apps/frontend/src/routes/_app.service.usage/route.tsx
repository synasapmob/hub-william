import { useState, type PropsWithChildren } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import {
  formatCount,
  formatTokenCount,
} from "@/routes/_app.organization/organization-format";
import OrganizationMetricStrip from "@/routes/_app.organization/organization-metric-strip";
import OrganizationUsageChart from "@/routes/_app.organization/organization-usage-chart";
import { serviceUsageService } from "@/services/service-usage/service-usage-service";
import { formatDollars } from "@/utils/utils.money";

import ServiceUsageBreakdown from "./service-usage-breakdown";
import ServiceUsagePlaceholder from "./service-usage-placeholder";

function UsageFrame({ children }: PropsWithChildren) {
  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Usage
        </h1>

        <p className="mt-1 text-xs text-zinc-500">
          What your service keys used and what it cost, by key and model.
        </p>
      </header>

      {children}
    </div>
  );
}

export default function ServiceUsageRoute() {
  const session = useWorkspaceSession();
  const [days, setDays] = useState(30);
  const usageQuery = useQuery({
    enabled: Boolean(session.user),
    // Changing the range keeps the last figures on screen until the new ones land.
    placeholderData: keepPreviousData,
    queryFn: () => serviceUsageService.usage({ days }),
    queryKey: [
      ...serviceUsageService.queryKey,
      session.user?.id ?? "guest",
      days,
    ],
  });
  const usage = usageQuery.data;

  // Usage is of a signed-in user; a guest is left with Pricing alone.
  if (session.status === "guest") {
    return <Navigate replace to="/service/pricing" />;
  }

  if (usageQuery.error) {
    return (
      <UsageFrame>
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>{usageQuery.error.message}</p>

          <Button
            className="mt-3"
            onClick={() => void usageQuery.refetch()}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      </UsageFrame>
    );
  }

  // The session is still being checked, or the first figures are on their way.
  if (!usage) {
    return (
      <UsageFrame>
        <ServiceUsagePlaceholder />
      </UsageFrame>
    );
  }

  return (
    <UsageFrame>
      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
        <div className="max-w-xs min-w-0 space-y-1">
          <Label className="text-[11px] text-zinc-500" htmlFor="usage-range">
            Time range
          </Label>

          <Select
            onValueChange={(value) => setDays(Number(value))}
            value={String(days)}
          >
            <SelectTrigger
              className="h-9! w-full min-w-0 bg-white text-xs"
              id="usage-range"
            >
              <SelectValue />
            </SelectTrigger>

            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <OrganizationMetricStrip
        columns={4}
        footer={
          <p>
            Token counts were reported for{" "}
            {formatCount(usage.tokenKnownRequests)} of{" "}
            {formatCount(usage.requests)} requests. Requests without provider
            usage remain in the request count.
            {usage.requests > usage.completedRequests &&
              ` ${formatCount(usage.requests - usage.completedRequests)} did not finish, because the connection closed or the provider stopped; the usage seen before they stopped is included.`}
          </p>
        }
        metrics={[
          { label: "Requests", value: formatCount(usage.requests) },
          {
            label: "Input tokens",
            value:
              usage.tokenKnownRequests > 0
                ? formatTokenCount(usage.knownInputTokens)
                : "—",
          },
          {
            label: "Output tokens",
            value:
              usage.tokenKnownRequests > 0
                ? formatTokenCount(usage.knownOutputTokens)
                : "—",
          },
          { label: "Spent", value: formatDollars(usage.spentMicro) },
        ]}
      />

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xs">
        <div className="border-b border-zinc-100 p-4 sm:p-5">
          <h2 className="font-heading text-sm font-semibold">Daily usage</h2>

          <p className="mt-1 mb-4 text-xs text-zinc-500">
            Everything you sent with your service keys.
          </p>

          <OrganizationUsageChart days={usage.dailyUsage} />
        </div>

        <div className="p-4 sm:p-5">
          <h2 className="font-heading text-sm font-semibold">
            By key and model
          </h2>

          <ServiceUsageBreakdown rows={usage.breakdown} />
        </div>
      </section>
    </UsageFrame>
  );
}
