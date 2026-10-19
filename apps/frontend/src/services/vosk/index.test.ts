import { beforeEach, describe, expect, it, vi } from "vitest";

import type { VoskModel } from "./vosk-models";

type Listener = (message: unknown) => void;

class FakeRecognizer {
  listeners = new Map<string, Listener>();
  chunks = 0;
  removed = false;
  /** Replies the worker will send once the final result is requested. */
  script: (emit: (event: string, result: unknown) => void) => void = () => {};

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
  }

  emit = (event: string, payload: unknown) =>
    this.listeners.get(event)?.({ event, ...(payload as object) });

  acceptWaveformFloat() {
    this.chunks += 1;
  }

  retrieveFinalResult() {
    this.script(this.emit);
  }

  remove() {
    this.removed = true;
  }
}

const recognizers: FakeRecognizer[] = [];
const models: FakeModel[] = [];
let nextLoad: "ok" | "error" = "ok";

class FakeModel {
  listeners = new Map<string, Listener>();
  terminated = false;
  url: string;

  constructor(url: string) {
    this.url = url;
    models.push(this);
    queueMicrotask(() => {
      if (nextLoad === "ok")
        this.listeners.get("load")?.({ event: "load", result: true });
      else
        this.listeners.get("error")?.({
          event: "error",
          error: "download failed",
        });
    });
  }

  on(event: string, listener: Listener) {
    this.listeners.set(event, listener);
  }

  terminate() {
    this.terminated = true;
  }

  KaldiRecognizer = class extends FakeRecognizer {
    constructor() {
      super();
      recognizers.push(this);
    }
  };
}

vi.mock("vosk-browser", () => ({ Model: FakeModel }));

vi.mock("./vosk-audio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./vosk-audio")>()),
  // 5 seconds of audio becomes three two-second chunks.
  decodeAudioFile: vi.fn().mockResolvedValue(new Float32Array(16_000 * 5)),
}));

type VoskService = typeof import("./index").default;
let voskService: VoskService;

const english: VoskModel = {
  id: "en-us",
  label: "English (US)",
  url: "https://models.test/en.tar.gz",
  size: "41 MB",
};
const french: VoskModel = {
  id: "fr",
  label: "French",
  url: "https://models.test/fr.tar.gz",
  size: "46 MB",
};

function audio(name = "clip.wav") {
  return new File([new Uint8Array([1])], name);
}

describe("voskService.transcribe", () => {
  beforeEach(async () => {
    recognizers.length = 0;
    models.length = 0;
    nextLoad = "ok";
    // The service caches its loaded model at module scope; start each test cold.
    vi.resetModules();
    voskService = (await import("./index")).default;
  });

  it("finishes only after every chunk and the final result have replied", async () => {
    const onProgress = vi.fn();
    const pending = voskService.transcribe({
      file: audio(),
      model: english,
      onProgress,
    });

    await vi.waitFor(() => expect(recognizers).toHaveLength(1));
    const [recognizer] = recognizers;
    expect(recognizer.chunks).toBe(3);

    let settled = false;
    void pending.then(() => (settled = true));

    // Three chunk replies, then the reply to retrieveFinalResult.
    recognizer.emit("partialresult", { result: { partial: "hello" } });
    recognizer.emit("result", { result: { text: "hello world" } });
    recognizer.emit("partialresult", { result: { partial: "good" } });
    await Promise.resolve();
    expect(settled).toBe(false);

    recognizer.emit("result", { result: { text: "good bye" } });

    await expect(pending).resolves.toBe("hello world good bye");
    expect(recognizer.removed).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "model" }),
    );
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "decoding" }),
    );
    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "recognizing",
      fraction: 1,
      text: "hello world good bye",
    });
  });

  it("includes the sentence still being spoken in live progress", async () => {
    const onProgress = vi.fn();
    void voskService.transcribe({ file: audio(), model: english, onProgress });

    await vi.waitFor(() => expect(recognizers).toHaveLength(1));
    recognizers[0].emit("partialresult", { result: { partial: "hel" } });

    expect(onProgress).toHaveBeenLastCalledWith({
      phase: "recognizing",
      fraction: 0.25,
      text: "hel",
    });
  });

  it("returns an empty transcript for silence", async () => {
    const pending = voskService.transcribe({ file: audio(), model: english });

    await vi.waitFor(() => expect(recognizers).toHaveLength(1));
    for (let index = 0; index < 3; index += 1) {
      recognizers[0].emit("partialresult", { result: { partial: "" } });
    }
    recognizers[0].emit("result", { result: { text: "" } });

    await expect(pending).resolves.toBe("");
  });

  it("rejects when the recognizer reports an error", async () => {
    const pending = voskService.transcribe({ file: audio(), model: english });

    await vi.waitFor(() => expect(recognizers).toHaveLength(1));
    recognizers[0].emit("error", { error: "Recognizer not ready" });

    await expect(pending).rejects.toThrow("Recognizer not ready");
    expect(recognizers[0].removed).toBe(true);
  });

  it("rejects oversized files before loading a model", async () => {
    const big = audio();
    Object.defineProperty(big, "size", { value: 51 * 1024 * 1024 });

    await expect(
      voskService.transcribe({ file: big, model: english }),
    ).rejects.toThrow("50 MB");
    expect(models).toHaveLength(0);
  });
});

describe("voskService model loading", () => {
  beforeEach(async () => {
    recognizers.length = 0;
    models.length = 0;
    nextLoad = "ok";
    // The service caches its loaded model at module scope; start each test cold.
    vi.resetModules();
    voskService = (await import("./index")).default;
  });

  it("surfaces a failed download and retries instead of caching the failure", async () => {
    nextLoad = "error";
    await expect(
      voskService.transcribe({ file: audio(), model: french }),
    ).rejects.toThrow("download failed");
    expect(models[0].terminated).toBe(true);

    nextLoad = "ok";
    const retry = voskService.transcribe({ file: audio(), model: french });
    await vi.waitFor(() => expect(recognizers).toHaveLength(1));
    expect(models).toHaveLength(2);

    for (let index = 0; index < 3; index += 1)
      recognizers[0].emit("partialresult", { result: { partial: "" } });
    recognizers[0].emit("result", { result: { text: "bonjour" } });
    await expect(retry).resolves.toBe("bonjour");
  });

  it("reuses the loaded model and terminates it when another language is chosen", async () => {
    async function run(model: VoskModel) {
      recognizers.length = 0;
      const pending = voskService.transcribe({ file: audio(), model });
      await vi.waitFor(() => expect(recognizers).toHaveLength(1));
      for (let index = 0; index < 3; index += 1)
        recognizers[0].emit("partialresult", { result: { partial: "" } });
      recognizers[0].emit("result", { result: { text: "ok" } });
      await pending;
    }

    await run(english);
    await run(english);
    expect(models).toHaveLength(1);

    await run(french);
    expect(models).toHaveLength(2);
    await vi.waitFor(() => expect(models[0].terminated).toBe(true));
  });
});
