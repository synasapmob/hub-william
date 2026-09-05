import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { tv } from "tailwind-variants";

import PageHeader from "@/components/page-header";
import { Button } from "@/components/ui/button";
import activitiesService, {
  type ActivityMetricFilter,
} from "@/services/activities";

import ActivityHeatmap from "./activity-heatmap";
import ActivitySummary from "./activity-summary";
import ActivityTimeline from "./activity-timeline";

/** The refresh icon, spun while the fixture reload is in flight. */
const refreshIcon = tv({ variants: { spinning: { true: "animate-spin" } } });

export default function ActivitiesRoute() {
  const [metricFilter, setMetricFilter] = useState<ActivityMetricFilter>("All");
  const [refreshing, setRefreshing] = useState(false);

  // Telemetry is fixture data, so there is nothing to re-fetch yet. The control
  // stays because the page it belongs to will have one, and the spin is how a
  // reader learns it was heard.
  function handleRefresh() {
    setRefreshing(true);
    setTimeout(() => setRefreshing(false), 600);
  }

  return (
    <section
      aria-labelledby="activities-title"
      className="mx-auto w-full max-w-6xl px-6 pt-10 pb-20"
    >
      <PageHeader
        eyebrow="Observability & metrics"
        title="Agent activities"
        description="See how your agents work over time."
        actions={
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Refresh telemetry"
            onClick={handleRefresh}
          >
            <RefreshCw
              aria-hidden="true"
              className={refreshIcon({ spinning: refreshing })}
            />
          </Button>
        }
      />

      <h2 id="activities-title" className="sr-only">
        Agent activity telemetry
      </h2>

      <div className="mt-6 space-y-6">
        <ActivityHeatmap
          filter={metricFilter}
          onFilterChange={setMetricFilter}
        />

        <div>
          <h3 className="mb-2.5 text-left font-mono text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Fleet usage snapshot
          </h3>

          <ActivitySummary stats={activitiesService.summaryStats} />
        </div>

        <ActivityTimeline entries={activitiesService.timelineEntries} />
      </div>
    </section>
  );
}
