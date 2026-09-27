import type {
  PlaygroundLocalSttRequest,
  PlaygroundLocalSttResponse,
} from "./playground-local-stt-protocol";

export interface PlaygroundLocalSttTranscribeOptions {
  signal: AbortSignal;
  onText: (text: string) => void;
}

export interface PlaygroundLocalStt {
  transcribe: (
    audio: Float32Array,
    options: PlaygroundLocalSttTranscribeOptions,
  ) => Promise<string>;
  dispose: () => void;
}

interface PlaygroundLocalSttStartOptions {
  signal: AbortSignal;
  onLoading?: (message: string | null) => void;
}

interface PlaygroundLocalSttPending {
  complete: (text: string) => void;
  fail: (error: Error) => void;
  onText?: (text: string) => void;
}

async function start({
  signal,
  onLoading,
}: PlaygroundLocalSttStartOptions): Promise<PlaygroundLocalStt> {
  signal.throwIfAborted();
  if (typeof Worker === "undefined")
    throw new Error(
      "Your browser cannot run speech recognition. Use a browser supporting Web Workers.",
    );
  const worker = new Worker(
    new URL("./playground-local-stt.worker.ts", import.meta.url),
    { type: "module" },
  );
  const pending = new Map<number, PlaygroundLocalSttPending>();
  let nextId = 0;
  let closed = false;
  const aborted = () =>
    new DOMException("Speech recognition canceled", "AbortError");
  function dispose(error: Error = aborted()) {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", end);
    worker.terminate();
    for (const task of pending.values()) task.fail(error);
    pending.clear();
  }
  const end = () => dispose();
  signal.addEventListener("abort", end, { once: true });
  worker.onerror = () =>
    dispose(
      new Error("Speech recognition could not start. Reload and try again."),
    );
  worker.onmessage = ({ data }: MessageEvent<PlaygroundLocalSttResponse>) => {
    const task = pending.get(data.id);
    if (!task || closed) return;
    if (data.type === "progress")
      onLoading?.(data.text ?? "Loading speech recognition…");
    if (data.type === "partial") task.onText?.(data.text ?? "");
    if (data.type === "ready" || data.type === "complete")
      task.complete(data.text ?? "");
    if (data.type === "error")
      task.fail(new Error(data.text ?? "Speech recognition failed."));
  };

  function request(
    type: "load" | "transcribe",
    audio: Float32Array | undefined,
    options: PlaygroundLocalSttTranscribeOptions,
  ) {
    options.signal.throwIfAborted();
    if (closed) return Promise.reject(aborted());
    const id = ++nextId;
    return new Promise<string>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal.removeEventListener("abort", cancel);
        pending.delete(id);
      };
      const cancel = () => {
        worker.postMessage({
          type: "cancel",
          id,
        } satisfies PlaygroundLocalSttRequest);
        cleanup();
        reject(aborted());
      };
      const timer = setTimeout(
        () => {
          dispose(
            new Error(
              type === "load"
                ? "Speech recognition download timed out. Check your connection and retry."
                : "Speech recognition took too long on this device. Start a new call to retry.",
            ),
          );
        },
        type === "load" ? 180000 : 60000,
      );
      pending.set(id, {
        complete: (text) => {
          cleanup();
          resolve(text);
        },
        fail: (error) => {
          cleanup();
          reject(error);
        },
        onText: options.onText,
      });
      options.signal.addEventListener("abort", cancel, { once: true });
      // Transfer only the owned snapshot, never the live microphone buffer.
      worker.postMessage(
        { type, id, audio } satisfies PlaygroundLocalSttRequest,
        audio ? [audio.buffer] : [],
      );
    });
  }

  onLoading?.("Loading speech recognition…");
  try {
    await request("load", undefined, { signal, onText: () => {} });
    signal.throwIfAborted();
    onLoading?.(null);
    return {
      transcribe: (audio, options) => request("transcribe", audio, options),
      dispose: () => dispose(),
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

const playgroundLocalSttService = { start };
export default playgroundLocalSttService;
