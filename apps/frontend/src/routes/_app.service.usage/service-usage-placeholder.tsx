import { Skeleton } from "@/components/ui/skeleton";
import OrganizationMetricStrip from "@/routes/_app.organization/organization-metric-strip";
import OrganizationUsageChartSkeleton from "@/routes/_app.organization/organization-usage-chart-skeleton";

// The loaded page's metric strip and chart, with values still to come.
export default function ServiceUsagePlaceholder() {
  return (
    <>
      <p role="status" className="sr-only">
        Loading usage
      </p>

      <OrganizationMetricStrip
        columns={4}
        loading
        metrics={[
          { label: "Requests", value: "—" },
          { label: "Input tokens", value: "—" },
          { label: "Output tokens", value: "—" },
          { label: "Spent", value: "—" },
        ]}
      />

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xs">
        <div className="space-y-4 p-4 sm:p-5">
          <Skeleton className="h-4 w-28 bg-zinc-200" />

          <OrganizationUsageChartSkeleton />
        </div>
      </section>
    </>
  );
}
