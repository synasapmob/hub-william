import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  Camera,
  CameraOff,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Volume2,
} from "lucide-react";
import { tv } from "tailwind-variants";

import { Button } from "@/components/ui/button";
import Center from "@/components/ui/center";
import Flex from "@/components/ui/flex";
import type { PlaygroundProviderId } from "@/services/playground";
import playgroundWhisperTurnService from "@/services/playground/playground-whisper-turn";
import playgroundVoiceService, {
  type PlaygroundVoiceCall,
  type PlaygroundVoiceAudioSources,
  type PlaygroundVoiceStatus as VoiceStatus,
} from "@/services/playground/playground-voice";
import type { PlaygroundVoiceTranscript } from "@/services/playground/playground-voice-events";
import playgroundMedia from "@/utils/utils.playground-media";
import PlaygroundVoiceStatus from "./playground-voice-status";
import PlaygroundVoiceRecordings from "./playground-voice-recordings";
import { PlaygroundZoomButton } from "./playground-conversation";

import type { CatalogueCallProfile } from "@/services/provider-catalogue.generated";

interface PlaygroundVoiceProps {
  connectionId?: string;
  organizationId?: string;
  provider: PlaygroundProviderId;
  model?: string;
  callProfile?: CatalogueCallProfile;
  mode: "call-live" | "call-whisper";
  disabled: boolean;
  zoomed: boolean;
  onToggleZoom: () => void;
  onActiveChange: (active: boolean) => void;
}

interface PlaygroundVoiceState {
  status: VoiceStatus;
  phase: "listening" | "transcribing" | "thinking" | "speaking" | null;
  loading: string | null;
  muted: boolean;
  camera: MediaStream | null;
  remoteAudio: MediaStream | null;
  audioSources: PlaygroundVoiceAudioSources | null;
  error: string | null;
  cameraError: string | null;
  playbackBlocked: boolean;
  transcripts: PlaygroundVoiceTranscript[];
  inputLevels: number[];
  inputActive: boolean;
  outputLevel: number;
}

const transcriptEntry = tv({
  base: "space-y-1",
  variants: {
    user: { true: "rounded-lg bg-zinc-50 p-3" },
  },
});

