import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, Mic, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import voskService, {
  VOSK_MAX_RECORDING_SECONDS,
  type VoskRecording,
} from "@/services/vosk";

type MicrophoneStatus = "idle" | "starting" | "recording";

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

interface ToolsCatalogVoskMicrophoneProps {
  /** The last finished recording, owned by the parent so it survives tab changes. */
  recording: File | null;
  disabled: boolean;
  onRecording: (file: File | null) => void;
}

/** Record the microphone and hand the finished clip to the parent. */
export default function ToolsCatalogVoskMicrophone({
  recording,
  disabled,
  onRecording,
}: ToolsCatalogVoskMicrophoneProps) {
  const [status, setStatus] = useState<MicrophoneStatus>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<VoskRecording | null>(null);
  const mounted = useRef(false);

  // Leaving the tab must never leave the microphone open.
  useEffect(() => {
    mounted.current = true;

    return () => {
      mounted.current = false;
      const active = session.current;
      session.current = null;
      active?.cancel();
    };
  }, []);

  useEffect(() => {
    if (status !== "recording") return;

    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);

    return () => clearInterval(timer);
  }, [status]);

  async function handleStart() {
    setError(null);
    setSeconds(0);
    setStatus("starting");
    onRecording(null);

    try {
      const started = await voskService.record();
      if (!mounted.current) {
        started.cancel();
        return;
      }

      session.current = started;
      setStatus("recording");
      started.result.then(
        (file) => {
          if (session.current !== started) return;

          session.current = null;
          setStatus("idle");
          onRecording(file);
        },
        (failure: Error) => {
          if (session.current !== started) return;

          session.current = null;
          setStatus("idle");
          setError(failure.message);
        },
      );
    } catch (failure) {
      if (!mounted.current) return;

      setStatus("idle");
      setError(
        failure instanceof Error ? failure.message : "Recording failed.",
      );
    }
  }

  function handleStop() {
    session.current?.stop();
  }

  return (
    <div className="space-y-2">
      {status === "recording" ? (
        <Button
          type="button"
          variant="destructive"
          onClick={handleStop}
          className="w-full gap-2"
        >
          <Square aria-hidden="true" className="size-3.5 fill-current" />
          Stop recording
          <span className="font-mono tabular-nums">
            {formatDuration(seconds)}
          </span>
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          onClick={handleStart}
          disabled={disabled || status === "starting"}
          className="w-full gap-2 bg-white"
        >
          {status === "starting" ? (
            <>
              <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              Waiting for the microphone…
            </>
          ) : (
            <>
              <Mic aria-hidden="true" className="size-3.5" />
              {recording ? "Record again" : "Start recording"}
            </>
          )}
        </Button>
      )}

      {status === "recording" && (
        <p role="status" className="text-[11px] text-zinc-500">
          Recording. Speak now, then press Stop. It also stops after{" "}
          {VOSK_MAX_RECORDING_SECONDS / 60} minutes.
        </p>
      )}

      {status === "idle" && recording && (
        <p role="status" className="text-[11px] text-emerald-600">
          Recording ready. Press Transcribe to convert it.
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="flex items-start gap-1.5 text-[11px] text-rose-700"
        >
          <AlertCircle aria-hidden="true" className="mt-px size-3.5 shrink-0" />
          {error}
        </p>
      )}
    </div>
  );
}
