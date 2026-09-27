export interface PlaygroundLocalVadRequest {
  type: "load" | "frame" | "reset";
  epoch: number;
  audio?: Float32Array;
}

export interface PlaygroundLocalVadResponse {
  type: "ready" | "frame" | "error";
  epoch: number;
  audio?: Float32Array;
  probability?: number;
}