export default function PlaygroundVoice({
  connectionId,
  organizationId,
  provider,
  model,
  callProfile,
  mode,
  disabled,
  zoomed,
  onToggleZoom,
  onActiveChange,
}: PlaygroundVoiceProps) {
  const [preferences, setPreferences] = useState(playgroundMedia.read);
  const [state, setState] = useState<PlaygroundVoiceState>({
    status: "idle",
    phase: null,
    loading: null,
    muted: !preferences.voice,
    camera: null,
    remoteAudio: null,
    audioSources: null,
    error: null,
    cameraError: null,
    playbackBlocked: false,
    transcripts: [],
    inputLevels: Array<number>(7).fill(0),
    inputActive: false,
    outputLevel: 0,
  });
  const [cameraPending, setCameraPending] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const call = useRef<PlaygroundVoiceCall | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const camera = useRef<HTMLVideoElement>(null);
  const recordingStop = useRef<(() => void) | null>(null);
  const transcriptViewport = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const active =
    state.status === "connecting" ||
    state.status === "connected" ||
    state.status === "ending";
  const connected = state.status === "connected";
  const voiceEnabled = preferences.voice;
  const cameraEnabled = preferences.camera;
  const controlsPending = active && !connected;

  function savePreferences(next: typeof preferences) {
    setPreferences(next);
    playgroundMedia.write(next);
  }

  useEffect(() => {
    onActiveChange(active);
    return () => onActiveChange(false);
  }, [active, onActiveChange]);
  useEffect(
    () => () => {
      const request = controller.current;
      controller.current = null;
      request?.abort();
      call.current?.end();
    },
    [],
  );
  useEffect(() => {
    if (camera.current) camera.current.srcObject = state.camera;
  }, [state.camera]);
  useEffect(() => {
    const node = audio.current;
    if (!node) return;
    node.srcObject = state.remoteAudio;
    if (state.remoteAudio)
      void node
        .play()
        .catch(() =>
          setState((current) => ({ ...current, playbackBlocked: true })),
        );
    return () => {
      node.pause();
      node.srcObject = null;
    };
  }, [state.remoteAudio]);
  useEffect(() => {
    const viewport = transcriptViewport.current;
    if (viewport && followTranscript.current)
      viewport.scrollTop = viewport.scrollHeight;
  }, [state.transcripts]);

  const mutation = useMutation({
    mutationFn: playgroundVoiceService.start,
    retry: false,
  });

  const turnMutation = useMutation({
    mutationFn: playgroundWhisperTurnService.turn,
    retry: false,
    gcTime: 0,
  });

  async function start() {
    if (disabled || !connectionId || !model || mutation.isPending || active)
      return;
    const request = new AbortController();
    controller.current = request;
    call.current = null;
    followTranscript.current = true;
    setState({
      status: "connecting",
      phase: null,
      loading: null,
      muted: !preferences.voice,
      camera: null,
      remoteAudio: null,
      audioSources: null,
      error: null,
      cameraError: null,
      playbackBlocked: false,
      transcripts: [],
      inputLevels: Array<number>(7).fill(0),
      inputActive: false,
      outputLevel: 0,
    });
    function update(patch: Partial<PlaygroundVoiceState>) {
      if (controller.current === request)
        setState((current) => ({ ...current, ...patch }));
    }
    try {
      const started = await mutation.mutateAsync({
        connectionId,
        organizationId,
        provider,
        model,
        callProfile,
        mode,
        signal: request.signal,
        voiceEnabled: preferences.voice,
        cameraEnabled: preferences.camera,
        onStatus: (status) =>
          update({
            status,
            ...(status === "ended" || status === "failed"
              ? { remoteAudio: null }
              : {}),
          }),
        onTranscripts: (transcripts) => update({ transcripts }),
        onBeforeEnd: () => recordingStop.current?.(),
        onAudioSources: (audioSources) => update({ audioSources }),
        onRemoteAudio: (remoteAudio) => update({ remoteAudio }),
        onCamera: (stream) => update({ camera: stream }),
        onCameraError: (cameraError) => update({ cameraError }),
        onError: (error) => update({ error }),
        onPhase: (phase) => update({ phase }),
        onInputActive: (inputActive) => update({ inputActive }),
        onInputLevel: (level) => {
          if (controller.current === request)
            setState((current) => ({
              ...current,
              inputLevels: [...current.inputLevels.slice(-6), level],
            }));
        },
        onOutputLevel: (outputLevel) => update({ outputLevel }),
        sendTurn: turnMutation.mutateAsync,
        onLoading: (loading) => update({ loading }),
      });
      if (request.signal.aborted || controller.current !== request)
        started.end();
      else call.current = started;
    } catch (error) {
      if (!request.signal.aborted)
        update({
          status: "failed",
          error:
            error instanceof Error
              ? error.message
              : "The call could not start.",
        });
    }
  }

  function end() {
    controller.current?.abort();
    call.current?.end();
    call.current = null;
  }

  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border bg-white">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4">
        <h2 className="text-sm font-semibold">Your conversation</h2>

        <Flex className="flex-wrap gap-2">
          {active ? (
            <Button
              type="button"
              variant="destructive"
              className="min-h-10"
              disabled={state.status === "ending"}
              onClick={end}
            >
              <PhoneOff aria-hidden="true" className="size-4" />
              End call
            </Button>
          ) : (
            <Button
              type="button"
              className="min-h-10"
              disabled={
                disabled || !connectionId || !model || mutation.isPending
              }
              onClick={() => void start()}
            >
              <Phone aria-hidden="true" className="size-4" />
              Start call
            </Button>
          )}

          <PlaygroundZoomButton zoomed={zoomed} onToggle={onToggleZoom} />
        </Flex>
      </header>

      <div className="space-y-4 p-4 sm:p-5">
        <Flex className="flex-col items-stretch gap-4 md:flex-row">
          <section className="min-w-0 flex-1 space-y-3">
            <Flex className="flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Your Camera</h3>

              <PlaygroundVoiceStatus
                status={state.status}
                phase={state.phase}
                loading={state.loading}
                muted={state.muted}
                playbackBlocked={state.playbackBlocked}
                inputLevels={state.inputLevels}
                inputActive={state.inputActive}
                outputLevel={state.outputLevel}
              />
            </Flex>

            <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-zinc-50">
              <video
                ref={camera}
                autoPlay
                muted
                playsInline
                className="size-full -scale-x-100 object-cover"
                hidden={!state.camera}
                aria-label="Your camera preview"
              />

              {!state.camera ? (
                <Center className="h-full">
                  <div className="space-y-3 text-center">
                    <CameraOff
                      aria-hidden="true"
                      className="mx-auto size-8 text-zinc-400"
                    />

                    <p className="text-xs text-muted-foreground">
                      Camera is off
                    </p>
                  </div>
                </Center>
              ) : null}
            </div>

            <Flex className="flex-wrap gap-2">
              <Button
                type="button"
                variant={voiceEnabled ? "secondary" : "outline"}
                aria-pressed={voiceEnabled}
                disabled={controlsPending}
                onClick={() => {
                  savePreferences({ ...preferences, voice: !voiceEnabled });
                  call.current?.mute(!state.muted);
                  setState((current) => ({
                    ...current,
                    muted: !current.muted,
                  }));
                }}
              >
                {voiceEnabled ? (
                  <Mic aria-hidden="true" className="size-4" />
                ) : (
                  <MicOff aria-hidden="true" className="size-4" />
                )}
                Voice
              </Button>

              <Button
                type="button"
                variant={cameraEnabled ? "secondary" : "outline"}
                aria-pressed={cameraEnabled}
                disabled={controlsPending || cameraPending}
                onClick={async () => {
                  const enabled = !cameraEnabled;
                  savePreferences({ ...preferences, camera: enabled });
                  if (!connected) return;
                  setCameraPending(true);
                  try {
                    await call.current?.camera(enabled);
                  } finally {
                    setCameraPending(false);
                  }
                }}
              >
                {cameraEnabled ? (
                  <Camera aria-hidden="true" className="size-4" />
                ) : (
                  <CameraOff aria-hidden="true" className="size-4" />
                )}
                Camera
              </Button>

              <PlaygroundVoiceRecordings
                connected={connected}
                camera={camera}
                sources={state.audioSources}
                transcripts={state.transcripts}
                model={model}
                stopRef={recordingStop}
              />
            </Flex>

            {state.cameraError ? (
              <p className="text-sm text-muted-foreground">
                {state.cameraError}
              </p>
            ) : null}
          </section>

          <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-border">
            <header className="shrink-0 border-b border-border px-4 py-3">
              <h3 className="text-sm font-semibold">Transcript</h3>
            </header>

            <div className="relative h-72 md:h-auto md:min-h-60 md:flex-1">
              <div
                ref={transcriptViewport}
                role="log"
                aria-label="Call transcript"
                className="absolute inset-0 space-y-4 overflow-y-auto p-4"
                onScroll={() => {
                  const node = transcriptViewport.current;
                  if (node)
                    followTranscript.current =
                      node.scrollHeight - node.scrollTop - node.clientHeight <
                      80;
                }}
              >
                {state.transcripts.length ? (
                  state.transcripts.map((entry) => (
                    <article
                      key={entry.id}
                      className={transcriptEntry({
                        user: entry.role === "user",
                      })}
                    >
                      <h4 className="text-xs font-medium text-muted-foreground">
                        {entry.role === "user" ? "You" : "BOT"}
                        {entry.role === "user" && !entry.complete
                          ? " · Transcribing…"
                          : null}
                      </h4>

                      <p className="text-sm/relaxed whitespace-pre-wrap wrap-anywhere">
                        {entry.text}
                      </p>
                    </article>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    What you and BOT say will appear here during the call.
                  </p>
                )}
              </div>
            </div>
          </section>
        </Flex>

        <audio ref={audio} autoPlay />

        {state.playbackBlocked && active ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              void audio.current
                ?.play()
                .then(() =>
                  setState((current) => ({
                    ...current,
                    playbackBlocked: false,
                  })),
                )
                .catch(() => undefined);
            }}
          >
            <Volume2 aria-hidden="true" className="size-4" />
            Play BOT audio
          </Button>
        ) : null}

        {state.error ? (
          <p role="alert" className="text-sm text-destructive">
            {state.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
