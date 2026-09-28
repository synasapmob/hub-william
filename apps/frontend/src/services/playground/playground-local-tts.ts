import {
  PLAYGROUND_LOCAL_TTS_SAMPLE_RATE,
  type PlaygroundLocalTtsRequest,
  type PlaygroundLocalTtsResponse,
} from "./playground-local-tts-protocol";

export interface PlaygroundSpeechAudio {
  samples: Float32Array;
  sampleRate: number;
}
export interface PlaygroundLocalTts {
  synthesize: (
    text: string,
    signal: AbortSignal,
  ) => Promise<PlaygroundSpeechAudio>;
  dispose: () => void;
}
interface PlaygroundLocalTtsStartOptions {
  signal: AbortSignal;
  onLoading?: (text: string | null) => void;
}
interface PlaygroundLocalTtsPending {
  resolve: (audio: PlaygroundSpeechAudio) => void;
  reject: (error: Error) => void;
}

async function start(
  options: PlaygroundLocalTtsStartOptions,
): Promise<PlaygroundLocalTts> {
  options.signal.throwIfAborted();
  const worker = new Worker(
    new URL("./playground-local-tts.worker.ts", import.meta.url),
    { type: "module" },
  );
  const pending = new Map<number, PlaygroundLocalTtsPending>();
  let nextId = 0;
  let closed = false;
  const canceled = () =>
    new DOMException("Speech synthesis canceled", "AbortError");
  function dispose(error: Error = canceled()) {
    if (closed) return;
    closed = true;
    worker.terminate();
    options.signal.removeEventListener("abort", end);
    for (const task of pending.values()) task.reject(error);
    pending.clear();
  }
  const end = () => dispose();
  options.signal.addEventListener("abort", end, { once: true });
  worker.onerror = () =>
    dispose(
      new Error("Local speech synthesis failed. Start a new call to retry."),
    );
  worker.onmessage = ({ data }: MessageEvent<PlaygroundLocalTtsResponse>) => {
    const task = pending.get(data.id);
    if (!task || closed) return;
    if (data.type === "error")
      task.reject(
        new Error("Local speech synthesis failed. Start a new call to retry."),
      );
    else if (data.type === "ready")
      task.resolve({
        samples: new Float32Array(),
        sampleRate: PLAYGROUND_LOCAL_TTS_SAMPLE_RATE,
      });
    else if (
      data.samples?.length &&
      data.samples.length <= PLAYGROUND_LOCAL_TTS_SAMPLE_RATE * 60 &&
      data.sampleRate === PLAYGROUND_LOCAL_TTS_SAMPLE_RATE &&
      data.samples.every(Number.isFinite)
    )
      task.resolve({ samples: data.samples, sampleRate: data.sampleRate });
    else
      task.reject(new Error("Local speech synthesis returned invalid audio."));
  };
  function request(
    type: "load" | "synthesize",
    signal: AbortSignal,
    text?: string,
  ) {
    signal.throwIfAborted();
    if (closed) return Promise.reject(canceled());
    const id = ++nextId;
    return new Promise<PlaygroundSpeechAudio>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        pending.delete(id);
      };
      const cancel = () => {
        worker.postMessage({
          id,
          type: "cancel",
        } satisfies PlaygroundLocalTtsRequest);
        cleanup();
        reject(canceled());
      };
      const timer = setTimeout(
        () =>
          dispose(
            new Error(
              "Local speech synthesis timed out. Check your connection or try a faster device.",
            ),
          ),
        type === "load" ? 180000 : 60000,
      );
      pending.set(id, {
        resolve: (audio) => {
          cleanup();
          resolve(audio);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal.addEventListener("abort", cancel, { once: true });
      worker.postMessage({
        id,
        type,
        text,
      } satisfies PlaygroundLocalTtsRequest);
    });
  }
  options.onLoading?.("Loading local voice…");
  try {
    await request("load", options.signal);
    options.signal.throwIfAborted();
    options.onLoading?.(null);
    return {
      synthesize: async (text, signal) => {
        signal.throwIfAborted();
        if (!text.trim() || text.length > 240)
          throw new Error("Invalid local speech segment.");
        return request("synthesize", signal, text);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export default { start };
