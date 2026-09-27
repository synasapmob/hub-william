import { env, InferenceSession, Tensor } from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import type {
  PlaygroundLocalVadRequest,
  PlaygroundLocalVadResponse,
} from "./playground-local-vad-protocol";

interface PlaygroundLocalVadWorker {
  onmessage: ((event: MessageEvent<PlaygroundLocalVadRequest>) => void) | null;
  postMessage: (
    message: PlaygroundLocalVadResponse,
    transfer?: Transferable[],
  ) => void;
}

const scope = self as unknown as PlaygroundLocalVadWorker;
const modelUrl =
  "https://huggingface.co/onnx-community/silero-vad/resolve/e71cae966052b992a7eca6b17738916ce0eca4ec/onnx/model.onnx";
env.wasm.numThreads = 1;
env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
let session: InferenceSession | undefined;
let state: Tensor = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
const sampleRate = new Tensor("int64", BigInt64Array.of(16000n), []);
let context = new Float32Array(64);
let remainder = new Float32Array(0);
let epoch = 0;
let stateEpoch = 0;
let busy = false;
let failed = false;
let queue: PlaygroundLocalVadRequest[] = [];

async function load() {
  let cache: Cache | undefined;
  try {
    cache = await caches.open("hub-speech-models-v1");
  } catch {
    /* Storage may be unavailable. */
  }
  const cached = await cache?.match(modelUrl).catch(() => undefined);
  const response = cached ?? (await fetch(modelUrl, { credentials: "omit" }));
  if (!response.ok) throw new Error("Model download failed");
  if (!cached)
    void cache?.put(modelUrl, response.clone()).catch(() => undefined);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > 8 * 1024 * 1024) throw new Error("Invalid VAD model");
  session = await InferenceSession.create(bytes, {
    executionProviders: ["wasm"],
  });
  scope.postMessage({ type: "ready", epoch });
}

async function classify(audio: Float32Array) {
  const samples = new Float32Array(remainder.length + audio.length);
  samples.set(remainder);
  samples.set(audio, remainder.length);
  let probability = 0;
  let offset = 0;
  for (; offset + 512 <= samples.length; offset += 512) {
    const frame = samples.subarray(offset, offset + 512);
    const inputSamples = new Float32Array(576);
    inputSamples.set(context);
    inputSamples.set(frame, 64);
    const input = new Tensor("float32", inputSamples, [1, 576]);
    const output = await session!.run({ input, state, sr: sampleRate });
    input.dispose();
    state.dispose();
    state = output.stateN;
    probability = Math.max(probability, Number(output.output.data[0]));
    output.output.dispose();
    context = frame.slice(-64);
  }
  remainder = samples.slice(offset);
  return probability;
}

async function processNext() {
  if (busy || !session || failed) return;
  busy = true;
  try {
    while (queue.length) {
      const request = queue.shift()!;
      if (request.epoch !== epoch) continue;
      if (stateEpoch !== epoch) {
        state.dispose();
        state = new Tensor("float32", new Float32Array(256), [2, 1, 128]);
        context = new Float32Array(64);
        remainder = new Float32Array(0);
        stateEpoch = epoch;
      }
      const audio = request.audio;
      if (!audio || audio.length !== 1600)
        throw new Error("Invalid microphone frame");
      const probability = await classify(audio);
      scope.postMessage(
        { type: "frame", epoch: request.epoch, audio, probability },
        [audio.buffer],
      );
    }
  } catch {
    failed = true;
    queue = [];
    scope.postMessage({ type: "error", epoch });
  } finally {
    busy = false;
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === "load")
    void load().catch(() => scope.postMessage({ type: "error", epoch }));
  if (data.type === "reset") {
    epoch = data.epoch;
    queue = [];
  }
  if (data.type === "frame") {
    queue.push(data);
    void processNext();
  }
};
