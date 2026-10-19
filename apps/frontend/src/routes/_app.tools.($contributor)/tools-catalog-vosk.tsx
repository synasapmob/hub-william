import { useRef, useState, type ChangeEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  AlertCircle,
  AudioLines,
  Check,
  Copy,
  Download,
  FileAudio,
  Loader2,
  Mic,
  Square,
} from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Textarea } from "@/components/ui/textarea";
import voskService, {
  VOSK_MAX_RECORDING_SECONDS,
  type VoskModel,
  type VoskProgress,
} from "@/services/vosk";
import { copyText } from "@/utils/utils.clipboard";
import { downloadText } from "@/utils/utils.download";

import useToolsCatalogVoskRecorder from "./tools-catalog-vosk-recorder";

const voskStyles = tv({
  slots: {
    container: "space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4",
    row: "grid grid-cols-1 gap-3 sm:grid-cols-2",
    fieldGroup: "space-y-1.5",
    label:
      "block font-mono text-[11px] font-semibold tracking-wider text-zinc-600 uppercase",
    select:
      "h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-xs text-zinc-800 transition-colors focus:border-zinc-500 focus:outline-hidden",
    inputButtons: "grid grid-cols-2 gap-2",
    inputButton:
      "h-9 gap-1.5 bg-white px-2 font-mono text-[11px] font-semibold tracking-wider uppercase",
    hiddenInput: "sr-only",
    hint: "text-[11px] text-zinc-500",
    status: "space-y-2 text-xs text-zinc-600",
    resultCard:
      "space-y-3 rounded-lg border border-zinc-200 bg-white p-3 shadow-xs",
    action:
      "flex items-center gap-1.5 rounded-lg border border-zinc-200 bg-white px-2.5 py-1 text-xs font-medium text-zinc-700 shadow-xs transition-colors hover:bg-zinc-50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
    errorBanner:
      "flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800",
  },
});

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${minutes}:${seconds}`;
}

function statusLabel(progress: VoskProgress | null, model: VoskModel) {
  if (progress?.phase === "decoding") return "Decoding audio…";
  if (progress?.phase === "recognizing") {
    return `Transcribing… ${Math.round((progress.fraction ?? 0) * 100)}%`;
  }

  return `Loading the ${model.label} model (${model.size} download the first time).`;
}

function transcriptFilename(file: File) {
  return `${file.name.replace(/\.[^.]+$/, "") || "transcript"}.txt`;
}

export default function ToolsCatalogVosk() {
  const styles = voskStyles();
  const [modelId, setModelId] = useState(voskService.models[0].id);
  const [audio, setAudio] = useState<File | null>(null);
  const [progress, setProgress] = useState<VoskProgress | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const model =
    voskService.models.find((candidate) => candidate.id === modelId) ??
    voskService.models[0];

  const transcription = useMutation({
    mutationFn: (source: File) =>
      voskService.transcribe({ file: source, model, onProgress: setProgress }),
  });

  const recorder = useToolsCatalogVoskRecorder({
    onRecording: (file) => {
      setAudio(file);
      transcription.reset();
    },
  });
  const recording = recorder.status === "recording";

  const transcript = transcription.isPending
    ? (progress?.text ?? "")
    : (transcription.data ?? "");
  const hasResult = transcription.isPending
    ? transcript !== ""
    : transcription.isSuccess;

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    setAudio(file);
    transcription.reset();
    // Clearing the value lets the reader pick the same file again.
    event.target.value = "";
  }

  function handleTranscribe() {
    if (!audio) return;

    setProgress(null);
    setCopied(false);
    transcription.mutate(audio);
  }

  async function handleCopy() {
    setCopied(await copyText(transcript));
  }

  return (
    <div className={styles.container()}>
      <div className={styles.row()}>
        <div className={styles.fieldGroup()}>
          <label htmlFor="vosk-model" className={styles.label()}>
            Language
          </label>

          <select
            id="vosk-model"
            value={modelId}
            disabled={transcription.isPending || recording}
            onChange={(event) => setModelId(event.target.value)}
            className={styles.select()}
          >
            {voskService.models.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.label} ({candidate.size})
              </option>
            ))}
          </select>
        </div>

        <div className={styles.fieldGroup()}>
          <p className={styles.label()}>Input</p>

          <div className={styles.inputButtons()}>
            {recording ? (
              <Button
                type="button"
                variant="destructive"
                onClick={recorder.stop}
                className={styles.inputButton({ className: "bg-rose-50" })}
              >
                <Square aria-hidden="true" className="fill-current" />
                Stop voice
                <span className="tabular-nums">
                  {formatDuration(recorder.seconds)}
                </span>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={recorder.start}
                disabled={
                  transcription.isPending || recorder.status === "starting"
                }
                className={styles.inputButton()}
              >
                {recorder.status === "starting" ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Mic aria-hidden="true" />
                )}
                Start voice
              </Button>
            )}

            <Button
              type="button"
              variant="outline"
              onClick={() => fileInput.current?.click()}
              disabled={transcription.isPending || recorder.status !== "idle"}
              className={styles.inputButton()}
            >
              <FileAudio aria-hidden="true" />
              Import
            </Button>

            <input
              ref={fileInput}
              type="file"
              accept="audio/*"
              tabIndex={-1}
              aria-label="Audio file"
              onChange={handleFileChange}
              className={styles.hiddenInput()}
            />
          </div>
        </div>
      </div>

      {recording && (
        <p role="status" className={styles.hint()}>
          Recording. Speak now, then press Stop voice. It also stops after{" "}
          {VOSK_MAX_RECORDING_SECONDS / 60} minutes.
        </p>
      )}

      {!recording && audio && (
        <p role="status" className="text-[11px] text-emerald-600">
          Ready to transcribe: {audio.name}
        </p>
      )}

      {recorder.error && (
        <p role="alert" className="text-[11px] text-rose-700">
          {recorder.error}
        </p>
      )}

      <p className={styles.hint()}>
        Runs in your browser with Vosk. Your audio is never uploaded. Imported
        files up to 50 MB.
      </p>

      <Button
        type="button"
        onClick={handleTranscribe}
        disabled={transcription.isPending || recording || !audio}
        className="w-full gap-2"
      >
        {transcription.isPending ? (
          <>
            <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
            Transcribing…
          </>
        ) : (
          <>
            <AudioLines aria-hidden="true" className="size-3.5" />
            Transcribe
          </>
        )}
      </Button>

      {transcription.isPending && (
        <div role="status" className={styles.status()}>
          <p>{statusLabel(progress, model)}</p>

          {progress?.phase === "recognizing" && (
            <Progress value={(progress.fraction ?? 0) * 100} />
          )}
        </div>
      )}

      {transcription.isError && (
        <div role="alert" className={styles.errorBanner()}>
          <AlertCircle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-rose-600"
          />

          <p>{transcription.error.message}</p>
        </div>
      )}

      {hasResult && (
        <div className={styles.resultCard()}>
          <Flex className="justify-between text-xs">
            <span className="font-medium text-emerald-600">
              {transcription.isPending ? "Transcript so far" : "Transcript"}
            </span>

            {transcript && !transcription.isPending && audio && (
              <Flex className="gap-2">
                <button
                  type="button"
                  onClick={handleCopy}
                  className={styles.action()}
                >
                  {copied ? (
                    <Check aria-hidden="true" className="size-3.5" />
                  ) : (
                    <Copy aria-hidden="true" className="size-3.5" />
                  )}
                  {copied ? "Copied" : "Copy"}
                </button>

                <button
                  type="button"
                  onClick={() =>
                    downloadText(transcriptFilename(audio), transcript)
                  }
                  className={styles.action()}
                >
                  <Download aria-hidden="true" className="size-3.5" />
                  Download .txt
                </button>
              </Flex>
            )}
          </Flex>

          {transcript || transcription.isPending ? (
            <Textarea
              readOnly
              rows={5}
              value={transcript}
              aria-label="Transcript text"
              className="max-h-60 overflow-y-auto bg-white text-xs"
            />
          ) : (
            <p className="text-xs text-zinc-500">
              No speech was detected. Check that the language matches the audio.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
