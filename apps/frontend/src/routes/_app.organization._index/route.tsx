import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";
import { tv } from "tailwind-variants";

import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import organizationsService from "@/services/organizations";
import { useOrganizationContext } from "@/routes/_app.organization/organization-context";
import {
  availabilityLabel,
  formatCount,
  formatTokenCount,
  providerLabel,
} from "@/routes/_app.organization/organization-format";
import OrganizationMetricStrip from "@/routes/_app.organization/organization-metric-strip";
import OrganizationUsageChart from "@/routes/_app.organization/organization-usage-chart";

const agentStatusDot = tv({
  base: "size-1.5 rounded-full",
  variants: {
    active: {
      true: "bg-emerald-500",
      false: "bg-zinc-400",
    },
  },
});

export default function OrganizationOverviewRoute() {
  const { organization } = useOrganizationContext();
  const [days, setDays] = useState(30);
  const overviewQuery = useQuery({
    queryFn: () => organizationsService.overview(organization.id, days),
    queryKey: [
      ...organizationsService.queryKey,
      organization.id,
      "overview",
      days,
    ],
  });
  const overview = overviewQuery.data;
  const knownTokens = overview
    ? overview.knownInputTokens + overview.knownOutputTokens
    : 0;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl font-semibold tracking-tight">
            Overview
          </h1>
          <p className="mt-1 text-xs text-zinc-500">
            {organization.description ||
              `A quick view of activity across ${organization.name}.`}
          </p>
        </div>
        <Select
          onValueChange={(value) => setDays(Number(value))}
          value={String(days)}
        >
          <SelectTrigger
            aria-label="Time range"
            className="h-9! min-w-32 bg-white text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="7">Last 7 days</SelectItem>
            <SelectItem value="30">Last 30 days</SelectItem>
            <SelectItem value="90">Last 90 days</SelectItem>
          </SelectContent>
        </Select>
      </header>

      {overviewQuery.error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {overviewQuery.error instanceof Error
            ? overviewQuery.error.message
            : "Overview could not be loaded."}
        </p>
      ) : null}

      <OrganizationMetricStrip
        columns={4}
        metrics={[
          {
            label: "Agents",
            note: "Shared with the team",
            value: overview ? formatCount(overview.agentCount) : "—",
          },
          {
            label: "Members",
            note: "People with access",
            value: overview ? formatCount(overview.memberCount) : "—",
          },
          {
            label: "Requests",
            note: `In the last ${days} days`,
            value: overview ? formatCount(overview.requests) : "—",
          },
          {
            label: "Tokens",
            note: overview
              ? `Reported by ${formatCount(overview.tokenKnownRequests)} of ${formatCount(overview.requests)} requests`
              : "Provider reported totals",
            value:
              overview && overview.tokenKnownRequests > 0
                ? formatTokenCount(knownTokens)
                : "—",
          },
        ]}
      />

      <div className="grid items-stretch gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.9fr)]">
        <section className="min-w-0 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
          <div className="mb-5">
            <h2 className="font-heading text-sm font-semibold text-zinc-900">
              Daily usage
            </h2>
            <p className="mt-1 text-xs text-zinc-500">
              Requests made through this organization.
            </p>
          </div>

          {overviewQuery.isPending ? (
            <Center className="min-h-32">
              <p className="text-xs text-zinc-500">Loading usage…</p>
            </Center>
          ) : (
            <OrganizationUsageChart days={overview?.dailyUsage ?? []} />
          )}
        </section>

        <section className="min-w-0 rounded-xl border border-zinc-200 bg-white p-4 shadow-xs sm:p-5">
          <Flex className="flex-wrap items-center justify-between gap-3">
            <h2 className="font-heading text-sm font-semibold text-zinc-900">
              Team agents
            </h2>
            <Link
              className="inline-flex items-center gap-1 text-xs font-medium text-indigo-600 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden"
              to="/organization/agents"
            >
              View Agents <ArrowRight aria-hidden="true" className="size-3.5" />
            </Link>
          </Flex>

          {overview?.agents.length ? (
            <ul className="mt-3 divide-y divide-zinc-100">
              {overview.agents.map((agent) => (
                <li key={agent.id} className="flex items-center gap-3 py-2.5">
                  <Center className="size-8 shrink-0 rounded-lg border border-zinc-200 bg-zinc-50 font-mono text-xs font-semibold text-zinc-600">
                    {providerLabel(agent.provider).slice(0, 1)}
                  </Center>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-semibold text-zinc-800">
                      {providerLabel(agent.provider)}
                    </p>
                    <p className="truncate text-[11px] text-zinc-500">
                      Added by @{agent.ownerUsername}
                    </p>
                  </div>

                  <p className="inline-flex shrink-0 items-center gap-1.5 text-[11px] text-zinc-500">
                    <span
                      aria-hidden="true"
                      className={agentStatusDot({
                        active: agent.availabilityStatus === "active",
                      })}
                    />
                    {availabilityLabel(agent.availabilityStatus)}
                  </p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-4 rounded-lg border border-dashed border-zinc-200 bg-zinc-50/50 p-4 text-xs text-zinc-500">
              No agents shared with this organization yet.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
