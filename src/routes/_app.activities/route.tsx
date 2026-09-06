import { useState } from "react";

import activitiesService, {
  type ActivityMetricFilter,
} from "@/utils/utils.activities";

import ActivitiesHeatmap from "./activities-heatmap";
import ActivitiesSummary from "./activities-summary";
import ActivitiesTimeline from "./activities-timeline";

export default function ActivitiesRoute() {
  const [metricFilter, setMetricFilter] = useState<ActivityMetricFilter>("All");

  return (
    <section
      aria-labelledby="activities-title"
      className="mx-auto w-full max-w-6xl px-6 pt-10 pb-20"
    >
      <h2 id="activities-title" className="sr-only">
        Agent activity telemetry
      </h2>

      <div className="space-y-6">
        <ActivitiesHeatmap
          filter={metricFilter}
          onFilterChange={setMetricFilter}
        />

        <div>
          <h3 className="mb-2.5 text-left font-mono text-xs font-semibold tracking-wider text-muted-foreground uppercase">
            Fleet usage snapshot
          </h3>

          <ActivitiesSummary stats={activitiesService.summaryStats} />
        </div>

        <ActivitiesTimeline entries={activitiesService.timelineEntries} />
      </div>
    </section>
  );
}
