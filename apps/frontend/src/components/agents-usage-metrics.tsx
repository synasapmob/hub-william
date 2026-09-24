import { Clock3 } from "lucide-react";

import Flex from "@/components/ui/flex";
import { Progress } from "@/components/ui/progress";
import type { AgentPoolUsageMetric } from "@/services/agent-pools";
import {
  agentPoolRemaining,
  agentPoolUsageValue,
} from "@/utils/utils.agent-pools";

interface AgentsUsageMetricsProps {
  provider: string;
  usage: AgentPoolUsageMetric[];
}

export default function AgentsUsageMetrics({
  provider,
  usage,
}: AgentsUsageMetricsProps) {
  return (
    <section aria-label="Account usage" className="space-y-3">
      <h4 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
        Usage & limits
      </h4>

      {usage.length ? (
        <dl className="space-y-4">
          {usage.map((metric) => {
            const remaining = agentPoolRemaining(metric);
            return (
              <div key={metric.label}>
                <Flex className="items-center justify-between gap-3 text-xs">
                  <dt className="text-zinc-600">{metric.label}</dt>
                  <dd className="text-right font-mono font-medium">
                    {agentPoolUsageValue(metric)}
                  </dd>
                </Flex>

                {remaining !== null ? (
                  <Progress
                    aria-label={`${metric.label} remaining`}
                    className="mt-2"
                    value={remaining}
                  />
                ) : null}

                {metric.detail && metric.value !== "Unavailable" ? (
                  <Flex className="mt-2 items-start gap-1.5 text-[10px]/relaxed text-zinc-500">
                    <Clock3
                      aria-hidden="true"
                      className="mt-0.5 size-3 shrink-0"
                    />
                    <p>{metric.detail}</p>
                  </Flex>
                ) : null}
              </div>
            );
          })}
        </dl>
      ) : (
        <p className="text-xs text-zinc-500">
          {provider} has not reported usage for this account yet.
        </p>
      )}
    </section>
  );
}
