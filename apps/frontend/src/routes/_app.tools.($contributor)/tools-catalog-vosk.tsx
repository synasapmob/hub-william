import { useState, type ChangeEvent } from "react";
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
} from "lucide-react";
import { tv } from "tailwind-variants";

import Flex from "@/components/ui/flex";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import voskService, {
  type VoskModel,
  type VoskProgress,
} from "@/services/vosk";
import { copyText } from "@/utils/utils.clipboard";
import { downloadText } from "@/utils/utils.download";

import ToolsCatalogVoskMicrophone from "./tools-catalog-vosk-microphone";

const voskStyles = tv({
  slots: {
    container: "space-y-4 rounded-xl border border-zinc-200 bg-zinc-50/50 p-4",
    row: "grid grid-cols-1 gap-3 sm:grid-cols-2",
    fieldGroup: "space-y-1.5",
    label:
      "block font-mono text-[11px] font-semibold tracking-wider text-zinc-600 uppercase",
    select:
      "h-9 w-full rounded-lg border border-zinc-300 bg-white px-3 text-xs text-zinc-800 transition-colors focus:border-zinc-500 focus:outline-hidden",
    inputTabs: "h-9! w-full rounded-lg border border-zinc-300 bg-white p-0.75",
    inputTab:
      "gap-1.5 font-mono text-[11px] font-semibold tracking-wider uppercase data-active:bg-zinc-900 data-active:text-white data-active:shadow-none",
    fileInput:
      "h-9 w-full cursor-pointer rounded-lg border border-zinc-300 bg-white text-xs text-zinc-800 file:mr-3 file:h-full file:cursor-pointer file:border-0 file:bg-zinc-100 file:px-3 file:text-xs file:font-medium file:text-zinc-700 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden",
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

type InputMode = "voice" | "import";

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
  const [mode, setMode] = useState<InputMode>("voice");
  const [imported, setImported] = useState<File | null>(null);
  const [recorded, setRecorded] = useState<File | null>(null);
  const [progress, setProgress] = useState<VoskProgress | null>(null);
  const [copied, setCopied] = useState(false);

  const model =
    voskService.models.find((candidate) => candidate.id === modelId) ??
    voskService.models[0];
  const source = mode === "voice" ? recorded : imported;

  const transcription = useMutation({
    mutationFn: (audio: File) =>
      voskService.transcribe({ file: audio, model, onProgress: setProgress }),
  });

  const transcript = transcription.isPending
    ? (progress?.text ?? "")
    : (transcription.data ?? "");
  const hasResult = transcription.isPending
    ? transcript !== ""
    : transcription.isSuccess;

  function handleModeChange(next: string) {
    setMode(next as InputMode);
    transcription.reset();
  }

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    setImported(event.target.files?.[0] ?? null);
    transcription.reset();
  }

  function handleRecording(file: File | null) {
    setRecorded(file);
    transcription.reset();
  }

  function handleTranscribe() {
    if (!source) return;

    setProgress(null);
    setCopied(false);
    transcription.mutate(source);
  }

  async function handleCopy() {
    setCopied(await copyText(transcript));
  }

  return (
    <div className={styles.container()}>
      <Tabs value={mode} onValueChange={handleModeChange} className="gap-4">
        <div className={styles.row()}>
          <div className={styles.fieldGroup()}>
            <label htmlFor="vosk-model" className={styles.label()}>
              Language
            </label>

            <select
              id="vosk-model"
              value={modelId}
              disabled={transcription.isPending}
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

            <TabsList aria-label="Input" className={styles.inputTabs()}>
              <TabsTrigger
                value="voice"
                disabled={transcription.isPending}
                className={styles.inputTab()}
              >
                <Mic aria-hidden="true" />
                Voice
              </TabsTrigger>

              <TabsTrigger
                value="import"
                disabled={transcription.isPending}
                className={styles.inputTab()}
              >
                <FileAudio aria-hidden="true" />
                Import
              </TabsTrigger>
            </TabsList>
          </div>
        </div>

        <TabsContent value="voice" className="space-y-2">
          <ToolsCatalogVoskMicrophone
            recording={recorded}
            disabled={transcription.isPending}
            onRecording={handleRecording}
          />
        </TabsContent>

        <TabsContent value="import" className="space-y-2">
          <label htmlFor="vosk-file" className="sr-only">
            Audio file
          </label>

          <input
            id="vosk-file"
            type="file"
            accept="audio/*"
            disabled={transcription.isPending}
            onChange={handleFileChange}
            className={styles.fileInput()}
          />

          <p className={styles.hint()}>Files up to 50 MB.</p>
        </TabsContent>
      </Tabs>

      <p className={styles.hint()}>
        Runs in your browser with Vosk. Your audio is never uploaded.
      </p>

      <Button
        type="button"
        onClick={handleTranscribe}
        disabled={transcription.isPending || !source}
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

            {transcript && !transcription.isPending && source && (
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
                    downloadText(transcriptFilename(source), transcript)
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
