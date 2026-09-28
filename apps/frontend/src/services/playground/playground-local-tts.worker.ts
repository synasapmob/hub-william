import { env, InferenceSession, Tensor } from "onnxruntime-web/wasm";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import wasmModuleUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import playgroundLocalTtsAssets from "./playground-local-tts-assets";
import playgroundLocalTtsPhonemizer from "./playground-local-tts-phonemizer";
import {
  PLAYGROUND_LOCAL_TTS_SAMPLE_RATE,
  type PlaygroundLocalTtsRequest,
  type PlaygroundLocalTtsResponse,
} from "./playground-local-tts-protocol";

interface PlaygroundLocalTtsWorker {
  onmessage: ((event: MessageEvent<PlaygroundLocalTtsRequest>) => void) | null;
  postMessage: (
    message: PlaygroundLocalTtsResponse,
    transfer?: Transferable[],
  ) => void;
}
const scope = self as unknown as PlaygroundLocalTtsWorker;
// Piper en_US-ljspeech-medium: pinned model and its published inference config.
const modelUrl =
  "https://huggingface.co/diffusionstudio/piper-voices/resolve/840e38a7e26d813bd6221b78cfbaefa3585b3f71/en/en_US/ljspeech/medium/en_US-ljspeech-medium.onnx";
env.wasm.numThreads = 1;
env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmModuleUrl };
let session: InferenceSession;
let phonemize: Awaited<ReturnType<typeof playgroundLocalTtsPhonemizer.load>>;
let active: number | null = null;
let canceled = false;
let pending: PlaygroundLocalTtsRequest | null = null;

async function load(id: number) {
  try {
    const [bytes, processor] = await Promise.all([
      playgroundLocalTtsAssets.load({
        url: modelUrl,
        bytes: 63531379,
        sha256:
          "6f52a751e2349abe7a76735eb09dc1875298c77ea2342ffd2fef79ff81b87f22",
      }),
      playgroundLocalTtsPhonemizer.load(),
    ]);
    phonemize = processor;
    [session] = await Promise.all([
      InferenceSession.create(bytes, { executionProviders: ["wasm"] }),
      // Validate the phonemizer during page preparation, without playing audio.
      phonemize("Hello"),
    ]);
    scope.postMessage({ id, type: "ready" });
  } catch {
    scope.postMessage({ id, type: "error" });
  }
}

async function processNext() {
  if (active !== null || !pending) return;
  const request = pending;
  pending = null;
  active = request.id;
  canceled = false;
  const tensors: Tensor[] = [];
  try {
    if (!session || !request.text?.trim() || request.text.length > 240)
      throw new Error("Invalid local speech segment.");
    const ids = await phonemize(request.text);
    if (canceled) return;
    const input = new Tensor("int64", BigInt64Array.from(ids, BigInt), [
      1,
      ids.length,
    ]);
    const lengths = new Tensor(
      "int64",
      BigInt64Array.of(BigInt(ids.length)),
      [1],
    );
    const scales = new Tensor("float32", Float32Array.of(0.667, 1, 0.333), [3]);
    tensors.push(input, lengths, scales);
    const output = await session.run({
      input,
      input_lengths: lengths,
      scales,
    });
    tensors.push(...Object.values(output));
    if (canceled) return;
    const samples = Float32Array.from(output.output.data as Float32Array);
    scope.postMessage(
      {
        id: request.id,
        type: "audio",
        samples,
        sampleRate: PLAYGROUND_LOCAL_TTS_SAMPLE_RATE,
      },
      [samples.buffer],
    );
  } catch {
    if (!canceled) scope.postMessage({ id: request.id, type: "error" });
  } finally {
    for (const tensor of tensors) tensor.dispose();
    active = null;
    void processNext();
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === "load") void load(data.id);
  else if (data.type === "cancel") {
    if (active === data.id) canceled = true;
    if (pending?.id === data.id) pending = null;
  } else {
    pending = data;
    void processNext();
  }
};
