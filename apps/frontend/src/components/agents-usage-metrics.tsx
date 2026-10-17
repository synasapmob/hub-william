import { useState } from "react";
import { Clock3, LoaderCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import Flex from "@/components/ui/flex";
import { Progress } from "@/components/ui/progress";
import type { AgentPoolUsageMetric } from "@/services/agent-pools";
import {
  agentPoolRemaining,
  agentPoolResetCreditCount,
  agentPoolUsageValue,
} from "@/utils/utils.agent-pools";

interface AgentsUsageMetricsProps {
  onResetCredits?: () => Promise<void>;
  provider: string;
  usage: AgentPoolUsageMetric[];
}

export default function AgentsUsageMetrics({
  onResetCredits,
  provider,
  usage,
}: AgentsUsageMetricsProps) {
  const [resetting, setResetting] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);

  async function resetCredits() {
    if (!onResetCredits) return;
    setResetting(true);
    setResetError(null);

    try {
      await onResetCredits();
    } catch (error) {
      setResetError(
        error instanceof Error
          ? error.message
          : "The reset credit could not be used.",
      );
    } finally {
      setResetting(false);
    }
  }

  return (
    <section aria-label="Account usage" className="space-y-3">
      <h4 className="text-[10px] font-semibold tracking-widest text-zinc-400 uppercase">
        Usage & limits
      </h4>

      {usage.length ? (
        <dl className="space-y-4">
          {usage.map((metric) => {
            const remaining = agentPoolRemaining(metric);
            const resetCreditCount = agentPoolResetCreditCount(metric);
            const showsReset =
              metric.label === "Reset credits" && onResetCredits !== undefined;

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

                {showsReset ? (
                  <Flex className="mt-2 items-center justify-between gap-3">
                    {metric.detail ? (
                      <Flex className="items-start gap-1.5 text-[10px] text-zinc-500">
                        <Clock3
                          aria-hidden="true"
                          className="mt-0.5 size-3 shrink-0"
                        />
                        <p>{metric.detail}</p>
                      </Flex>
                    ) : (
                      <span />
                    )}

                    <Button
                      disabled={resetting || !resetCreditCount}
                      onClick={() => void resetCredits()}
                      size="xs"
                      type="button"
                      variant="outline"
                    >
                      {resetting ? (
                        <LoaderCircle
                          aria-hidden="true"
                          className="animate-spin"
                        />
                      ) : null}
                      {resetting ? "Resetting…" : "Reset"}
                    </Button>
                  </Flex>
                ) : metric.detail && metric.value !== "Unavailable" ? (
                  <Flex className="mt-2 items-start gap-1.5 text-[10px]/relaxed text-zinc-500">
                    <Clock3
                      aria-hidden="true"
                      className="mt-0.5 size-3 shrink-0"
                    />
                    <p>{metric.detail}</p>
                  </Flex>
                ) : null}

                {showsReset && resetError ? (
                  <p className="mt-1 text-[10px] text-destructive" role="alert">
                    {resetError}
                  </p>
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
