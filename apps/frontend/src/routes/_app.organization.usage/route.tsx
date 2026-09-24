import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import organizationsService from "@/services/organizations";
import { useOrganizationContext } from "@/routes/_app.organization/organization-context";
import {
  formatCount,
  formatTokenCount,
  providerLabel,
} from "@/routes/_app.organization/organization-format";
import OrganizationMetricStrip from "@/routes/_app.organization/organization-metric-strip";
import OrganizationUsageChart from "@/routes/_app.organization/organization-usage-chart";

export default function OrganizationUsageRoute() {
  const { organization } = useOrganizationContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const [days, setDays] = useState(30);
  const [connectionId, setConnectionId] = useState("");
  const [model, setModel] = useState("");
  const requestedMemberId = searchParams.get("member") ?? "";
  const membersQuery = useQuery({
    queryFn: () => organizationsService.members(organization.id),
    queryKey: [...organizationsService.queryKey, organization.id, "members"],
  });
  const agentsQuery = useQuery({
    queryFn: () => organizationsService.agents(organization.id),
    queryKey: [...organizationsService.queryKey, organization.id, "agents"],
  });
  const allUsageQuery = useQuery({
    queryFn: () => organizationsService.usage(organization.id, { days }),
    queryKey: [
      ...organizationsService.queryKey,
      organization.id,
      "usage",
      days,
    ],
  });
  const memberExists = (membersQuery.data ?? []).some(
    (member) => member.status === "accepted" && member.id === requestedMemberId,
  );
  const memberId =
    !membersQuery.data || membersQuery.error || memberExists
      ? requestedMemberId
      : "";
  const validConnectionId = (agentsQuery.data ?? []).some(
    (agent) => agent.id === connectionId,
  )
    ? connectionId
    : "";
  const modelOptions = Array.from(
    new Set(
      (allUsageQuery.data?.breakdown ?? [])
        .map((row) => row.model)
        .filter((value): value is string => Boolean(value)),
    ),
  ).sort();
  const validModel = modelOptions.includes(model) ? model : "";
  const usageQuery = useQuery({
    queryFn: () =>
      organizationsService.usage(organization.id, {
        days,
        memberId: memberId || undefined,
        connectionId: validConnectionId || undefined,
        model: validModel || undefined,
      }),
    queryKey: [
      ...organizationsService.queryKey,
      organization.id,
      "usage",
      days,
      memberId,
      validConnectionId,
      validModel,
    ],
  });
  const usage = usageQuery.data;
  const agentsById = new Map(
    (agentsQuery.data ?? []).map((agent) => [agent.id, agent]),
  );
  const filtered = Boolean(memberId || validConnectionId || validModel);

  useEffect(() => {
    if (
      requestedMemberId &&
      membersQuery.data &&
      !membersQuery.error &&
      !membersQuery.isFetching &&
      !memberId
    ) {
      const next = new URLSearchParams(searchParams);
      next.delete("member");
      setSearchParams(next, { replace: true });
    }
  }, [
    memberId,
    membersQuery.data,
    membersQuery.error,
    membersQuery.isFetching,
    requestedMemberId,
    searchParams,
    setSearchParams,
  ]);

  function changeMember(id: string) {
    const next = new URLSearchParams(searchParams);
    if (id) next.set("member", id);
    else next.delete("member");
    setSearchParams(next);
  }

  return (
    <div className="space-y-5">
      <header>
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          Usage
        </h1>
        <p className="mt-1 text-xs text-zinc-500">
          Requests made through {organization.name}, broken down by member,
          agent and model.
        </p>
      </header>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xs">
        <h2 className="mb-3 text-[11px] font-semibold tracking-wide text-zinc-500 uppercase">
          Filters
        </h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="min-w-0 space-y-1">
            <Label
              className="text-[11px] text-zinc-500"
              htmlFor="usage-time-range"
            >
              Time range
            </Label>
            <Select
              onValueChange={(value) => {
                setDays(Number(value));
                setModel("");
              }}
              value={String(days)}
            >
              <SelectTrigger
                className="h-9! w-full min-w-0 bg-white text-xs"
                id="usage-time-range"
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
          <div className="min-w-0 space-y-1">
            <Label className="text-[11px] text-zinc-500" htmlFor="usage-member">
              Member
            </Label>
            <Select
              onValueChange={(value) =>
                changeMember(value === "all" ? "" : value)
              }
              value={memberId || "all"}
            >
              <SelectTrigger
                className="h-9! w-full min-w-0 bg-white text-xs"
                id="usage-member"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All members</SelectItem>
                {memberId && !memberExists ? (
                  <SelectItem value={memberId}>
                    {membersQuery.error
                      ? "Member unavailable"
                      : "Loading member…"}
                  </SelectItem>
                ) : null}
                {(membersQuery.data ?? [])
                  .filter((member) => member.status === "accepted")
                  .map((member) => (
                    <SelectItem key={member.id} value={member.id}>
                      @{member.username}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label className="text-[11px] text-zinc-500" htmlFor="usage-agent">
              Agent
            </Label>
            <Select
              onValueChange={(value) =>
                setConnectionId(value === "all" ? "" : value)
              }
              value={validConnectionId || "all"}
            >
              <SelectTrigger
                className="h-9! w-full min-w-0 bg-white text-xs"
                id="usage-agent"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents</SelectItem>
                {(agentsQuery.data ?? []).map((agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    {providerLabel(agent.provider)} · @{agent.ownerUsername}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="min-w-0 space-y-1">
            <Label className="text-[11px] text-zinc-500" htmlFor="usage-model">
              Model
            </Label>
            <Select
              onValueChange={(value) =>
                setModel(value === "all" ? "" : value.slice(6))
              }
              value={validModel ? `model:${validModel}` : "all"}
            >
              <SelectTrigger
                className="h-9! w-full min-w-0 bg-white text-xs"
                id="usage-model"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All models</SelectItem>
                {modelOptions.map((option) => (
                  <SelectItem key={option} value={`model:${option}`}>
                    {option}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </section>

      {usageQuery.error ? (
        <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {usageQuery.error instanceof Error
            ? usageQuery.error.message
            : "Usage could not be loaded."}
        </p>
      ) : null}

      {membersQuery.error || agentsQuery.error || allUsageQuery.error ? (
        <div
          role="alert"
          className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <p>
            {(membersQuery.error ?? agentsQuery.error ?? allUsageQuery.error)
              ?.message ?? "Usage filters could not be loaded."}
          </p>
          <Button
            className="mt-3"
            onClick={() => {
              if (membersQuery.error) void membersQuery.refetch();
              if (agentsQuery.error) void agentsQuery.refetch();
              if (allUsageQuery.error) void allUsageQuery.refetch();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            Retry filters
          </Button>
        </div>
      ) : null}

      <OrganizationMetricStrip
        columns={3}
        footer={
          usage ? (
            <p>
              Token counts were reported for{" "}
              {formatCount(usage.tokenKnownRequests)} of{" "}
              {formatCount(usage.requests)} requests. Requests without provider
              usage remain in the request count.
            </p>
          ) : undefined
        }
        metrics={[
          {
            label: "Requests",
            value: usage ? formatCount(usage.requests) : "—",
          },
          {
            label: "Input tokens",
            value:
              usage && usage.tokenKnownRequests > 0
                ? formatTokenCount(usage.knownInputTokens)
                : "—",
          },
          {
            label: "Output tokens",
            value:
              usage && usage.tokenKnownRequests > 0
                ? formatTokenCount(usage.knownOutputTokens)
                : "—",
          },
        ]}
      />

      <section className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-xs">
        <div className="border-b border-zinc-100 p-4 sm:p-5">
          <h2 className="font-heading text-sm font-semibold">Daily usage</h2>
          <p className="mt-1 mb-4 text-xs text-zinc-500">
            {filtered
              ? "Requests matching your filters."
              : "All organization requests."}
          </p>
          {usageQuery.isPending ? (
            <p className="py-10 text-center text-xs text-zinc-500">
              Loading usage…
            </p>
          ) : (
            <OrganizationUsageChart days={usage?.dailyUsage ?? []} />
          )}
        </div>

        <div className="p-4 sm:p-5">
          <h2 className="font-heading text-sm font-semibold">
            By member and model
          </h2>
          {usage?.breakdown.length ? (
            <>
              <ul className="mt-3 space-y-2 md:hidden">
                {usage.breakdown.map((row) => (
                  <li
                    key={`${row.memberId}:${row.connectionId}:${row.model}`}
                    className="rounded-lg border border-zinc-200 bg-zinc-50/40 p-3"
                  >
                    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-xs font-semibold text-zinc-800">
                          @{row.username}
                        </p>
                        <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                          {providerLabel(row.provider)}
                          {row.connectionId && agentsById.has(row.connectionId)
                            ? ` · @${agentsById.get(row.connectionId)?.ownerUsername}`
                            : ""}
                        </p>
                      </div>

                      <div className="text-right">
                        <p className="font-heading text-lg leading-none font-semibold">
                          {formatCount(row.requests)}
                        </p>
                        <p className="mt-1 text-[10px] text-zinc-500">
                          requests
                        </p>
                      </div>
                    </div>

                    <p className="mt-2 truncate rounded-md bg-white px-2 py-1 font-mono text-[11px] text-zinc-700">
                      {row.model ?? "Unknown model"}
                    </p>

                    <dl className="mt-2 grid grid-cols-2 border-t border-zinc-200 pt-2 text-xs">
                      <div>
                        <dt className="text-[10px] text-zinc-500">
                          Input tokens
                        </dt>
                        <dd className="mt-0.5 font-mono font-medium">
                          {row.tokenKnownRequests > 0
                            ? formatTokenCount(row.knownInputTokens)
                            : "—"}
                        </dd>
                      </div>
                      <div className="border-l border-zinc-200 pl-3">
                        <dt className="text-[10px] text-zinc-500">
                          Output tokens
                        </dt>
                        <dd className="mt-0.5 font-mono font-medium">
                          {row.tokenKnownRequests > 0
                            ? formatTokenCount(row.knownOutputTokens)
                            : "—"}
                        </dd>
                      </div>
                    </dl>
                  </li>
                ))}
              </ul>

              <div className="hidden md:block">
                <Table className="mt-3" containerProps={{ tabIndex: 0 }}>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="text-[11px]">Member</TableHead>
                      <TableHead className="text-[11px]">Agent</TableHead>
                      <TableHead className="text-[11px]">Model</TableHead>
                      <TableHead className="text-right text-[11px]">
                        Requests
                      </TableHead>
                      <TableHead className="text-right text-[11px]">
                        Input
                      </TableHead>
                      <TableHead className="text-right text-[11px]">
                        Output
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {usage.breakdown.map((row) => (
                      <TableRow
                        key={`${row.memberId}:${row.connectionId}:${row.model}`}
                      >
                        <TableCell className="py-2.5 text-xs">
                          @{row.username}
                        </TableCell>
                        <TableCell className="py-2.5 text-xs">
                          {providerLabel(row.provider)}
                          {row.connectionId && agentsById.has(row.connectionId)
                            ? ` · @${agentsById.get(row.connectionId)?.ownerUsername}`
                            : ""}
                        </TableCell>
                        <TableCell className="py-2.5 font-mono text-xs">
                          {row.model ?? "Unknown"}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-xs">
                          {formatCount(row.requests)}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-xs">
                          {row.tokenKnownRequests > 0
                            ? formatTokenCount(row.knownInputTokens)
                            : "—"}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-xs">
                          {row.tokenKnownRequests > 0
                            ? formatTokenCount(row.knownOutputTokens)
                            : "—"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          ) : (
            <p className="mt-3 text-xs text-zinc-500">
              No requests match this period and these filters.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
