import type { VoskModel } from "./vosk-models";

export type { VoskModel } from "./vosk-models";
export type { VoskRecording } from "./vosk-recorder";

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
