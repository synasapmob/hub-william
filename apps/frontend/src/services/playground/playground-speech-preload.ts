import playgroundLocalStt, {
  type PlaygroundLocalStt,
} from "./playground-local-stt";
import playgroundLocalVad, {
  type PlaygroundLocalVad,
  type PlaygroundLocalVadStartOptions,
} from "./playground-local-vad";
import playgroundLocalTts, {
  type PlaygroundLocalTts,
} from "./playground-local-tts";

interface PlaygroundSpeechResources {
  recognizer: PlaygroundLocalStt;
  detector: PlaygroundLocalVad;
  speech: PlaygroundLocalTts;
}
type PlaygroundSpeechTakeOptions = Pick<
  PlaygroundLocalVadStartOptions,
  "signal" | "onFrame" | "onError" | "onLoading"
>;
interface PlaygroundSpeechWarm {
  owners: number;
  controller: AbortController;
  promise: Promise<PlaygroundSpeechResources>;
  callbacks: Pick<PlaygroundLocalVadStartOptions, "onFrame" | "onError">;
}
let warm: PlaygroundSpeechWarm | null = null;

function prepare(): PlaygroundSpeechWarm {
  const controller = new AbortController();
  const callbacks: PlaygroundSpeechWarm["callbacks"] = {
    onFrame: () => {},
    onError: () => {},
  };
  const options = { signal: controller.signal };
  const promise = Promise.all([
    playgroundLocalStt.start(options),
    playgroundLocalVad.start({
      ...options,
      onFrame: (audio, probability) => callbacks.onFrame(audio, probability),
      onError: (error) => {
        callbacks.onError(error);
        controller.abort();
      },
    }),
    playgroundLocalTts.start(options),
  ])
    .then(([recognizer, detector, speech]) => ({
      recognizer,
      detector,
      speech,
    }))
    .catch((error: unknown) => {
      controller.abort();
      throw error;
    });
  // Background initialization has no caller awaiting it until Start call.
  void promise.catch(() => {});
  return { controller, callbacks, promise, owners: 0 };
}

function preload() {
  if (typeof Worker === "undefined") return () => {};
  if (!warm || warm.controller.signal.aborted) warm = prepare();
  const entry = warm;
  entry.owners += 1;
  return () => {
    entry.owners -= 1;
    // React StrictMode immediately replays effects. Reuse preparation across
    // that replay instead of starting and aborting two model downloads.
    queueMicrotask(() => {
      if (warm !== entry || entry.owners) return;
      warm = null;
      entry.controller.abort();
    });
  };
}

async function take(options: PlaygroundSpeechTakeOptions) {
  options.signal.throwIfAborted();
  const entry = warm && !warm.controller.signal.aborted ? warm : prepare();
  warm = null; // Ownership transfers to this call; page cleanup cannot kill it.
  entry.callbacks.onFrame = options.onFrame;
  entry.callbacks.onError = options.onError;
  const abort = () => entry.controller.abort();
  options.signal.addEventListener("abort", abort, { once: true });
  options.onLoading?.("Preparing local speech…");
  try {
    const resources = await entry.promise;
    options.signal.throwIfAborted();
    options.onLoading?.(null);
    return resources;
  } catch (error) {
    abort();
    options.signal.removeEventListener("abort", abort);
    throw error;
  }
}

export default { preload, take };
