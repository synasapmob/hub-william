import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle, Play } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AgentProviderId } from "@/services/agent/agent-types";
import { TEST_MESSAGE } from "@/services/service-key-test/service-key-test-request";
import { serviceKeyTestService } from "@/services/service-key-test/service-key-test-service";

interface ServiceKeysTestProps {
  origin: string;
  provider: AgentProviderId;
  model: string;
  // The key to try; empty until one is made or pasted.
  apiKey: string;
  // Whether the platform has an account for this agent now.
  available: boolean;
  // Called when a request ends, whatever came back: one that was served was
  // charged, even if it brought no text.
  onTested: () => void;
}

// One real request with the key, sent from this page, and what came back.
export default function ServiceKeysTest({
  apiKey,
  available,
  model,
  onTested,
  origin,
  provider,
}: ServiceKeysTestProps) {
  const [text, setText] = useState("");
  const controller = useRef<AbortController | null>(null);
  const run = useMutation({
    mutationFn: () => {
      controller.current = new AbortController();

      return serviceKeyTestService.run({
        key: apiKey,
        message: TEST_MESSAGE,
        model,
        onDelta: (delta) => setText((current) => current + delta),
        origin,
        provider,
        signal: controller.current.signal,
      });
    },
    onMutate: () => setText(""),
    onSettled: onTested,
  });

  // Leaving the page ends a request that is still being answered.
  useEffect(() => () => controller.current?.abort(), []);

  return (
    <div className="space-y-3">
      <Button
        disabled={run.isPending || !available || !apiKey}
        onClick={() => run.mutate()}
        type="button"
      >
        {run.isPending ? (
          <LoaderCircle aria-hidden="true" className="animate-spin" />
        ) : (
          <Play aria-hidden="true" />
        )}
        {run.isPending ? "Running…" : "Run test"}
      </Button>

      {run.error && (
        <Alert variant="destructive">
          <AlertDescription>{run.error.message}</AlertDescription>
        </Alert>
      )}

      {(run.isPending || run.isSuccess) && (
        <div className="space-y-1.5">
          {run.data && (
            <p className="text-[11px] text-zinc-500">
              HTTP {run.data.status} · {(run.data.durationMs / 1000).toFixed(1)}{" "}
              s
            </p>
          )}

          <p
            aria-live="polite"
            className="min-h-10 rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-xs/relaxed whitespace-pre-wrap text-zinc-800"
          >
            {text || (run.isPending ? "Waiting for the answer…" : "")}
          </p>
        </div>
      )}
    </div>
  );
}
