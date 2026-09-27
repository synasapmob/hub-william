export const PLAYGROUND_LOCAL_TTS_SAMPLE_RATE = 22050;

export interface PlaygroundLocalTtsRequest {
  id: number;
  type: "load" | "synthesize" | "cancel";
  text?: string;
}

export interface PlaygroundLocalTtsResponse {
  id: number;
  type: "ready" | "audio" | "error";
  samples?: Float32Array;
  sampleRate?: number;
}
