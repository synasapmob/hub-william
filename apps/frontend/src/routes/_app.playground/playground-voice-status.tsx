import { LoaderCircle } from "lucide-react";

import type { PlaygroundVoiceStatus as VoiceStatus } from "@/services/playground/playground-voice";
import { VOICE_ACTIVITY_THRESHOLD } from "@/services/playground/playground-voice-audio";

interface PlaygroundVoiceStatusProps {
  status: VoiceStatus;
  phase: "listening" | "transcribing" | "thinking" | "speaking" | null;
  loading: string | null;
  muted: boolean;
  playbackBlocked: boolean;
  inputLevels: number[];
  inputActive: boolean;
  outputLevel: number;
}

const statusLabels: Record<VoiceStatus, string> = {
  idle: "Ready to talk",
  connecting: "Connecting…",
  connected: "Ready to talk",
  ending: "Ending call…",
  ended: "Call ended",
  failed: "Call disconnected",
};

export default function PlaygroundVoiceStatus({
  status,
  phase,
  loading,
  muted,
  playbackBlocked,
  inputLevels,
  inputActive,
  outputLevel,
}: PlaygroundVoiceStatusProps) {
  const audible = (inputLevels.at(-1) ?? 0) >= VOICE_ACTIVITY_THRESHOLD;
  const speaking = status === "connected" && !muted && (inputActive || audible);
  const pending = status === "connecting" || status === "ending";
  let label =
    status === "connecting" && loading ? loading : statusLabels[status];
  if (status === "connected") {
    if (speaking) label = "Speaking";
    else if (playbackBlocked) label = "Enable BOT audio";
    else if (phase === "speaking" || outputLevel >= 0.005) label = "Listening";
    else if (phase === "transcribing") label = "Finishing transcript…";
    else if (phase === "thinking") label = "Waiting for BOT…";
    else if (muted) label = "Microphone off";
  }

  return (
    <p
      role="status"
      className="flex items-center gap-2 text-xs text-muted-foreground"
    >
      {pending ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-3 animate-spin motion-reduce:animate-none"
        />
      ) : null}
      {speaking ? (
        <span
          aria-hidden="true"
          className="inline-flex h-4 items-center gap-0.5"
        >
          {inputLevels.map((level, index) => (
            <span
              key={index}
              className="w-0.5 rounded-full bg-current transition-[height] duration-100 motion-reduce:transition-none"
              style={{
                height: `${audible ? Math.max(12, Math.min(100, level * 800)) : 12}%`,
              }}
            />
          ))}
        </span>
      ) : null}
      {label}
    </p>
  );
}
