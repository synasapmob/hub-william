import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaygroundLocalTtsRequest } from "./playground-local-tts-protocol";

const runtime = vi.hoisted(() => ({
  asset: vi.fn(),
  phonemize: vi.fn(),
  create: vi.fn(),
  run: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./playground-local-tts-assets", () => ({
  default: { load: runtime.asset },
}));
vi.mock("./playground-local-tts-phonemizer", () => ({
  default: { load: async () => runtime.phonemize },
}));
vi.mock("onnxruntime-web/wasm", () => ({
  env: { wasm: {} },
  InferenceSession: { create: runtime.create },
  Tensor: class {
    type: string;
    data: Float32Array | BigInt64Array;
    dims: number[];
    constructor(
      type: string,
      data: Float32Array | BigInt64Array,
      dims: number[],
    ) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
    dispose() {}
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  runtime.asset.mockResolvedValue(new ArrayBuffer(1));
  runtime.phonemize.mockResolvedValue([1, 2, 3]);
  runtime.create.mockResolvedValue({
    run: runtime.run,
    release: runtime.release,
  });
  runtime.release.mockResolvedValue(undefined);
  runtime.run.mockResolvedValue({
    output: { data: Float32Array.of(0.1, 0.2), dispose: vi.fn() },
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("English-only Piper worker", () => {
  it("keeps the same English model and published scales for every segment", async () => {
    const scope = {
      onmessage: null as
        ((event: MessageEvent<PlaygroundLocalTtsRequest>) => void) | null,
      postMessage: vi.fn(),
    };
    vi.stubGlobal("self", scope);
    await import("./playground-local-tts.worker");
    const send = (data: PlaygroundLocalTtsRequest) =>
      scope.onmessage!(new MessageEvent("message", { data }));
    send({ id: 1, type: "load" });
    await vi.waitFor(() =>
      expect(scope.postMessage).toHaveBeenCalledWith({ id: 1, type: "ready" }),
    );
    expect(runtime.asset).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://huggingface.co/diffusionstudio/piper-voices/resolve/840e38a7e26d813bd6221b78cfbaefa3585b3f71/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx",
        bytes: 63531379,
        sha256:
          "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
      }),
    );
    for (const [id, text] of [
      [2, "Hello world."],
      [3, "Xin chào."],
    ] as const) {
      send({ id, type: "synthesize", text });
      await vi.waitFor(() =>
        expect(scope.postMessage).toHaveBeenCalledWith(
          expect.objectContaining({ id, type: "audio", sampleRate: 22050 }),
          expect.any(Array),
        ),
      );
      expect(runtime.phonemize).toHaveBeenLastCalledWith(text);
      const inputs = runtime.run.mock.lastCall![0];
      expect(inputs.input.data).toEqual(BigInt64Array.of(1n, 2n, 3n));
      expect(Array.from(inputs.scales.data)).toEqual(
        Array.from(Float32Array.of(0.667, 1, 0.333)),
      );
    }
    expect(runtime.asset).toHaveBeenCalledOnce();
    expect(runtime.create).toHaveBeenCalledOnce();
    expect(runtime.create).toHaveBeenCalledWith(expect.any(ArrayBuffer), {
      executionProviders: ["wasm"],
    });
    expect(runtime.release).not.toHaveBeenCalled();
  });
});
