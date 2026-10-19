import { useEffect, useRef, useState } from "react";

import voskService, { type VoskRecording } from "@/services/vosk";

export type VoskRecorderStatus = "idle" | "starting" | "recording";

interface UseToolsCatalogVoskRecorderOptions {
  /** Called with the finished clip, or with null when a new recording begins. */
  onRecording: (file: File | null) => void;
}

/** Microphone recording state; the clip is handed over through `onRecording`. */
export default function useToolsCatalogVoskRecorder({
  onRecording,
}: UseToolsCatalogVoskRecorderOptions) {
  const [status, setStatus] = useState<VoskRecorderStatus>("idle");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const session = useRef<VoskRecording | null>(null);
  const mounted = useRef(false);

  // Closing the tool must never leave the microphone open.
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

  async function start() {
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

  function stop() {
    session.current?.stop();
  }

  return { status, seconds, error, start, stop };
}
