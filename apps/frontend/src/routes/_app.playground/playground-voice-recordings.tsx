import { useEffect, useRef, useState, type RefObject } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, Circle, Download, Square, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { tv } from "tailwind-variants";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import Flex from "@/components/ui/flex";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import FocusReturnDialogContent from "@/components/focus-return-dialog-content";
import { useWorkspaceSession } from "@/components/workspace-shell/workspace-shell-session-context";
import type { PlaygroundVoiceAudioSources } from "@/services/playground/playground-voice";
import type { PlaygroundVoiceTranscript } from "@/services/playground/playground-voice-events";
import playgroundRecorderService, {
  type PlaygroundRecorderSession,
} from "@/services/playground/playground-recorder";
import playgroundRecordingsService, {
  type PlaygroundRecording,
  type PlaygroundRecordingFile,
} from "@/services/playground/playground-recordings";

interface PlaygroundVoiceRecordingsProps {
  connected: boolean;
  camera: RefObject<HTMLVideoElement | null>;
  sources: PlaygroundVoiceAudioSources | null;
  transcripts: PlaygroundVoiceTranscript[];
  model?: string;
  stopRef: RefObject<(() => void) | null>;
}
interface PlaygroundVoiceRecordingsState {
  status: "idle" | "starting" | "recording" | "saving";
  error: string | null;
  unsaved: PlaygroundRecordingFile | null;
}
const recordingDescription = tv({
  variants: { loaded: { true: "sr-only" } },
});

function label(recording: PlaygroundRecording) {
  return `${new Date(recording.createdAt).toLocaleString()} · ${Math.max(1, Math.round(recording.duration / 1000))}s`;
}

