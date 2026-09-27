import type {
  PlaygroundLocalVadRequest,
  PlaygroundLocalVadResponse,
} from "./playground-local-vad-protocol";

export interface PlaygroundLocalVad {
  push: (audio: Float32Array) => void;
  reset: () => void;
  dispose: () => void;
}

export interface PlaygroundLocalVadStartOptions {
  signal: AbortSignal;
  onFrame: (audio: Float32Array, probability: number) => void;
  onError: (error: Error) => void;
  onLoading?: (text: string | null) => void;
}

async function start(
  options: PlaygroundLocalVadStartOptions,
): Promise<PlaygroundLocalVad> {
  options.signal.throwIfAborted();
  const worker = new Worker(
    new URL("./playground-local-vad.worker.ts", import.meta.url),
    { type: "module" },
  );
  let closed = false;
  let epoch = 0;
  let queued = 0;
  let ready = false;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const loaded = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  function dispose() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    options.signal.removeEventListener("abort", dispose);
    worker.terminate();
    reject(new DOMException("Voice detection canceled", "AbortError"));
  }
  function fail(error: Error) {
    if (closed) return;
    reject(error);
    dispose();
    if (ready) options.onError(error);
  }
  const timer = setTimeout(
    () =>
      fail(
        new Error(
          "Voice detection could not load. Check your connection and start a new call.",
        ),
      ),
    60000,
  );
  options.signal.addEventListener("abort", dispose, { once: true });
  worker.onerror = () =>
    fail(new Error("Voice detection failed. Start a new call to retry."));
  worker.onmessage = ({ data }: MessageEvent<PlaygroundLocalVadResponse>) => {
    if (closed || data.epoch !== epoch) return;
    if (data.type === "error")
      return fail(
        new Error("Voice detection failed. Start a new call to retry."),
      );
    if (data.type === "ready") {
      ready = true;
      clearTimeout(timer);
      resolve();
    }
    if (data.type === "frame") {
      queued -= 1;
      if (
        !data.audio ||
        !Number.isFinite(data.probability) ||
        data.probability! < 0 ||
        data.probability! > 1
      )
        return fail(new Error("Voice detection returned an invalid result."));
      options.onFrame(data.audio, data.probability!);
    }
  };
  options.onLoading?.("Loading voice detection…");
  worker.postMessage({
    type: "load",
    epoch,
  } satisfies PlaygroundLocalVadRequest);
  try {
    await loaded;
    options.signal.throwIfAborted();
    options.onLoading?.(null);
    return {
      push(audio) {
        if (closed) return;
        // Do not let a slow device accumulate stale microphone turns indefinitely.
        if (queued >= 20)
          return fail(
            new Error(
              "Voice detection cannot keep up on this device. Start a new call to retry.",
            ),
          );
        queued += 1;
        worker.postMessage(
          { type: "frame", epoch, audio } satisfies PlaygroundLocalVadRequest,
          [audio.buffer],
        );
      },
      reset() {
        if (closed) return;
        epoch += 1;
        queued = 0;
        worker.postMessage({
          type: "reset",
          epoch,
        } satisfies PlaygroundLocalVadRequest);
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

export default { start };
