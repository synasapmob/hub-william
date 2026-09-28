import {
  env,
  pipeline,
  TextStreamer,
  InterruptableStoppingCriteria,
  StoppingCriteriaList,
  type AutomaticSpeechRecognitionPipeline,
} from "@huggingface/transformers";
import type {
  PlaygroundLocalSttRequest,
  PlaygroundLocalSttResponse,
} from "./playground-local-stt-protocol";

interface PlaygroundLocalSttWorker {
  onmessage: ((event: MessageEvent<PlaygroundLocalSttRequest>) => void) | null;
  postMessage: (message: PlaygroundLocalSttResponse) => void;
}

const scope = self as unknown as PlaygroundLocalSttWorker;
const model = "onnx-community/whisper-base";
const revision = "1846881b6b3a3024392c1eea3ad983695bc23925";
env.allowLocalModels = false;
env.useBrowserCache = true;
// Works without cross-origin isolation, including the staging frontend proxy.
if (env.backends.onnx.wasm) env.backends.onnx.wasm.numThreads = 1;

let recognizer: AutomaticSpeechRecognitionPipeline | null = null;
let pending: PlaygroundLocalSttRequest | null = null;
let active: number | null = null;
const interrupted = new InterruptableStoppingCriteria();

async function load(id: number) {
  try {
    const progress_callback = () =>
      scope.postMessage({
        id,
        type: "progress",
        text: "Loading speech recognition…",
      });
    // Quantized CPU inference is the fallback when WebGPU is unavailable.
    if ("gpu" in navigator) {
      try {
        recognizer = await pipeline("automatic-speech-recognition", model, {
          revision,
          device: "webgpu",
          dtype: { encoder_model: "fp32", decoder_model_merged: "q4" },
          progress_callback,
        });
        await recognizer(new Float32Array(1600), {
          language: "en",
          max_new_tokens: 1,
        });
      } catch {
        await recognizer?.dispose();
        recognizer = null;
      }
    }
    if (!recognizer)
      recognizer = await pipeline("automatic-speech-recognition", model, {
        revision,
        device: "wasm",
        dtype: "q8",
        progress_callback,
      });
    scope.postMessage({ id, type: "ready" });
  } catch {
    scope.postMessage({
      id,
      type: "error",
      text: "Speech recognition could not load. Check your connection and start a new call.",
    });
  }
}

async function processNext() {
  if (active !== null || !pending || !recognizer) return;
  const request = pending;
  pending = null;
  active = request.id;
  interrupted.reset();
  try {
    const audio = request.audio;
    if (!audio || audio.length < 160 || audio.length > 320000)
      throw new Error("Invalid local audio.");
    const stopping = new StoppingCriteriaList();
    stopping.push(interrupted);
    let text = "";
    const streamer = new TextStreamer(recognizer.tokenizer, {
      skip_prompt: true,
      callback_function: (delta) => {
        text += delta;
        if (!interrupted.interrupted)
          scope.postMessage({
            id: request.id,
            type: "partial",
            text: text.trim(),
          });
      },
    });
    const result = await recognizer(audio, {
      task: "transcribe",
      language: "en",
      max_new_tokens: 256,
      return_timestamps: false,
      streamer,
      stopping_criteria: stopping,
    });
    if (!interrupted.interrupted)
      scope.postMessage({
        id: request.id,
        type: "complete",
        text: result.text.trim(),
      });
  } catch {
    if (!interrupted.interrupted)
      scope.postMessage({
        id: request.id,
        type: "error",
        text: "Speech recognition failed on this device. Start a new call to retry.",
      });
  } finally {
    active = null;
    void processNext();
  }
}

scope.onmessage = ({ data }) => {
  if (data.type === "load") void load(data.id);
  else if (data.type === "cancel") {
    if (active === data.id) interrupted.interrupt();
    if (pending?.id === data.id) pending = null;
  } else {
    // The owner serializes previews and cancels obsolete work before a final.
    pending = data;
    void processNext();
  }
};
