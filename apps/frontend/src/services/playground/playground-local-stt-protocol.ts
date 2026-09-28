export interface PlaygroundLocalSttRequest {
  id: number;
  type: "load" | "transcribe" | "cancel";
  audio?: Float32Array;
}

export interface PlaygroundLocalSttResponse {
  id: number;
  type: "ready" | "progress" | "partial" | "complete" | "error";
  text?: string;
}
