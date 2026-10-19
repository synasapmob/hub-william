import type { Model } from "vosk-browser";

import {
  decodeAudioFile,
  splitIntoChunks,
  VOSK_MAX_FILE_BYTES,
  VOSK_SAMPLE_RATE,
} from "./vosk-audio";
import { VOSK_MODELS, type VoskModel } from "./vosk-models";

export type { VoskModel } from "./vosk-models";

export type VoskPhase = "model" | "decoding" | "recognizing";

export interface VoskProgress {
  phase: VoskPhase;
  /** 0–1 while recognizing; undefined when the phase has no measurable end. */
  fraction?: number;
  /** Transcript so far, including the sentence still being spoken. */
  text: string;
}

export interface VoskTranscribeOptions {
  file: File;
  model: VoskModel;
  onProgress?: (progress: VoskProgress) => void;
}

interface LoadedModel {
  id: string;
  promise: Promise<Model>;
}

// One model at a time: each keeps a worker and its WASM heap alive.
let loaded: LoadedModel | null = null;

function loadRuntime(model: VoskModel): Promise<Model> {
  if (loaded?.id === model.id) return loaded.promise;

  void loaded?.promise.then((previous) => previous.terminate()).catch(() => {});

  // vosk-browser inlines a 5 MB WASM worker, so keep it out of the main chunk.
  const promise = import("vosk-browser").then(
    ({ Model: VoskRuntimeModel }) =>
      new Promise<Model>((resolve, reject) => {
        const runtime = new VoskRuntimeModel(model.url);

        // createModel() never rejects, so a failed download would hang forever.
        runtime.on("load", (message) => {
          if (message.event === "load" && message.result) resolve(runtime);
          else reject(new Error(`Could not load the ${model.label} model.`));
        });
        runtime.on("error", (message) => {
          runtime.terminate();
          reject(
            new Error(
              message.event === "error"
                ? message.error
                : `Could not load the ${model.label} model.`,
            ),
          );
        });
      }),
  );

  const entry = { id: model.id, promise };
  loaded = entry;
  // A failed load must not be cached, or retrying would replay the failure.
  promise.catch(() => {
    if (loaded === entry) loaded = null;
  });

  return promise;
}

function recognize(
  runtime: Model,
  samples: Float32Array,
  onProgress: (progress: VoskProgress) => void,
): Promise<string> {
  const chunks = splitIntoChunks(samples);
  // The worker answers every chunk, then the final-result request, in order.
  const expectedMessages = chunks.length + 1;
  const recognizer = new runtime.KaldiRecognizer(VOSK_SAMPLE_RATE);

  return new Promise<string>((resolve, reject) => {
    const sentences: string[] = [];
    let received = 0;

    function report(partial: string) {
      onProgress({
        phase: "recognizing",
        fraction: Math.min(received / expectedMessages, 1),
        text: [...sentences, partial].filter(Boolean).join(" "),
      });
    }

    recognizer.on("result", (message) => {
      if (message.event !== "result") return;

      received += 1;
      if (message.result.text) sentences.push(message.result.text);
      report("");

      if (received === expectedMessages) {
        recognizer.remove();
        resolve(sentences.join(" "));
      }
    });
    recognizer.on("partialresult", (message) => {
      if (message.event !== "partialresult") return;

      received += 1;
      report(message.result.partial);
    });
    recognizer.on("error", (message) => {
      if (message.event !== "error") return;

      recognizer.remove();
      reject(new Error(message.error));
    });

    for (const chunk of chunks)
      recognizer.acceptWaveformFloat(chunk, VOSK_SAMPLE_RATE);
    recognizer.retrieveFinalResult();
  });
}

/** Transcribe an audio file entirely in the browser; nothing is uploaded. */
async function transcribe({
  file,
  model,
  onProgress = () => {},
}: VoskTranscribeOptions): Promise<string> {
  if (file.size > VOSK_MAX_FILE_BYTES) {
    throw new Error("Audio files up to 50 MB are supported.");
  }

  onProgress({ phase: "model", text: "" });
  const runtime = await loadRuntime(model);

  onProgress({ phase: "decoding", text: "" });
  const samples = await decodeAudioFile(file).catch(() => {
    throw new Error("This file could not be decoded as audio.");
  });

  return recognize(runtime, samples, onProgress);
}

const voskService = { models: VOSK_MODELS, transcribe };

export default voskService;
