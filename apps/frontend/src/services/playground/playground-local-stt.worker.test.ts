import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaygroundLocalSttRequest } from "./playground-local-stt-protocol";

const runtime = vi.hoisted(() => ({
  pipeline: vi.fn(),
  recognize: Object.assign(vi.fn(), {
    tokenizer: {},
    processor: vi.fn(),
    model: { generate: vi.fn() },
    dispose: vi.fn(),
  }),
}));
interface TestTextStreamerOptions {
  callback_function: (text: string) => void;
}
vi.mock("@huggingface/transformers", () => ({
  env: { backends: { onnx: { wasm: {} } } },
  pipeline: runtime.pipeline,
  TextStreamer: class {
    callback: (text: string) => void;
    constructor(_tokenizer: unknown, options: TestTextStreamerOptions) {
      this.callback = options.callback_function;
    }
  },
  InterruptableStoppingCriteria: class {
    interrupted = false;
    reset() {
      this.interrupted = false;
    }
    interrupt() {
      this.interrupted = true;
    }
  },
  StoppingCriteriaList: class {
    push = vi.fn();
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.pipeline.mockResolvedValue(runtime.recognize);
  runtime.recognize.mockImplementation(async (_audio, options) => {
    options.streamer?.callback("Hello world.");
    return { text: "Hello world." };
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("English-only Whisper worker", () => {
  it.each(["wasm", "webgpu"])(
    "uses en for every %s transcription without probing language tokens",
    async (device) => {
      vi.stubGlobal("navigator", device === "webgpu" ? { gpu: {} } : {});
      const scope = {
        onmessage: null as
          ((event: MessageEvent<PlaygroundLocalSttRequest>) => void) | null,
        postMessage: vi.fn(),
      };
      vi.stubGlobal("self", scope);
      await import("./playground-local-stt.worker");
      const send = (data: PlaygroundLocalSttRequest) =>
        scope.onmessage!(new MessageEvent("message", { data }));
      send({ id: 1, type: "load" });
      await vi.waitFor(() =>
        expect(scope.postMessage).toHaveBeenCalledWith({
          id: 1,
          type: "ready",
        }),
      );
      for (const id of [2, 3]) {
        const audio = new Float32Array(16000);
        send({ id, type: "transcribe", audio });
        await vi.waitFor(() =>
          expect(scope.postMessage).toHaveBeenCalledWith({
            id,
            type: "complete",
            text: "Hello world.",
          }),
        );
        expect(runtime.recognize).toHaveBeenLastCalledWith(
          audio,
          expect.objectContaining({ language: "en", task: "transcribe" }),
        );
        expect(scope.postMessage).toHaveBeenCalledWith({
          id,
          type: "partial",
          text: "Hello world.",
        });
      }
      expect(
        runtime.recognize.mock.calls.every(
          ([, options]) => options.language === "en",
        ),
      ).toBe(true);
      expect(runtime.recognize.processor).not.toHaveBeenCalled();
      expect(runtime.recognize.model.generate).not.toHaveBeenCalled();
      expect(runtime.pipeline).toHaveBeenCalledWith(
        "automatic-speech-recognition",
        "onnx-community/whisper-base",
        expect.objectContaining({
          device,
          revision: "1846881b6b3a3024392c1eea3ad983695bc23925",
        }),
      );
    },
  );
});