export default function PlaygroundVoiceRecordings({
  connected,
  camera,
  sources,
  transcripts,
  model,
  stopRef,
}: PlaygroundVoiceRecordingsProps) {
  const ownerId = useWorkspaceSession().user?.id;
  const queryClient = useQueryClient();
  const [state, setState] = useState<PlaygroundVoiceRecordingsState>({
    status: "idle",
    error: null,
    unsaved: null,
  });
  const [selected, setSelected] = useState<string | null>(null);
  const recorder = useRef<PlaygroundRecorderSession | null>(null);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const menu = useRef<HTMLButtonElement>(null);
  const queryKey = [
    ...playgroundRecordingsService.queryKey,
    ownerId ?? "guest",
  ];
  const supported = typeof MediaRecorder !== "undefined";
  const recordings = useQuery({
    queryKey,
    queryFn: () => playgroundRecordingsService.list(ownerId!),
    enabled: Boolean(ownerId) && typeof indexedDB !== "undefined",
    retry: false,
  });
  const file = useQuery({
    queryKey: [...queryKey, selected],
    queryFn: () => playgroundRecordingsService.load(ownerId!, selected!),
    enabled: Boolean(ownerId && selected && selected !== state.unsaved?.id),
    retry: false,
    gcTime: 0,
  });
  const current = selected === state.unsaved?.id ? state.unsaved : file.data;
  const rows = [
    ...(state.unsaved ? [state.unsaved] : []),
    ...(recordings.data ?? []),
  ];

  useEffect(() => {
    mounted.current = true;
    function stop() {
      recorder.current?.stop();
      request.current?.abort();
    }
    stopRef.current = stop;
    return () => {
      mounted.current = false;
      stop();
      stopRef.current = null;
    };
  }, [stopRef]);
  useEffect(() => {
    if (!connected) stopRef.current?.();
  }, [connected, stopRef]);
  useEffect(() => {
    if (sources) recorder.current?.sources(sources);
  }, [sources]);
  useEffect(() => {
    recorder.current?.transcripts(transcripts);
  }, [transcripts]);
  useEffect(() => {
    if (state.status === "idle" && !state.unsaved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [state.status, state.unsaved]);

  async function start() {
    if (
      !ownerId ||
      !sources ||
      !camera.current ||
      !connected ||
      request.current ||
      state.unsaved
    )
      return;
    const pending = new AbortController();
    request.current = pending;
    setState({ status: "starting", error: null, unsaved: null });
    try {
      const active = await playgroundRecorderService.start({
        ownerId,
        model: model ?? "",
        camera: camera.current,
        sources,
        transcripts,
        signal: pending.signal,
      });
      recorder.current = active;
      if (mounted.current)
        setState((value) => ({ ...value, status: "recording" }));
      const recorded = await active.result;
      recorder.current = null;
      if (mounted.current)
        setState((value) => ({ ...value, status: "saving" }));
      try {
        await playgroundRecordingsService.save(recorded);
        void queryClient.invalidateQueries({ queryKey });
        if (mounted.current) {
          setState({ status: "idle", error: null, unsaved: null });
          toast.success(
            recorded.stoppedAtLimit
              ? "Recording saved at the 128 MB limit. Start another recording to continue."
              : "Recording saved on this device.",
          );
        }
      } catch {
        if (mounted.current) {
          setState({
            status: "idle",
            error:
              "Could not save on this device. Download this recording before leaving.",
            unsaved: recorded,
          });
          setSelected(recorded.id);
        }
      }
    } catch (error) {
      if (mounted.current)
        setState((value) => ({
          ...value,
          status: "idle",
          error: pending.signal.aborted
            ? null
            : error instanceof Error
              ? error.message
              : "Recording failed.",
        }));
    } finally {
      request.current = null;
      recorder.current = null;
    }
  }

  return (
    <>
      <Button
        type="button"
        variant={state.status === "recording" ? "destructive" : "outline"}
        disabled={
          state.status === "starting" ||
          state.status === "saving" ||
          (state.status === "idle" &&
            (!connected || !sources || !supported || Boolean(state.unsaved)))
        }
        onClick={() => {
          if (state.status === "recording") stopRef.current?.();
          else void start();
        }}
      >
        {state.status === "recording" ? (
          <Square aria-hidden="true" className="size-4" />
        ) : (
          <Circle aria-hidden="true" className="size-4" />
        )}
        {state.status === "recording"
          ? "Stop record"
          : state.status === "saving"
            ? "Saving…"
            : state.status === "starting"
              ? "Starting…"
              : "Record"}
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button ref={menu} type="button" variant="outline">
            Recordings ({rows.length})
            <ChevronDown aria-hidden="true" className="size-4" />
          </Button>
        </DropdownMenuTrigger>

        <DropdownMenuContent
          align="end"
          className="max-h-72 w-72 max-w-[calc(100vw-2rem)]"
        >
          {rows.map((recording) => (
            <DropdownMenuItem
              key={recording.id}
              onSelect={() => setSelected(recording.id)}
            >
              {label(recording)}
            </DropdownMenuItem>
          ))}
          {!rows.length ? (
            <DropdownMenuItem disabled>
              {recordings.isFetching
                ? "Loading recordings…"
                : "No recordings yet"}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
      >
        <FocusReturnDialogContent
          className="sm:max-w-2xl"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            menu.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              Call recording
              {current
                ? ` ${new Date(current.createdAt).toLocaleString()}`
                : ""}
            </DialogTitle>

            <DialogDescription
              className={recordingDescription({ loaded: Boolean(current) })}
            >
              {current
                ? "Play or download your recorded conversation."
                : "Loading recording…"}
            </DialogDescription>
          </DialogHeader>

          {current ? (
            <PlaygroundVoiceRecordingsPlayback
              key={current.id}
              recording={current}
              saved={current.id !== state.unsaved?.id}
              onDelete={async () => {
                if (current.id === state.unsaved?.id)
                  setState({ status: "idle", error: null, unsaved: null });
                else
                  await playgroundRecordingsService.remove(
                    ownerId!,
                    current.id,
                  );
                await queryClient.invalidateQueries({ queryKey });
                setSelected(null);
              }}
            />
          ) : null}

          {file.isError && !current ? (
            <p role="alert" className="text-sm text-destructive">
              Could not open this recording.
            </p>
          ) : null}
        </FocusReturnDialogContent>
      </Dialog>

      {state.error || recordings.isError || !supported ? (
        <p
          role={state.error || recordings.isError ? "alert" : undefined}
          className="basis-full text-sm text-destructive"
        >
          {state.error ??
            (recordings.isError
              ? "Could not load recordings from this browser."
              : "Recording is unavailable in this browser.")}
        </p>
      ) : null}
    </>
  );
}

interface PlaygroundVoiceRecordingsPlaybackProps {
  recording: PlaygroundRecordingFile;
  saved: boolean;
  onDelete: () => Promise<void>;
}
function PlaygroundVoiceRecordingsPlayback({
  recording,
  saved,
  onDelete,
}: PlaygroundVoiceRecordingsPlaybackProps) {
  const video = useRef<HTMLVideoElement>(null);
  const download = useRef<HTMLAnchorElement>(null);
  const transcriptDownload = useRef<HTMLAnchorElement>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(recording.blob);
    if (video.current) video.current.src = next;
    if (download.current) download.current.href = next;
    return () => URL.revokeObjectURL(next);
  }, [recording.blob]);
  useEffect(() => {
    const text = recording.transcripts
      .map((entry) => `${entry.role === "user" ? "YOU" : "BOT"}\n${entry.text}`)
      .join("\n\n");
    const next = URL.createObjectURL(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
    );
    if (transcriptDownload.current) transcriptDownload.current.href = next;
    return () => URL.revokeObjectURL(next);
  }, [recording.transcripts]);
  return (
    <div className="space-y-4">
      <video
        ref={video}
        controls
        playsInline
        className="aspect-video w-full rounded-lg bg-zinc-900"
        aria-label="Recorded call"
      />

      <section className="space-y-3">
        <Flex className="flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">Transcript</h3>

          <Badge variant="secondary">
            {Math.max(1, Math.round(recording.duration / 1000))}s
          </Badge>

          {recording.model ? (
            <Badge variant="outline">{recording.model}</Badge>
          ) : null}
        </Flex>

        {(["user", "assistant"] as const).map((role) => (
          <article
            key={role}
            className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 rounded-lg bg-zinc-50 p-3"
          >
            <h4 className="pt-0.5 text-xs font-medium text-muted-foreground">
              {role === "user" ? "YOU" : "BOT"}
            </h4>

            <p className="text-sm/relaxed whitespace-pre-wrap wrap-anywhere">
              {recording.transcripts.findLast((entry) => entry.role === role)
                ?.text || "—"}
            </p>
          </article>
        ))}
      </section>

      <p className="text-xs text-muted-foreground">
        {saved
          ? "Saved in this browser only. Download to keep a copy."
          : "Not saved. Download this recording before leaving this page."}
      </p>

      <Flex className="flex-wrap items-center justify-between gap-3">
        <Flex className="flex-wrap items-center gap-2">
          <Button asChild variant="outline">
            <a
              ref={download}
              download={`hub-call-${recording.createdAt}.${recording.mimeType.includes("mp4") ? "mp4" : "webm"}`}
            >
              <Download aria-hidden="true" className="size-4" />
              Download Video
            </a>
          </Button>

          <Button asChild variant="outline">
            <a
              ref={transcriptDownload}
              download={`hub-call-${recording.createdAt}.txt`}
            >
              <Download aria-hidden="true" className="size-4" />
              Download Transcript
            </a>
          </Button>
        </Flex>

        <Button
          type="button"
          variant="ghost"
          className="ml-auto"
          disabled={deleting}
          onClick={async () => {
            setDeleting(true);
            try {
              await onDelete();
            } catch {
              setError("Could not delete this recording.");
              setDeleting(false);
            }
          }}
        >
          <Trash2 aria-hidden="true" className="size-4" />
          Delete Record
        </Button>
      </Flex>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
