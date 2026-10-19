import type { Model } from "vosk-browser";

import {
  decodeAudioFile,
  splitIntoChunks,
  VOSK_MAX_FILE_BYTES,
  VOSK_SAMPLE_RATE,
} from "./vosk-audio";
import { VOSK_MODELS } from "./vosk-models";
import { startRecording } from "./vosk-recorder";
import type {
  VoskModel,
  VoskProgress,
  VoskRecording,
  VoskTranscribeOptions,
} from "./vosk-types";

export { VOSK_MAX_RECORDING_SECONDS } from "./vosk-recorder";

interface LoadedModel {
  id: string;
  promise: Promise<Model>;
}

class VoskService {
  readonly models = VOSK_MODELS;

  // One model at a time: each keeps a worker and its WASM heap alive.
  private loaded: LoadedModel | null = null;

  private loadRuntime(model: VoskModel): Promise<Model> {
    if (this.loaded?.id === model.id) return this.loaded.promise;

    void this.loaded?.promise
      .then((previous) => previous.terminate())
      .catch(() => {});

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
    this.loaded = entry;
    // A failed load must not be cached, or retrying would replay the failure.
    promise.catch(() => {
      if (this.loaded === entry) this.loaded = null;
    });

    return promise;
  }

  private recognize(
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

  /**
   * Transcribe an audio file entirely in the browser; nothing is uploaded
   */
  async transcribe({
    file,
    model,
    onProgress = () => {},
  }: VoskTranscribeOptions): Promise<string> {
    if (file.size > VOSK_MAX_FILE_BYTES) {
      throw new Error("Audio files up to 50 MB are supported.");
    }

    onProgress({ phase: "model", text: "" });
    const runtime = await this.loadRuntime(model);

    onProgress({ phase: "decoding", text: "" });
    const samples = await decodeAudioFile(file).catch(() => {
      throw new Error("This file could not be decoded as audio.");
    });

    return this.recognize(runtime, samples, onProgress);
  }

  /**
   * Record the microphone for transcription
   */
  record(): Promise<VoskRecording> {
    return startRecording();
  }
}

export const voskService = new VoskService();
